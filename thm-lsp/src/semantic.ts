/**
 * Scope-aware language intelligence built on the binder.
 *
 * Everything here works from resolved symbols rather than spelling, so
 * rename / references / highlights do not leak into unrelated scopes, and
 * cross-file operations follow real `import` / `from … import` edges.
 */

import * as fs from "fs";
import {
  PRELUDE_NAMES,
  type Binding,
  type Occurrence,
  type Scope,
  type Sym,
} from "./binder.js";
import {
  BUILTIN_MODULES,
  GLOBAL_FUNCTIONS,
  GLOBAL_TYPES,
  KEYWORD_HELP,
} from "./builtins-info.js";
import { KEYWORDS, isKeyword, type Token } from "./lexer.js";
import { checkTypes } from "./type-system.js";
import { LineIndex, type LspPosition, type LspRange } from "./positions.js";
import {
  pathToUri,
  uriToPath,
  type Workspace,
  type WorkspaceDocument,
} from "./workspace.js";

export class LspError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

export interface Location {
  uri: string;
  range: LspRange;
}

export interface Diagnostic {
  range: LspRange;
  severity: 1 | 2 | 3 | 4;
  message: string;
  source: string;
  code?: string;
  tags?: number[];
  data?: Record<string, unknown>;
}

export const SEMANTIC_TOKEN_TYPES = [
  "namespace",
  "class",
  "function",
  "method",
  "property",
  "variable",
  "parameter",
  "type",
  "decorator",
] as const;
export const SEMANTIC_TOKEN_MODIFIERS = [
  "declaration",
  "readonly",
  "defaultLibrary",
  "async",
] as const;

const SYMBOL_KIND = {
  Module: 2,
  Class: 5,
  Method: 6,
  Property: 7,
  Field: 8,
  Constructor: 9,
  Function: 12,
  Variable: 13,
  Constant: 14,
} as const;

/** One call expression `callee(args…)` analysed for arity and hints. */
interface CallSite {
  nameOcc: Occurrence;
  target: Sym;
  openOffset: number;
  closeOffset: number;
  args: Array<{
    startOffset: number;
    keyword?: string;
    star: boolean;
    doubleStar: boolean;
  }>;
  hasClose: boolean;
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class SemanticProvider {
  private readonly sortedCache = new WeakMap<Binding, Occurrence[]>();
  private readonly tokenIndexCache = new WeakMap<Binding, Map<number, number>>();

  constructor(private readonly workspace: Workspace) {}

  // ------------------------------------------------------------------ basics

  private docOf(uri: string): WorkspaceDocument | undefined {
    const open = this.workspace.get(uri);
    if (open !== undefined) return open;
    if (!uri.startsWith("file://")) return undefined;
    return this.workspace.loadByPath(uriToPath(uri));
  }

  private sorted(binding: Binding): Occurrence[] {
    let list = this.sortedCache.get(binding);
    if (list === undefined) {
      list = [...binding.occurrences].sort((a, b) => a.offset - b.offset);
      this.sortedCache.set(binding, list);
    }
    return list;
  }

  private occurrenceAt(doc: WorkspaceDocument, offset: number): Occurrence | undefined {
    const list = this.sorted(doc.binding);
    let lo = 0;
    let hi = list.length - 1;
    let found: Occurrence | undefined;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].offset <= offset) {
        found = list[mid];
        lo = mid + 1;
      } else hi = mid - 1;
    }
    // Look a little further back too: cursor may sit at the end of a name.
    for (let i = lo - 1; i >= Math.max(0, lo - 3); i--) {
      const candidate = list[i];
      if (offset >= candidate.offset && offset <= candidate.offset + candidate.length) return candidate;
    }
    void found;
    return undefined;
  }

  private rangeOfOcc(doc: WorkspaceDocument, occurrence: { offset: number; length: number }): LspRange {
    return doc.lines.rangeOf(occurrence.offset, occurrence.length);
  }

  private locationOfSym(doc: WorkspaceDocument, sym: Sym): Location {
    return { uri: doc.uri, range: doc.lines.rangeOf(sym.offset, sym.length) };
  }

  private lookup(scope: Scope, name: string, moduleScope: Scope): Sym | undefined {
    if (scope.globals.has(name)) return moduleScope.symbols.get(name);
    let cursor: Scope | undefined = scope;
    let first = true;
    while (cursor !== undefined) {
      if (cursor.kind !== "class" || first) {
        const found = cursor.symbols.get(name);
        if (found !== undefined) return found;
      }
      first = false;
      cursor = cursor.parent;
    }
    return undefined;
  }

  private documentForSymbol(sym: Sym, fallback: WorkspaceDocument): WorkspaceDocument {
    if (fallback.binding.symbols.includes(sym)) return fallback;
    for (const open of this.workspace.documents.values()) if (open.binding.symbols.includes(sym)) return open;
    for (const file of this.workspace.listThmFiles()) {
      const candidate = this.workspace.loadByPath(file);
      if (candidate?.binding.symbols.includes(sym)) return candidate;
    }
    return fallback;
  }

  private resolveClassName(doc: WorkspaceDocument, scope: Scope, name: string): Sym | undefined {
    const found = this.lookup(scope, name, doc.binding.module);
    if (found?.kind === "class") return found;
    if (found?.kind === "importMember" && found.module !== undefined) {
      const file = this.workspace.resolveModuleFile(found.module, doc.filePath);
      if (file !== undefined) {
        const exported = this.exportedSymbol(file, found.member ?? name);
        if (exported?.sym.kind === "class") return exported.sym;
      }
    }
    return undefined;
  }

  private classScopeOf(doc: WorkspaceDocument, classSym: Sym): Scope | undefined {
    return doc.binding.scopes.find((scope) => scope.kind === "class" && scope.owner === classSym);
  }

  /** C3 linearization, matching Python's deterministic multiple-inheritance MRO. */
  private classMro(doc: WorkspaceDocument, cls: Sym, active = new Set<Sym>()): Sym[] {
    if (active.has(cls)) return [cls];
    const nextActive = new Set(active);
    nextActive.add(cls);
    const ownerDoc = this.documentForSymbol(cls, doc);
    const bases = (cls.bases ?? [])
      .map((baseName) => this.resolveClassName(ownerDoc, cls.scope, baseName))
      .filter((base): base is Sym => base?.kind === "class");
    if (bases.length === 0) return [cls];
    const sequences = bases.map((base) => this.classMro(doc, base, nextActive));
    sequences.push([...bases]);
    const result: Sym[] = [cls];
    while (sequences.some((sequence) => sequence.length > 0)) {
      let candidate: Sym | undefined;
      for (const sequence of sequences) {
        const head = sequence[0];
        if (head !== undefined && !sequences.some((other) => other.slice(1).includes(head))) {
          candidate = head;
          break;
        }
      }
      if (candidate === undefined) {
        // Invalid/inconsistent hierarchy: retain deterministic depth-first fallback.
        for (const sequence of sequences) for (const item of sequence)
          if (!result.includes(item)) result.push(item);
        break;
      }
      if (!result.includes(candidate)) result.push(candidate);
      for (const sequence of sequences) if (sequence[0] === candidate) sequence.shift();
    }
    return result;
  }

  private memberOfClass(doc: WorkspaceDocument, classSym: Sym, name: string): Sym | undefined {
    for (const current of this.classMro(doc, classSym)) {
      const ownerDoc = this.documentForSymbol(current, doc);
      const direct = this.classScopeOf(ownerDoc, current)?.symbols.get(name);
      if (direct !== undefined) return direct;
    }
    return undefined;
  }

  private tokenIndex(binding: Binding): Map<number, number> {
    let map = this.tokenIndexCache.get(binding);
    if (map === undefined) {
      map = new Map();
      binding.tokens.forEach((token, index) => map!.set(token.offset, index));
      this.tokenIndexCache.set(binding, map);
    }
    return map;
  }

  /** Very small type inference: `x = Foo(...)`, `x: Foo`, `self`. */
  private inferClass(doc: WorkspaceDocument, sym: Sym, atOffset = Number.POSITIVE_INFINITY): Sym | undefined {
    if (sym.kind === "class") return sym;
    if (sym.kind === "parameter" && (sym.name === "self" || sym.name === "cls")) {
      const owner = sym.scope.owner;
      const classScope = owner?.scope;
      if (classScope?.kind === "class") return classScope.owner;
    }
    if (sym.annotation !== undefined) {
      const bare = /^[A-Za-z_]\w*/.exec(sym.annotation)?.[0];
      if (bare !== undefined) {
        const found = this.resolveClassName(doc, sym.scope, bare);
        if (found?.kind === "class") return found;
      }
    }
    if (sym.kind === "variable" || sym.kind === "parameter") {
      // Flow-sensitive approximation: use the latest assignment before the
      // cursor. This avoids suggesting members from a later reassignment.
      const writes = sym.occurrences
        .filter((occurrence) => occurrence.isWrite && occurrence.offset <= atOffset)
        .sort((a, b) => b.offset - a.offset);
      const tokens = doc.binding.tokens;
      for (const write of writes) {
        const index = this.tokenIndex(doc.binding).get(write.offset);
        if (index === undefined) continue;
        let k = index + 1;
        if (tokens[k]?.value === ":") {
          const annStart = k + 1;
          const ann = tokens[annStart];
          if (ann?.kind === "identifier") {
            const found = this.resolveClassName(doc, write.scope, ann.value);
            if (found?.kind === "class") return found;
          }
          while (k < tokens.length && tokens[k].value !== "=" && tokens[k].kind !== "newline") k++;
        }
        if (tokens[k]?.value !== "=") continue;
        const rhs = tokens[k + 1];
        if (rhs?.kind === "identifier" && tokens[k + 2]?.value === "(") {
          const callee = this.resolveClassName(doc, write.scope, rhs.value);
          if (callee?.kind === "class") return callee;
        }
        // Assignment from another known instance: y = x.
        if (rhs?.kind === "identifier") {
          const source = this.lookup(write.scope, rhs.value, doc.binding.module);
          if (source !== undefined && source !== sym) {
            const inferred = this.inferClass(doc, source, write.offset);
            if (inferred !== undefined) return inferred;
          }
        }
      }
    }
    return undefined;
  }

  /** Resolve what an occurrence refers to (including attributes). */
  private resolveOccurrence(
    doc: WorkspaceDocument,
    occurrence: Occurrence,
  ): { doc: WorkspaceDocument; sym: Sym } | undefined {
    const moduleScope = doc.binding.module;
    if (occurrence.symbol !== undefined) return { doc, sym: occurrence.symbol };
    if (occurrence.isKeywordArg && occurrence.callee !== undefined) {
      const fn = this.lookup(occurrence.scope, occurrence.callee, moduleScope);
      const target = fn?.kind === "class" ? this.memberOfClass(doc, fn, "__init__") : fn;
      const params = target === undefined ? undefined : this.paramSymbols(doc, target);
      const param = params?.get(occurrence.name);
      if (param !== undefined) return { doc, sym: param };
      return undefined;
    }
    if (occurrence.isAttribute && occurrence.receiver !== undefined) {
      const receiverSym = this.lookup(occurrence.scope, occurrence.receiver, moduleScope);
      if (receiverSym === undefined) return undefined;
      if (receiverSym.kind === "import" && receiverSym.module !== undefined) {
        const file = this.workspace.resolveModuleFile(receiverSym.module, doc.filePath);
        if (file !== undefined) {
          const member = this.exportedSymbol(file, occurrence.name);
          if (member !== undefined) return member;
        }
        return undefined;
      }
      const cls = this.inferClass(doc, receiverSym, occurrence.offset);
      if (cls !== undefined) {
        const member = this.memberOfClass(doc, cls, occurrence.name);
        if (member !== undefined) return { doc, sym: member };
      }
    }
    return undefined;
  }

  private paramSymbols(doc: WorkspaceDocument, fn: Sym): Map<string, Sym> | undefined {
    const scope = doc.binding.scopes.find((candidate) => candidate.owner === fn && candidate.kind === "function");
    if (scope === undefined) return undefined;
    const result = new Map<string, Sym>();
    for (const [name, sym] of scope.symbols) if (sym.kind === "parameter") result.set(name, sym);
    return result;
  }

  /** Top-level symbol exported by a file, following one level of re-export. */
  private exportedSymbol(
    filePath: string,
    name: string,
    depth = 0,
  ): { doc: WorkspaceDocument; sym: Sym } | undefined {
    const target = this.workspace.loadByPath(filePath);
    if (target === undefined) return undefined;
    const sym = target.binding.module.symbols.get(name);
    if (sym === undefined) return undefined;
    if (sym.kind === "importMember" && sym.module !== undefined && depth < 4) {
      const next = this.workspace.resolveModuleFile(sym.module, target.filePath);
      if (next !== undefined) {
        const inner = this.exportedSymbol(next, sym.member ?? name, depth + 1);
        if (inner !== undefined) return inner;
      }
    }
    return { doc: target, sym };
  }

  // -------------------------------------------------------------- navigation

  definition(uri: string, position: LspPosition): Location[] {
    const doc = this.docOf(uri);
    if (doc === undefined) return [];
    const offset = doc.lines.offsetAt(position.line, position.character);

    const importRecord = doc.binding.imports.find(
      (record) => offset >= record.moduleOffset && offset <= record.moduleOffset + record.moduleLength,
    );
    if (importRecord !== undefined) {
      const file = this.workspace.resolveModuleFile(importRecord.module, doc.filePath);
      return file === undefined ? [] : [fileStart(file)];
    }

    const occurrence = this.occurrenceAt(doc, offset);
    if (occurrence === undefined) return [];
    const resolved = this.resolveOccurrence(doc, occurrence);
    if (resolved === undefined) return [];
    const { sym } = resolved;

    if ((sym.kind === "importMember" || sym.kind === "import") && sym.module !== undefined) {
      const file = this.workspace.resolveModuleFile(sym.module, resolved.doc.filePath);
      if (file !== undefined) {
        if (sym.kind === "importMember") {
          const exported = this.exportedSymbol(file, sym.member ?? sym.name);
          if (exported !== undefined) return [this.locationOfSym(exported.doc, exported.sym)];
        }
        return [fileStart(file)];
      }
    }
    return [this.locationOfSym(resolved.doc, sym)];
  }

  // -------------------------------------------------------------- references

  /** All places that refer to `sym` (same-file + cross-file through imports). */
  private collect(doc: WorkspaceDocument, sym: Sym): Array<{ doc: WorkspaceDocument; offset: number; length: number; decl: boolean; write: boolean }> {
    const out: Array<{ doc: WorkspaceDocument; offset: number; length: number; decl: boolean; write: boolean }> = [];
    const seen = new Set<string>();
    const add = (d: WorkspaceDocument, occ: { offset: number; length: number }, decl: boolean, write: boolean): void => {
      const key = `${d.uri}:${occ.offset}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ doc: d, offset: occ.offset, length: occ.length, decl, write });
    };

    // Follow `from m import x` to the real definition so all files agree.
    let ownerDoc = doc;
    let owner = sym;
    if (sym.kind === "importMember" && sym.module !== undefined && sym.member === sym.name) {
      const file = this.workspace.resolveModuleFile(sym.module, doc.filePath);
      const exported = file === undefined ? undefined : this.exportedSymbol(file, sym.member ?? sym.name);
      if (exported !== undefined) {
        ownerDoc = exported.doc;
        owner = exported.sym;
      }
    }

    for (const occurrence of owner.occurrences) add(ownerDoc, occurrence, occurrence.isDeclaration, occurrence.isWrite);

    // Keyword-argument uses of parameters.
    if (owner.kind === "parameter") {
      const fn = owner.scope.owner;
      if (fn !== undefined) {
        const calleeNames = new Set<string>([fn.name]);
        if (fn.name === "__init__" && fn.scope.owner !== undefined) calleeNames.add(fn.scope.owner.name);
        for (const occ of ownerDoc.binding.occurrences) {
          if (occ.isKeywordArg && occ.name === owner.name && occ.callee !== undefined && calleeNames.has(occ.callee))
            add(ownerDoc, occ, false, false);
        }
      }
    }

    // Methods / properties: attribute uses by name (receiver types are heuristic).
    const isMember = owner.kind === "method" || owner.kind === "property" ||
      (owner.scope.kind === "class" && owner.kind === "variable");
    if (isMember) {
      for (const occ of ownerDoc.binding.occurrences) {
        if (occ.isAttribute && occ.name === owner.name) add(ownerDoc, occ, false, occ.isWrite);
      }
    }

    // Cross-file: importers of the owner's module (top-level symbols only).
    if (owner.scope.kind === "module" || isMember) {
      this.forEachOtherDoc(ownerDoc, (other) => {
        const moduleScope = other.binding.module;
        for (const record of other.binding.imports) {
          const file = this.workspace.resolveModuleFile(record.module, other.filePath);
          if (file === undefined || file !== ownerDoc.filePath) continue;
          if (record.fromImport) {
            for (const member of record.members) {
              if (member.name !== owner.name) continue;
              const local = moduleScope.symbols.get(member.alias ?? member.name);
              if (member.alias === undefined && local !== undefined) {
                for (const occurrence of local.occurrences) add(other, occurrence, occurrence.isDeclaration, occurrence.isWrite);
              } else add(other, member, false, false);
            }
          } else {
            const alias = record.alias ?? record.module.split(".")[0];
            for (const occ of other.binding.occurrences) {
              if (occ.isAttribute && occ.receiver === alias && occ.name === owner.name) add(other, occ, false, false);
            }
          }
        }
      });
    }
    out.sort((a, b) => (a.doc.uri === b.doc.uri ? a.offset - b.offset : a.doc.uri < b.doc.uri ? -1 : 1));
    return out;
  }

  private forEachOtherDoc(except: WorkspaceDocument, visit: (doc: WorkspaceDocument) => void): void {
    const visited = new Set<string>([except.filePath]);
    for (const document of this.workspace.documents.values()) {
      if (document.filePath === except.filePath) continue;
      visited.add(document.filePath);
      visit(document);
    }
    for (const file of this.workspace.listThmFiles()) {
      if (visited.has(file)) continue;
      visited.add(file);
      const loaded = this.workspace.loadByPath(file);
      if (loaded !== undefined) visit(loaded);
    }
  }

  references(uri: string, position: LspPosition, includeDeclaration: boolean): Location[] {
    const doc = this.docOf(uri);
    if (doc === undefined) return [];
    const occurrence = this.occurrenceAt(doc, doc.lines.offsetAt(position.line, position.character));
    if (occurrence === undefined) return [];
    const resolved = this.resolveOccurrence(doc, occurrence);
    if (resolved === undefined) {
      // Unresolved (builtin / unknown): same-spelling uses in this file.
      return doc.binding.occurrences
        .filter((o) => o.name === occurrence.name && o.isAttribute === occurrence.isAttribute)
        .map((o) => ({ uri: doc.uri, range: this.rangeOfOcc(doc, o) }));
    }
    return this.collect(resolved.doc, resolved.sym)
      .filter((entry) => includeDeclaration || !entry.decl)
      .map((entry) => ({ uri: entry.doc.uri, range: entry.doc.lines.rangeOf(entry.offset, entry.length) }));
  }

  documentHighlights(uri: string, position: LspPosition): Array<{ range: LspRange; kind: 1 | 2 | 3 }> {
    const doc = this.docOf(uri);
    if (doc === undefined) return [];
    const occurrence = this.occurrenceAt(doc, doc.lines.offsetAt(position.line, position.character));
    if (occurrence === undefined) return [];
    const resolved = this.resolveOccurrence(doc, occurrence);
    if (resolved === undefined) {
      return doc.binding.occurrences
        .filter((o) => o.name === occurrence.name && o.isAttribute === occurrence.isAttribute)
        .map((o) => ({ range: this.rangeOfOcc(doc, o), kind: 1 as const }));
    }
    return this.collect(resolved.doc, resolved.sym)
      .filter((entry) => entry.doc.uri === doc.uri)
      .map((entry) => ({
        range: doc.lines.rangeOf(entry.offset, entry.length),
        kind: (entry.write ? 3 : 2) as 2 | 3,
      }));
  }

  // ------------------------------------------------------------------ rename

  prepareRename(uri: string, position: LspPosition): { range: LspRange; placeholder: string } | null {
    const doc = this.docOf(uri);
    if (doc === undefined) return null;
    const occurrence = this.occurrenceAt(doc, doc.lines.offsetAt(position.line, position.character));
    if (occurrence === undefined) return null;
    const resolved = this.resolveOccurrence(doc, occurrence);
    if (resolved === undefined) {
      throw new LspError(-32803, `Cannot rename '${occurrence.name}': it is not defined in this workspace`);
    }
    if (resolved.doc.binding !== doc.binding && resolved.doc.filePath.startsWith("<")) return null;
    return { range: this.rangeOfOcc(doc, occurrence), placeholder: occurrence.name };
  }

  rename(uri: string, position: LspPosition, newName: string): { changes: Record<string, Array<{ range: LspRange; newText: string }>> } {
    if (!IDENT.test(newName) || isKeyword(newName))
      throw new LspError(-32602, `'${newName}' is not a valid identifier`);
    const doc = this.docOf(uri);
    if (doc === undefined) throw new LspError(-32602, "Unknown document");
    const occurrence = this.occurrenceAt(doc, doc.lines.offsetAt(position.line, position.character));
    if (occurrence === undefined) throw new LspError(-32803, "Nothing to rename at this position");
    const resolved = this.resolveOccurrence(doc, occurrence);
    if (resolved === undefined)
      throw new LspError(-32803, `Cannot rename '${occurrence.name}': it is not defined in this workspace`);
    // Collision check inside the owning scope.
    const clash = resolved.sym.scope.symbols.get(newName);
    if (clash !== undefined && clash !== resolved.sym)
      throw new LspError(-32602, `'${newName}' is already defined in this scope`);

    const changes: Record<string, Array<{ range: LspRange; newText: string }>> = {};
    for (const entry of this.collect(resolved.doc, resolved.sym)) {
      (changes[entry.doc.uri] ??= []).push({
        range: entry.doc.lines.rangeOf(entry.offset, entry.length),
        newText: newName,
      });
    }
    return { changes };
  }

  // ------------------------------------------------------------------- hover

  hover(uri: string, position: LspPosition): { contents: string; range: LspRange } | null {
    const doc = this.docOf(uri);
    if (doc === undefined) return null;
    const occurrence = this.occurrenceAt(doc, doc.lines.offsetAt(position.line, position.character));
    if (occurrence === undefined) return null;
    const resolved = this.resolveOccurrence(doc, occurrence);
    if (resolved === undefined) return null;
    const { sym } = resolved;
    const lines: string[] = [];
    let header: string;
    switch (sym.kind) {
      case "function":
      case "method":
        header = sym.detail ?? `def ${sym.name}()`;
        break;
      case "class":
        header = sym.detail ?? `class ${sym.name}`;
        break;
      case "parameter":
        header = `(parameter) ${sym.name}${sym.annotation ? `: ${sym.annotation}` : ""}`;
        break;
      case "import":
        header = `(module) ${sym.module ?? sym.name}`;
        break;
      case "importMember":
        header = `(imported) ${sym.detail ?? sym.name}`;
        break;
      case "property":
        header = `(property) ${sym.name}`;
        break;
      case "exception":
        header = `(exception) ${sym.name}`;
        break;
      default: {
        const cls = this.inferClass(resolved.doc, sym);
        const type = sym.annotation ?? (cls !== undefined ? cls.name : undefined);
        header = `(${sym.scope.kind === "module" ? "variable" : sym.scope.kind === "class" ? "attribute" : "local variable"}) ${sym.name}${type ? `: ${type}` : ""}`;
      }
    }
    lines.push("```thm\n" + header + "\n```");
    if (sym.doc) lines.push(sym.doc);
    if ((sym.kind === "importMember" || sym.kind === "import") && sym.module !== undefined) {
      const file = this.workspace.resolveModuleFile(sym.module, resolved.doc.filePath);
      if (file !== undefined) {
        const exported = sym.kind === "importMember" ? this.exportedSymbol(file, sym.member ?? sym.name) : undefined;
        if (exported?.sym.detail) lines.push("```thm\n" + exported.sym.detail + "\n```");
        if (exported?.sym.doc) lines.push(exported.sym.doc);
      }
    }
    return { contents: lines.join("\n\n"), range: this.rangeOfOcc(doc, occurrence) };
  }

  // ----------------------------------------------------------------- symbols

  documentSymbols(uri: string): unknown[] {
    const doc = this.docOf(uri);
    if (doc === undefined) return [];
    const { binding, lines } = doc;
    interface Node { name: string; detail?: string; kind: number; range: LspRange; selectionRange: LspRange; children: Node[] }
    const nodes = new Map<Sym, Node>();
    const roots: Node[] = [];
    const wanted = binding.symbols
      .filter((sym) => {
        if (sym.kind === "parameter") return false;
        if (sym.kind === "exception") return false;
        const scopeKind = sym.scope.kind;
        if (scopeKind === "module" || scopeKind === "class") return true;
        // nested function/class definitions stay visible under their parent
        return (sym.kind === "function" || sym.kind === "class" || sym.kind === "method") && scopeKind === "function";
      })
      .sort((a, b) => a.offset - b.offset);

    for (const sym of wanted) {
      const isScoped = sym.fullStart !== undefined && sym.fullEnd !== undefined;
      const range = isScoped
        ? lines.rangeOf(sym.fullStart!, Math.max(sym.fullEnd! - sym.fullStart!, 1))
        : lines.rangeOf(sym.offset, sym.length);
      const selection = lines.rangeOf(sym.offset, sym.length);
      const upper = sym.name === sym.name.toUpperCase() && /[A-Z]/.test(sym.name);
      let kind: number;
      switch (sym.kind) {
        case "class": kind = SYMBOL_KIND.Class; break;
        case "method": kind = sym.name === "__init__" ? SYMBOL_KIND.Constructor : SYMBOL_KIND.Method; break;
        case "function": kind = SYMBOL_KIND.Function; break;
        case "import":
        case "importMember": kind = SYMBOL_KIND.Module; break;
        case "property": kind = SYMBOL_KIND.Property; break;
        default:
          kind = sym.scope.kind === "class" ? SYMBOL_KIND.Field : upper ? SYMBOL_KIND.Constant : SYMBOL_KIND.Variable;
      }
      const node: Node = { name: sym.name, detail: sym.detail, kind, range, selectionRange: selection, children: [] };
      nodes.set(sym, node);
      const owner = sym.scope.owner;
      const parent = owner !== undefined ? nodes.get(owner) : undefined;
      if (parent !== undefined) parent.children.push(node);
      else roots.push(node);
    }
    return roots;
  }

  workspaceSymbols(query: string): unknown[] {
    const results: unknown[] = [];
    const lower = query.toLowerCase();
    const matches = (name: string): boolean => {
      if (lower === "") return true;
      const target = name.toLowerCase();
      let at = 0;
      for (const ch of lower) {
        at = target.indexOf(ch, at);
        if (at < 0) return false;
        at++;
      }
      return true;
    };
    const visit = (doc: WorkspaceDocument): void => {
      for (const sym of doc.binding.symbols) {
        if (results.length >= 300) return;
        if (sym.kind === "parameter" || sym.kind === "exception" || sym.kind === "import" || sym.kind === "importMember") continue;
        if (sym.scope.kind === "function" || sym.scope.kind === "lambda" || sym.scope.kind === "comprehension") continue;
        if (!matches(sym.name)) continue;
        results.push({
          name: sym.name,
          kind: sym.kind === "class" ? SYMBOL_KIND.Class : sym.kind === "method" ? SYMBOL_KIND.Method :
            sym.kind === "function" ? SYMBOL_KIND.Function : sym.kind === "property" ? SYMBOL_KIND.Property : SYMBOL_KIND.Variable,
          containerName: sym.scope.owner?.name,
          location: this.locationOfSym(doc, sym),
        });
      }
    };
    const seen = new Set<string>();
    for (const doc of this.workspace.documents.values()) {
      seen.add(doc.filePath);
      visit(doc);
    }
    for (const file of this.workspace.listThmFiles()) {
      if (seen.has(file)) continue;
      const doc = this.workspace.loadByPath(file);
      if (doc !== undefined) visit(doc);
    }
    return results;
  }

  // ----------------------------------------------------------- editor sugar

  foldingRanges(uri: string): Array<{ startLine: number; endLine: number; kind?: string }> {
    const doc = this.docOf(uri);
    if (doc === undefined) return [];
    return doc.binding.folds.map((fold) => ({
      startLine: fold.startLine,
      endLine: fold.endLine,
      ...(fold.kind !== undefined ? { kind: fold.kind } : {}),
    }));
  }

  selectionRanges(uri: string, positions: LspPosition[]): unknown[] {
    const doc = this.docOf(uri);
    if (doc === undefined) return positions.map(() => null);
    const { lines, text, binding } = doc;
    return positions.map((position) => {
      const offset = lines.offsetAt(position.line, position.character);
      const chain: Array<[number, number]> = [];
      let ws = offset;
      let we = offset;
      while (ws > 0 && /\w/.test(text[ws - 1])) ws--;
      while (we < text.length && /\w/.test(text[we])) we++;
      if (we > ws) chain.push([ws, we]);
      // Enclosing bracket pairs, innermost first.
      const pairs: Array<[number, number]> = [];
      const stack: number[] = [];
      for (const token of binding.tokens) {
        if (token.kind !== "operator") continue;
        if ("([{".includes(token.value)) stack.push(token.offset);
        else if (")]}".includes(token.value) && stack.length > 0) {
          const open = stack.pop()!;
          if (open < offset && token.offset >= offset) pairs.push([open + 1, token.offset]);
          if (open <= offset && token.offset + 1 >= offset) pairs.push([open, token.offset + 1]);
        }
      }
      pairs.sort((a, b) => a[1] - a[0] - (b[1] - b[0]));
      const lineStart = lines.lineStart(position.line);
      const lineEnd = lines.lineEnd(position.line);
      const firstNonSpace = lineStart + (/^\s*/.exec(text.slice(lineStart, lineEnd))?.[0].length ?? 0);
      const all = [...chain, ...pairs, [firstNonSpace, lineEnd] as [number, number], [0, text.length] as [number, number]]
        .filter(([a, b]) => a <= offset && b >= offset && b > a)
        .sort((x, y) => x[1] - x[0] - (y[1] - y[0]));
      let result: { range: LspRange; parent?: unknown } | undefined;
      let last: [number, number] | undefined;
      for (let i = all.length - 1; i >= 0; i--) {
        const [a, b] = all[i];
        if (last !== undefined && last[0] === a && last[1] === b) continue;
        result = { range: lines.rangeOf(a, b - a), ...(result !== undefined ? { parent: result } : {}) };
        last = [a, b];
      }
      return result ?? { range: lines.rangeOf(offset, 0) };
    });
  }

  documentLinks(uri: string): Array<{ range: LspRange; target: string; tooltip: string }> {
    const doc = this.docOf(uri);
    if (doc === undefined) return [];
    const links: Array<{ range: LspRange; target: string; tooltip: string }> = [];
    for (const record of doc.binding.imports) {
      const file = this.workspace.resolveModuleFile(record.module, doc.filePath);
      if (file === undefined) continue;
      links.push({
        range: doc.lines.rangeOf(record.moduleOffset, record.moduleLength),
        target: pathToUri(file),
        tooltip: file,
      });
    }
    return links;
  }

  // ---------------------------------------------------------- semantic tokens

  semanticTokens(uri: string, range?: LspRange): { data: number[] } {
    const doc = this.docOf(uri);
    if (doc === undefined) return { data: [] };
    const { lines, binding } = doc;
    const typeIndex = (name: (typeof SEMANTIC_TOKEN_TYPES)[number]): number => SEMANTIC_TOKEN_TYPES.indexOf(name);
    const modBit = (name: (typeof SEMANTIC_TOKEN_MODIFIERS)[number]): number => 1 << SEMANTIC_TOKEN_MODIFIERS.indexOf(name);
    const startOffset = range === undefined ? 0 : lines.offsetAt(range.start.line, range.start.character);
    const endOffset = range === undefined ? doc.text.length : lines.offsetAt(range.end.line, range.end.character);

    const entries: Array<{ offset: number; length: number; type: number; mods: number }> = [];
    for (const occurrence of this.sorted(binding)) {
      if (occurrence.offset < startOffset || occurrence.offset > endOffset) continue;
      let type = -1;
      let mods = occurrence.isDeclaration ? modBit("declaration") : 0;
      const resolved = occurrence.isKeywordArg || occurrence.isAttribute || occurrence.symbol === undefined
        ? this.resolveOccurrence(doc, occurrence)
        : { doc, sym: occurrence.symbol };
      if (occurrence.isKeywordArg) type = typeIndex("parameter");
      else if (resolved !== undefined) {
        const sym = resolved.sym;
        switch (sym.kind) {
          case "class": type = typeIndex("class"); break;
          case "function": type = typeIndex("function"); break;
          case "method": type = typeIndex("method"); break;
          case "property": type = typeIndex("property"); break;
          case "parameter": type = sym.detail?.startsWith("type parameter") ? typeIndex("type") : typeIndex("parameter"); break;
          case "import": type = typeIndex("namespace"); break;
          case "importMember": {
            const file = sym.module === undefined ? undefined : this.workspace.resolveModuleFile(sym.module, resolved.doc.filePath);
            const exported = file === undefined ? undefined : this.exportedSymbol(file, sym.member ?? sym.name);
            type = exported?.sym.kind === "class" ? typeIndex("class") :
              exported?.sym.kind === "function" ? typeIndex("function") : typeIndex("variable");
            break;
          }
          default:
            type = sym.scope.kind === "class" ? typeIndex("property") : typeIndex("variable");
        }
        if (sym.isAsync) mods |= modBit("async");
        if (sym.kind === "variable" && /^[A-Z][A-Z0-9_]*$/.test(sym.name)) mods |= modBit("readonly");
      } else if (occurrence.isAttribute) {
        type = typeIndex("property");
      } else if (GLOBAL_TYPES[occurrence.name] !== undefined) {
        type = typeIndex("class");
        mods |= modBit("defaultLibrary");
      } else if (GLOBAL_FUNCTIONS[occurrence.name] !== undefined) {
        type = typeIndex("function");
        mods |= modBit("defaultLibrary");
      } else if (occurrence.name === "true" || occurrence.name === "false" || occurrence.name === "none") {
        continue; // left to the TextMate grammar
      }
      if (type >= 0) entries.push({ offset: occurrence.offset, length: occurrence.length, type, mods });
    }
    entries.sort((a, b) => a.offset - b.offset);
    const data: number[] = [];
    let prevLine = 0;
    let prevChar = 0;
    let lastOffset = -1;
    for (const entry of entries) {
      if (entry.offset === lastOffset) continue;
      lastOffset = entry.offset;
      const pos = lines.positionAt(entry.offset);
      const deltaLine = pos.line - prevLine;
      const deltaChar = deltaLine === 0 ? pos.character - prevChar : pos.character;
      data.push(deltaLine, deltaChar, entry.length, entry.type, entry.mods);
      prevLine = pos.line;
      prevChar = pos.character;
    }
    return { data };
  }

  // ------------------------------------------------------------ call analysis

  private callSites(doc: WorkspaceDocument): CallSite[] {
    const { binding } = doc;
    const tokens = binding.tokens;
    const index = this.tokenIndex(binding);
    const sites: CallSite[] = [];
    for (const occurrence of binding.occurrences) {
      if (occurrence.isAttribute || occurrence.isKeywordArg || occurrence.isAnnotation) continue;
      if (occurrence.isDeclaration || occurrence.symbol === undefined) continue;
      let sym = occurrence.symbol;
      let symDoc = doc;
      if (sym.rebound) continue;
      if (sym.kind === "importMember" && sym.module !== undefined) {
        const file = this.workspace.resolveModuleFile(sym.module, doc.filePath);
        const exported = file === undefined ? undefined : this.exportedSymbol(file, sym.member ?? sym.name);
        if (exported === undefined || exported.sym.rebound) continue;
        sym = exported.sym;
        symDoc = exported.doc;
      }
      if (sym.decorated) continue;
      let target: Sym | undefined;
      if (sym.kind === "function") target = sym;
      else if (sym.kind === "class") target = this.memberOfClass(symDoc, sym, "__init__");
      if (target === undefined || target.parameters === undefined) continue;
      if (sym.kind === "class" && (sym.decorated || (sym.bases ?? []).some((base) => this.lookup(sym.scope, base, symDoc.binding.module) === undefined)))
        continue;
      const at = index.get(occurrence.offset);
      if (at === undefined) continue;
      const open = tokens[at + 1];
      if (open === undefined || open.kind !== "operator" || open.value !== "(") continue;
      const prev = tokens[at - 1];
      if (prev !== undefined && prev.kind === "keyword" && (prev.value === "def" || prev.value === "class")) continue;
      // Parse arguments.
      const args: CallSite["args"] = [];
      let depth = 0;
      let k = at + 2;
      let argStart = k;
      let closeOffset = open.offset + 1;
      let hasClose = false;
      const flush = (end: number): void => {
        const slice = tokens.slice(argStart, end).filter((t) => t.kind !== "newline");
        if (slice.length === 0) return;
        const first = slice[0];
        const entry: CallSite["args"][number] = { startOffset: first.offset, star: false, doubleStar: false };
        if (first.kind === "operator" && first.value === "*") entry.star = true;
        else if (first.kind === "operator" && first.value === "**") entry.doubleStar = true;
        else if (first.kind === "identifier" && slice[1]?.value === "=" && slice[1].kind === "operator") entry.keyword = first.value;
        args.push(entry);
      };
      for (; k < tokens.length; k++) {
        const t = tokens[k];
        if (t.kind === "eof") break;
        if (t.kind === "operator") {
          if ("([{".includes(t.value)) depth++;
          else if (")]}".includes(t.value)) {
            if (depth === 0) {
              flush(k);
              closeOffset = t.offset;
              hasClose = t.value === ")";
              break;
            }
            depth--;
          } else if (t.value === "," && depth === 0) {
            flush(k);
            argStart = k + 1;
          }
        }
      }
      sites.push({ nameOcc: occurrence, target, openOffset: open.offset, closeOffset, args, hasClose });
    }
    return sites;
  }

  private inferredType(doc: WorkspaceDocument, sym: Sym, atOffset: number): string | undefined {
    if (sym.annotation !== undefined) return sym.annotation;
    if (sym.kind === "class") return "type";
    if (sym.kind === "function" || sym.kind === "method") return "Callable";
    const writes = sym.occurrences.filter((o) => o.isWrite && o.offset <= atOffset).sort((a, b) => b.offset - a.offset);
    for (const write of writes) {
      const index = this.tokenIndex(doc.binding).get(write.offset);
      if (index === undefined) continue;
      const tokens = doc.binding.tokens;
      let k = index + 1;
      while (k < tokens.length && tokens[k].value !== "=" && tokens[k].kind !== "newline") k++;
      if (tokens[k]?.value !== "=") continue;
      const rhs = tokens[k + 1];
      if (rhs === undefined) continue;
      if (rhs.kind === "string") return "str";
      if (rhs.kind === "number") return rhs.value.includes(".") ? "float" : "int";
      if (["true", "false"].includes(rhs.value)) return "bool";
      if (rhs.value === "none") return "None";
      if (rhs.value === "[" ) return "list";
      if (rhs.value === "{" ) return "dict";
      if (rhs.value === "(" ) return "tuple";
      if (rhs.kind === "identifier") {
        const called = tokens[k + 2]?.value === "(" ? this.lookup(write.scope, rhs.value, doc.binding.module) : undefined;
        if (called?.kind === "class") return called.name;
        if (called?.kind === "function" || called?.kind === "method") return called.returnAnnotation ?? "Any";
        const source = this.lookup(write.scope, rhs.value, doc.binding.module);
        if (source !== undefined && source !== sym) return this.inferredType(doc, source, write.offset);
      }
    }
    return undefined;
  }

  inlayHints(uri: string, range: LspRange): unknown[] {
    const doc = this.docOf(uri);
    if (doc === undefined) return [];
    const startOffset = doc.lines.offsetAt(range.start.line, range.start.character);
    const endOffset = doc.lines.offsetAt(range.end.line, range.end.character);
    const hints: unknown[] = [];
    for (const site of this.callSites(doc)) {
      if (site.openOffset < startOffset || site.openOffset > endOffset) continue;
      const params = (site.target.parameters ?? []).filter((p, i) => !(i === 0 && (p.name === "self" || p.name === "cls") && site.target.scope.kind === "class"));
      let positional = 0;
      for (const arg of site.args) {
        if (arg.keyword !== undefined || arg.star || arg.doubleStar) { if (arg.star) break; continue; }
        const param = params[positional++];
        if (param === undefined || param.kind === "vararg" || param.kind === "kwarg") break;
        // Skip when the argument already is the same identifier.
        const text = doc.text.slice(arg.startOffset, arg.startOffset + param.name.length);
        if (text === param.name && !/\w/.test(doc.text[arg.startOffset + param.name.length] ?? "")) continue;
        hints.push({
          position: doc.lines.positionAt(arg.startOffset),
          label: `${param.name}:`,
          kind: 2,
          paddingRight: true,
        });
      }
    }
    // Infer unannotated variable types at their first declaration. These are
    // informational hints; unknown/ambiguous values are intentionally omitted.
    for (const sym of doc.binding.symbols) {
      if (sym.kind !== "variable" || sym.annotation !== undefined) continue;
      const declaration = sym.occurrences.find((o) => o.isDeclaration);
      if (declaration === undefined) continue;
      const type = this.inferredType(doc, sym, endOffset);
      if (type === undefined || type === "Any") continue;
      const position = doc.lines.positionAt(declaration.offset + declaration.length);
      if (declaration.offset < startOffset || declaration.offset > endOffset) continue;
      hints.push({ position, label: `: ${type}`, kind: 1, paddingLeft: true });
    }
    return hints;
  }

  // ------------------------------------------------------------- diagnostics

  diagnostics(uri: string): Diagnostic[] {
    const doc = this.docOf(uri);
    if (doc === undefined) return [];
    const { binding, lines, text } = doc;
    const out: Diagnostic[] = [];
    const push = (
      offset: number, length: number, severity: Diagnostic["severity"], message: string,
      code: string, extra: Partial<Diagnostic> = {},
    ): void => {
      out.push({ range: lines.rangeOf(offset, Math.max(length, 1)), severity, message, source: "thm", code, ...extra });
    };

    // 0. AST-based static typing (THM 0.4.0): annotations, inferred values,
    // union/optional narrowing, and CFG-backed flow facts.
    const typeResult = checkTypes(text);
    for (const diagnostic of typeResult.diagnostics) {
      const lineStart = lines.lineStart(diagnostic.line);
      push(lineStart + diagnostic.start, diagnostic.end - diagnostic.start, 1,
        diagnostic.message, diagnostic.code);
    }

    // 1. Lexical errors.
    for (const token of binding.tokens) {
      if (token.kind !== "error") continue;
      const unterminated = token.value.startsWith('"') || token.value.startsWith("'") || /^[rbf]{1,2}["']/i.test(token.value);
      push(token.offset, token.length, 1,
        unterminated ? "Unterminated string literal" : `Unexpected character '${token.value}'`,
        unterminated ? "unterminated-string" : "unexpected-character");
    }

    // 2. Bracket matching.
    const closers: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
    const stack: Token[] = [];
    for (const token of binding.tokens) {
      if (token.kind !== "operator") continue;
      if (token.value === "(" || token.value === "[" || token.value === "{") stack.push(token);
      else if (token.value in closers) {
        const top = stack[stack.length - 1];
        if (top !== undefined && top.value === closers[token.value]) stack.pop();
        else push(token.offset, 1, 1, `Unmatched '${token.value}'`, "unmatched-bracket", { data: { removeUnexpectedToken: true } });
      }
    }
    const matchingCloser: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
    for (const open of stack) push(open.offset, 1, 1, `'${open.value}' was never closed`, "unclosed-bracket", { data: { insertText: matchingCloser[open.value] } });

    // 3. Block headers must be followed by `{`.
    this.checkBlockHeaders(doc, push);

    // 4. Statement placement.
    this.checkStatements(doc, push);

    // 5. Imports.
    this.checkImports(doc, push);

    // 6. Names.
    const hasStar = binding.imports.some((record) => record.star === true);
    if (!hasStar) {
      for (const occurrence of binding.unresolved) {
        if (occurrence.isAnnotation) continue;
        const name = occurrence.name;
        if (PRELUDE_NAMES.has(name) || GLOBAL_FUNCTIONS[name] !== undefined || GLOBAL_TYPES[name] !== undefined) continue;
        if (KEYWORDS.includes(name) || KEYWORD_HELP[name] !== undefined) continue;
        const builtinSuggestion = BUILTIN_MODULES[name] !== undefined && !this.isShadowed(binding, name);
        const workspaceSuggestion = builtinSuggestion ? undefined : this.findWorkspaceExport(name, doc);
        push(occurrence.offset, occurrence.length, 2, `Undefined name '${name}'`, "undefined-name", {
          ...(builtinSuggestion ? { data: { importModule: name } } : workspaceSuggestion ? { data: { importModule: workspaceSuggestion.module, importMember: name } } : {}),
        });
      }
    }

    // 7. Unused imports.
    for (const sym of binding.symbols) {
      if ((sym.kind !== "import" && sym.kind !== "importMember") || sym.scope.kind !== "module") continue;
      const used = sym.occurrences.some((o) => !o.isDeclaration);
      const isInit = doc.filePath.endsWith("__init__.thm");
      if (!used && !isInit && !sym.name.startsWith("_"))
        push(sym.offset, sym.length, 4, `'${sym.name}' is imported but never used`, "unused-import", {
          tags: [1],
          data: { unusedImport: sym.name },
        });
    }

    // 8. Function definition problems.
    for (const scope of binding.scopes) {
      if (scope.kind !== "function" || scope.owner === undefined) continue;
      const seenDefault = { value: false };
      const names = new Map<string, number>();
      const owner = scope.owner;
      for (const occurrence of owner.occurrences) void occurrence;
      const params = [...scope.symbols.values()].filter((sym) => sym.kind === "parameter" && !sym.detail?.startsWith("type parameter"));
      const info = owner.parameters ?? [];
      params.forEach((param, i) => {
        const spec = info[i];
        names.set(param.name, (names.get(param.name) ?? 0) + 1);
        if (spec === undefined) return;
        if (spec.kind === "positional") {
          if (spec.hasDefault) seenDefault.value = true;
          else if (seenDefault.value)
            push(param.offset, param.length, 1, "Non-default parameter follows default parameter", "param-order");
        }
      });
      // duplicate params (the map above de-dupes, so scan the info list)
      const dup = new Set<string>();
      for (const spec of info) {
        if (dup.has(spec.name)) {
          const at = scope.symbols.get(spec.name);
          if (at !== undefined) push(at.offset, at.length, 1, `Duplicate parameter '${spec.name}'`, "duplicate-param");
        }
        dup.add(spec.name);
      }
    }

    // 9. Call checks against user-defined signatures.
    for (const site of this.callSites(doc)) {
      const target = site.target;
      const sym = target.scope.kind === "class" ? (target.scope.owner ?? target) : target;
      const params = (target.parameters ?? []).filter(
        (p, i) => !(i === 0 && (sym.kind === "class" || target.scope.kind === "class") && (p.name === "self" || p.name === "cls")),
      );
      const hasVarargs = params.some((p) => p.kind === "vararg");
      const hasKwargs = params.some((p) => p.kind === "kwarg");
      const positionalParams = params.filter((p) => p.kind === "positional");
      const keywordNames = new Set(params.filter((p) => p.kind !== "vararg" && p.kind !== "kwarg").map((p) => p.name));
      const anyStar = site.args.some((a) => a.star);
      const anyDoubleStar = site.args.some((a) => a.doubleStar);
      let positionalCount = 0;
      const seenKeywords = new Set<string>();
      const nameOff = site.nameOcc.offset;
      const nameLen = site.nameOcc.length;
      for (const arg of site.args) {
        if (arg.keyword !== undefined) {
          if (!keywordNames.has(arg.keyword) && !hasKwargs)
            push(arg.startOffset, arg.keyword.length, 1, `Unexpected keyword argument '${arg.keyword}'`, "unexpected-keyword");
          if (seenKeywords.has(arg.keyword))
            push(arg.startOffset, arg.keyword.length, 1, `Duplicate keyword argument '${arg.keyword}'`, "duplicate-keyword");
          seenKeywords.add(arg.keyword);
        } else if (!arg.star && !arg.doubleStar) positionalCount++;
      }
      if (!anyStar && !hasVarargs && positionalCount > positionalParams.length) {
        const extra = site.args.filter((a) => a.keyword === undefined && !a.star && !a.doubleStar)[positionalParams.length];
        push(extra?.startOffset ?? nameOff, extra === undefined ? nameLen : 1, 1,
          `'${sym.name}' takes ${positionalParams.length} positional argument${positionalParams.length === 1 ? "" : "s"} but ${positionalCount} ${positionalCount === 1 ? "was" : "were"} given`,
          "too-many-arguments");
      }
      if (!anyStar && !anyDoubleStar && site.hasClose) {
        const missing = positionalParams.filter(
          (p, i) => !p.hasDefault && i >= positionalCount && !seenKeywords.has(p.name),
        );
        const missingKwOnly = params.filter((p) => p.kind === "keywordOnly" && !p.hasDefault && !seenKeywords.has(p.name));
        const all = [...missing, ...missingKwOnly];
        if (all.length > 0)
          push(nameOff, nameLen, 1,
            `Missing required argument${all.length === 1 ? "" : "s"}: ${all.map((p) => `'${p.name}'`).join(", ")}`,
            "missing-argument");
      }
    }

    // 10. assert on an exception object is always truthy.
    doc.text.split("\n").forEach((lineText, line) => {
      const m = /^(\s*)assert\s+([A-Z]\w*(?:Error|Exception)?\s*\([^)]*\))/.exec(lineText);
      if (m !== null) {
        const startChar = m[1].length;
        const offset = lines.lineStart(line) + startChar;
        push(offset, "assert".length, 2,
          "assert on an exception object is always true — use 'raise' to throw, or assert a boolean condition",
          "assert-always-true");
      }
    });
    void text;
    return out;
  }

  private isShadowed(binding: Binding, name: string): boolean {
    return binding.module.symbols.has(name);
  }

  private checkBlockHeaders(
    doc: WorkspaceDocument,
    push: (offset: number, length: number, severity: Diagnostic["severity"], message: string, code: string) => void,
  ): void {
    const tokens = doc.binding.tokens;
    const headerKeywords = new Set(["if", "elif", "while", "for", "else", "try", "finally", "except", "class", "def", "switch"]);
    // `case`/`default` belong to switch blocks; their clause bodies may be a
    // `{ ... }` block (like headers) or fallthrough `case N:` statements.
    const clauseKeywords = new Set(["case", "default"]);
    let i = 0;
    let atLineStart = true;
    let depth = 0;
    let insideSwitch = false;
    let switchDepth = -1;
    while (i < tokens.length) {
      const token = tokens[i];
      if (token.kind === "eof") break;
      if (token.kind === "newline") { atLineStart = true; i++; continue; }
      if (token.kind === "keyword" && token.value === "switch" && depth === switchDepth) {
        insideSwitch = false; // left the previous switch block
      }
      if (token.kind === "keyword" && token.value === "switch") {
        switchDepth = depth;
        insideSwitch = true;
      }
      const statementStart = atLineStart ||
        (token.kind === "operator" && false);
      const prev = tokens[i - 1];
      const afterBrace = prev !== undefined && prev.kind === "operator" && (prev.value === "{" || prev.value === "}");
      const isStart = statementStart || afterBrace;
      atLineStart = false;
      const isHeaderKeyword =
        (token.kind === "keyword" && (headerKeywords.has(token.value) || clauseKeywords.has(token.value))) ||
        (token.kind === "keyword" && token.value === "async" && tokens[i + 1]?.value === "def");
      if (isStart && isHeaderKeyword && depth === 0 && !insideSwitch) {
        // Find end of header: first `{` at bracket depth 0, or newline.
        let k = i + 1;
        let d = 0;
        let foundBrace = false;
        let lastToken = token;
        while (k < tokens.length) {
          const t = tokens[k];
          if (t.kind === "eof") break;
          if (t.kind === "newline" && d === 0) break;
          if (t.kind === "operator") {
            if (t.value === "(" || t.value === "[") d++;
            else if (t.value === ")" || t.value === "]") d = Math.max(0, d - 1);
            else if (t.value === "{" && d === 0) { foundBrace = true; break; }
          }
          lastToken = t;
          k++;
        }
        if (foundBrace && clauseKeywords.has(token.value)) {
          insideSwitch = true; // case/default clauses end at the block's `}`
        } else if (!foundBrace && !(token.kind === "keyword" && token.value === "case" &&
          tokens.slice(i + 1, k).some((t) => t.kind === "operator" && t.value === ":"))) {
          // `{` may start the next line.
          let n = k;
          while (tokens[n]?.kind === "newline") n++;
          const next = tokens[n];
          if (!(next?.kind === "operator" && next.value === "{")) {
            const hint = token.value === "else" && tokens[i + 1]?.value === "if" ? " (use 'elif')" : "";
            push(lastToken.offset, Math.max(lastToken.length, 1), 1,
              `Expected '{' to begin block after '${token.value}'${hint}`, "missing-block");
          }
        }
      }
      if (token.kind === "operator" && (token.value === "(" || token.value === "[")) depth++;
      if (token.kind === "operator" && (token.value === ")" || token.value === "]")) depth = Math.max(0, depth - 1);
      if (insideSwitch && depth <= switchDepth && !(token.kind === "operator" && token.value === "{"))
        insideSwitch = false;
      i++;
    }
  }

  private checkStatements(
    doc: WorkspaceDocument,
    push: (offset: number, length: number, severity: Diagnostic["severity"], message: string, code: string) => void,
  ): void {
    const { binding } = doc;
    const scopeAt = (offset: number): Scope => {
      let best: Scope = binding.module;
      for (const scope of binding.scopes) {
        if (scope.kind === "module") continue;
        if (offset >= scope.start && offset < scope.end && scope.start >= best.start) best = scope;
      }
      return best;
    };
    // Loop tracking via block nesting: a `break`/`continue` needs an enclosing
    // for/while block within the same function.
    const loopBlocks: Array<{ start: number; end: number }> = [];
    const tokens = binding.tokens;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.kind === "keyword" && (t.value === "for" || t.value === "while")) {
        // body is the first depth-0 `{` after the header
        let d = 0;
        for (let k = i + 1; k < tokens.length; k++) {
          const u = tokens[k];
          if (u.kind === "operator") {
            if (u.value === "(" || u.value === "[") d++;
            else if (u.value === ")" || u.value === "]") d--;
            else if (u.value === "{" && d <= 0) {
              const block = binding.blocks.find((b) => b.open === u.offset);
              if (block !== undefined) loopBlocks.push({ start: block.open, end: block.close });
              break;
            }
          }
          if (u.kind === "newline" && d <= 0) break;
        }
      }
    }
    for (const t of tokens) {
      if (t.kind !== "keyword") continue;
      if (t.value === "return" || t.value === "yield") {
        const scope = scopeAt(t.offset);
        if (scope.kind === "module" || scope.kind === "class")
          push(t.offset, t.length, 1, `'${t.value}' outside function`, "return-outside-function");
      } else if (t.value === "await") {
        // allowed anywhere the runtime accepts it; no static check.
      } else if (t.value === "break" || t.value === "continue") {
        const scope = scopeAt(t.offset);
        const inLoop = loopBlocks.some(
          (loop) => t.offset > loop.start && t.offset < loop.end && loop.start >= scope.start,
        );
        if (!inLoop) push(t.offset, t.length, 1, `'${t.value}' outside loop`, "break-outside-loop");
      }
    }
  }

  private checkImports(
    doc: WorkspaceDocument,
    push: (offset: number, length: number, severity: Diagnostic["severity"], message: string, code: string) => void,
  ): void {
    for (const record of doc.binding.imports) {
      const root = record.module.split(".")[0];
      const isBuiltin = BUILTIN_MODULES[record.module] !== undefined || BUILTIN_MODULES[root] !== undefined;
      const file = this.workspace.resolveModuleFile(record.module, doc.filePath);
      if (!isBuiltin && file === undefined && this.workspace.resolveModule(record.module) === undefined) {
        push(record.moduleOffset, record.moduleLength, 1, `Cannot resolve module '${record.module}'`, "unresolved-import");
        continue;
      }
      if (!record.fromImport) continue;
      if (BUILTIN_MODULES[record.module] !== undefined) {
        const known = BUILTIN_MODULES[record.module];
        for (const member of record.members) {
          if (known[member.name] === undefined)
            push(member.offset, member.length, 2, `'${member.name}' is not a member of module '${record.module}'`, "unknown-member");
        }
      } else if (file !== undefined) {
        const target = this.workspace.loadByPath(file);
        if (target === undefined) continue;
        for (const member of record.members) {
          const sym = target.binding.module.symbols.get(member.name);
          if (sym === undefined && !fs.existsSync(file.replace(/__init__\.thm$/, `${member.name}.thm`)) &&
            !target.binding.imports.some((r) => r.star))
            push(member.offset, member.length, 2, `'${member.name}' is not defined in module '${record.module}'`, "unknown-member");
        }
      }
    }
  }

  // ------------------------------------------------------------ code actions

  /** Find an exported workspace symbol for auto-import without loading arbitrary files. */
  private findWorkspaceExport(name: string, current: WorkspaceDocument): { module: string } | undefined {
    for (const file of this.workspace.listThmFiles()) {
      if (file === current.filePath || file.endsWith("/__init__.thm")) continue;
      const target = this.workspace.loadByPath(file);
      if (target === undefined) continue;
      const sym = target.binding.module.symbols.get(name);
      if (sym === undefined || sym.name.startsWith("_") || !["function", "class", "variable"].includes(sym.kind)) continue;
      const relative = file.slice(file.lastIndexOf("/") + 1).replace(/\.thm$/, "");
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(relative)) continue;
      return { module: relative };
    }
    return undefined;
  }

  codeActions(uri: string, range: LspRange, diagnostics: Diagnostic[]): unknown[] {
    const doc = this.docOf(uri);
    if (doc === undefined) return [];
    const actions: unknown[] = [];
    const wanted = diagnostics.length > 0 ? diagnostics : this.diagnostics(uri).filter((d) => overlaps(d.range, range));
    for (const diagnostic of wanted) {
      const data = diagnostic.data as { importModule?: string; importMember?: string; unusedImport?: string; insertText?: string; removeUnexpectedToken?: boolean } | undefined;
      if (data?.importModule !== undefined) {
        const statement = data.importMember !== undefined
          ? `from ${data.importModule} import ${data.importMember}\n`
          : `import ${data.importModule}\n`;
        actions.push({
          title: data.importMember !== undefined
            ? `Import '${data.importMember}' from '${data.importModule}'`
            : `Add 'import ${data.importModule}'`,
          kind: "quickfix",
          diagnostics: [diagnostic],
          isPreferred: true,
          edit: { changes: { [doc.uri]: [{ range: this.importInsertRange(doc), newText: statement }] } },
        });
      }
      if (data?.insertText !== undefined) {
        actions.push({ title: `Insert '${data.insertText}'`, kind: "quickfix", diagnostics: [diagnostic], isPreferred: true,
          edit: { changes: { [doc.uri]: [{ range: { start: diagnostic.range.end, end: diagnostic.range.end }, newText: data.insertText }] } } });
      }
      if (data?.removeUnexpectedToken) {
        actions.push({ title: "Remove unexpected bracket", kind: "quickfix", diagnostics: [diagnostic],
          edit: { changes: { [doc.uri]: [{ range: diagnostic.range, newText: "" }] } } });
      }
      if (data?.unusedImport !== undefined) {
        const edit = this.removeImportEdit(doc, data.unusedImport);
        if (edit !== undefined)
          actions.push({
            title: `Remove unused import '${data.unusedImport}'`,
            kind: "quickfix",
            diagnostics: [diagnostic],
            edit: { changes: { [doc.uri]: [edit] } },
          });
      }
      if (diagnostic.code === "unused-import") continue;
    }
    // Organize imports: drop every unused import in one edit.
    const unused = this.diagnostics(uri).filter((d) => d.code === "unused-import");
    if (unused.length > 1) {
      const edits = unused
        .map((d) => this.removeImportEdit(doc, (d.data as { unusedImport: string }).unusedImport))
        .filter((e): e is { range: LspRange; newText: string } => e !== undefined);
      if (edits.length > 0)
        actions.push({
          title: "Remove all unused imports",
          kind: "source.organizeImports",
          edit: { changes: { [doc.uri]: edits } },
        });
    }

    // Selection-based refactorings. Keep edits conservative: only extract a
    // single-line expression/statement or a complete multi-line selection.
    const startOffset = doc.lines.offsetAt(range.start.line, range.start.character);
    const endOffset = doc.lines.offsetAt(range.end.line, range.end.character);
    if (endOffset > startOffset) {
      const selected = doc.text.slice(startOffset, endOffset);
      const lineStart = doc.text.lastIndexOf("\n", Math.max(0, startOffset - 1)) + 1;
      const prefix = doc.text.slice(lineStart, startOffset);
      const indent = /^[ \t]*/.exec(doc.text.slice(lineStart))?.[0] ?? "";
      if (!selected.includes("\n") && !selected.trim().endsWith(";") && !/^\s*$/.test(selected)) {
        const name = "extracted_value";
        actions.push({
          title: "Extract Variable",
          kind: "refactor.extract",
          edit: { changes: { [doc.uri]: [
            { range, newText: name },
            { range: doc.lines.rangeOf(lineStart, lineStart), newText: `${indent}${name} = ${selected}\n` },
          ] } },
        });
      }
      if (selected.includes("\n") && /^\s*$/.test(prefix)) {
        const bodyIndent = /^[ \t]*/.exec(selected)?.[0] ?? "";
        const body = selected.split("\n").map((line) => line.startsWith(bodyIndent) ? line.slice(bodyIndent.length) : line).join("\n");
        const fnName = "extracted_function";
        actions.push({
          title: "Extract Function",
          kind: "refactor.extract",
          edit: { changes: { [doc.uri]: [
            { range, newText: `${fnName}()` },
            { range: doc.lines.rangeOf(lineStart, lineStart), newText: `${indent}def ${fnName}() do{\n${body}\n${indent}}\n` },
          ] } },
        });
      }
    }
    return actions;
  }

  private importInsertRange(doc: WorkspaceDocument): LspRange {
    const last = [...doc.binding.imports].sort((a, b) => b.offset - a.offset)[0];
    const line = last === undefined ? 0 : doc.lines.positionAt(last.endOffset).line + 1;
    return { start: { line, character: 0 }, end: { line, character: 0 } };
  }

  private removeImportEdit(doc: WorkspaceDocument, name: string): { range: LspRange; newText: string } | undefined {
    const record = doc.binding.imports.find((candidate) =>
      candidate.fromImport
        ? candidate.members.some((m) => (m.alias ?? m.name) === name)
        : (candidate.alias ?? candidate.module.split(".")[0]) === name,
    );
    if (record === undefined) return undefined;
    const startLine = doc.lines.positionAt(record.offset).line;
    const endLine = doc.lines.positionAt(record.endOffset).line;
    if (record.fromImport && record.members.length > 1) {
      const member = record.members.find((m) => (m.alias ?? m.name) === name)!;
      let start = member.offset;
      let end = member.offset + member.length;
      const after = /^\s*as\s+\w+/.exec(doc.text.slice(end));
      if (after !== null) end += after[0].length;
      const trailing = /^\s*,\s*/.exec(doc.text.slice(end));
      if (trailing !== null) end += trailing[0].length;
      else {
        const leading = /,\s*$/.exec(doc.text.slice(0, start));
        if (leading !== null) start -= leading[0].length;
      }
      return { range: doc.lines.rangeOf(start, end - start), newText: "" };
    }
    return {
      range: { start: { line: startLine, character: 0 }, end: { line: endLine + 1, character: 0 } },
      newText: "",
    };
  }

  // -------------------------------------------------------- completion helpers

  /** Symbols visible at a position (innermost scope first), for completion. */
  visibleSymbols(uri: string, position: LspPosition): Sym[] {
    const doc = this.docOf(uri);
    if (doc === undefined) return [];
    const offset = doc.lines.offsetAt(position.line, position.character);
    let scope: Scope = doc.binding.module;
    for (const candidate of doc.binding.scopes) {
      if (candidate.kind === "module") continue;
      if (offset > candidate.start && offset <= candidate.end && candidate.start >= scope.start) scope = candidate;
    }
    const out: Sym[] = [];
    const seen = new Set<string>();
    let cursor: Scope | undefined = scope;
    let first = true;
    while (cursor !== undefined) {
      if (cursor.kind !== "class" || first) {
        for (const sym of cursor.symbols.values()) {
          if (seen.has(sym.name)) continue;
          seen.add(sym.name);
          out.push(sym);
        }
      }
      first = false;
      cursor = cursor.parent;
    }
    return out;
  }

  autoImportPosition(uri: string): LspPosition {
    const doc = this.docOf(uri);
    if (doc === undefined) return { line: 0, character: 0 };
    const last = [...doc.binding.imports].sort((a, b) => b.offset - a.offset)[0];
    const line = last === undefined ? 0 : doc.lines.positionAt(last.endOffset).line + 1;
    return { line, character: 0 };
  }

  /** Workspace exports suitable for completion with an import text edit. */
  autoImportCompletions(prefix: string, currentUri: string): Array<{ name: string; module: string; kind: Sym["kind"]; detail?: string }> {
    const current = this.docOf(currentUri);
    if (current === undefined) return [];
    const results: Array<{ name: string; module: string; kind: Sym["kind"]; detail?: string }> = [];
    const seen = new Set<string>();
    for (const file of this.workspace.listThmFiles()) {
      if (file === current.filePath || file.endsWith("/__init__.thm")) continue;
      const target = this.workspace.loadByPath(file);
      if (target === undefined) continue;
      const module = file.slice(file.lastIndexOf("/") + 1).replace(/\.thm$/, "");
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(module)) continue;
      for (const sym of target.binding.module.symbols.values()) {
        if (sym.name.startsWith("_") || !sym.name.toLowerCase().startsWith(prefix.toLowerCase())) continue;
        if (!["function", "class", "variable"].includes(sym.kind) || seen.has(sym.name)) continue;
        seen.add(sym.name);
        results.push({ name: sym.name, module, kind: sym.kind, detail: sym.detail ?? sym.annotation });
        if (results.length >= 80) return results;
      }
    }
    return results;
  }

  /** Members completable after `receiver.` — class members or module exports. */
  membersOf(uri: string, position: LspPosition, receiver: string): Array<{ name: string; kind: Sym["kind"]; detail?: string; doc?: string }> | undefined {
    const doc = this.docOf(uri);
    if (doc === undefined) return undefined;
    const offset = doc.lines.offsetAt(position.line, position.character);
    let scope: Scope = doc.binding.module;
    for (const candidate of doc.binding.scopes) {
      if (candidate.kind === "module") continue;
      if (offset > candidate.start && offset <= candidate.end && candidate.start >= scope.start) scope = candidate;
    }
    const sym = this.lookup(scope, receiver, doc.binding.module);
    if (sym === undefined) return undefined;
    if (sym.kind === "import" && sym.module !== undefined) {
      const file = this.workspace.resolveModuleFile(sym.module, doc.filePath);
      if (file === undefined) return undefined;
      const target = this.workspace.loadByPath(file);
      if (target === undefined) return undefined;
      return [...target.binding.module.symbols.values()]
        .filter((s) => !s.name.startsWith("_") && s.kind !== "parameter")
        .map((s) => ({ name: s.name, kind: s.kind, detail: s.detail, doc: s.doc }));
    }
    const cls = this.inferClass(doc, sym, offset);
    if (cls === undefined) return undefined;
    const members: Array<{ name: string; kind: Sym["kind"]; detail?: string; doc?: string }> = [];
    const seen = new Set<string>();
    for (const current of this.classMro(doc, cls)) {
      const classScope = this.classScopeOf(this.documentForSymbol(current, doc), current);
      for (const member of classScope?.symbols.values() ?? []) {
        if (seen.has(member.name)) continue;
        seen.add(member.name);
        members.push({ name: member.name, kind: member.kind, detail: member.detail, doc: member.doc });
      }
    }
    return members;
  }
}

function fileStart(file: string): Location {
  return { uri: pathToUri(file), range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } };
}

function overlaps(a: LspRange, b: LspRange): boolean {
  const before = (x: LspPosition, y: LspPosition): boolean => x.line < y.line || (x.line === y.line && x.character <= y.character);
  return before(a.start, b.end) && before(b.start, a.end);
}

export { LineIndex };
