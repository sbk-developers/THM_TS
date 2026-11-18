/**
 * Language feature providers over the analyzer, workspace, and built-in info:
 * completion (with snippet detail and kwarg awareness), hover, go-to-definition,
 * find references, rename, document/workspace symbols, signature help, and
 * lightweight diagnostics.
 */

import {
  analyze,
  type Definition,
  type DocumentAnalysis,
  type ParameterInfo,
} from "./analyzer.js";
import {
  BUILTIN_MODULES,
  GLOBAL_FUNCTIONS,
  GLOBAL_SIGNATURES,
  GLOBAL_TYPES,
  KEYWORD_HELP,
  MODULE_DESCRIPTIONS,
  TYPE_MEMBERS,
} from "./builtins-info.js";
import { existsSync as fsExistsSync } from "fs";
import { KEYWORDS, tokenize } from "./lexer.js";
import { offsetToPosition } from "./positions.js";
import { pathToUri, type Workspace } from "./workspace.js";

export interface CompletionItem {
  label: string;
  kind: number; // LSP CompletionItemKind
  detail?: string;
  documentation?: string;
  insertText?: string;
  insertTextFormat?: 1 | 2; // 1 = plaintext, 2 = snippet
  sortText?: string;
  data?: { name: string; origin: string };
  filterText?: string;
  commitCharacters?: string[];
}

export const COMPLETION_KIND = {
  Text: 1,
  Method: 2,
  Function: 3,
  Constructor: 4,
  Field: 5,
  Variable: 6,
  Class: 7,
  Module: 9,
  Property: 10,
  Unit: 11,
  Value: 12,
  Enum: 13,
  Keyword: 14,
  Snippet: 15,
  Struct: 22,
  Event: 23,
  Operator: 24,
  TypeParameter: 25,
} as const;

/** Signature-help payload. */
export interface SignatureHelpInfo {
  activeSignature: number;
  activeParameter: number;
  signature: {
    label: string;
    parameters: Array<{ label: string }>;
    documentation: string;
  } | null;
}

export class FeatureProvider {
  constructor(private readonly workspace: Workspace) {}

  // ------------------------------------------------------------------ helpers

  private analysisOf(uri: string): {
    text: string;
    analysis: DocumentAnalysis;
  } {
    const document = this.workspace.get(uri);
    const text = document?.text ?? "";
    return { text, analysis: analyze(text) };
  }

  /** Word at an offset, plus whether the cursor sits inside its trailing space. */
  private wordAt(
    text: string,
    offset: number,
  ): { word: string; start: number; end: number } {
    const isWordChar = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
    let start = Math.min(offset, text.length);
    while (start > 0 && isWordChar(text[start - 1])) start--;
    let end = offset;
    while (end < text.length && isWordChar(text[end])) end++;
    return { word: text.slice(start, end), start, end };
  }

  /** Get the dotted receiver chain ending at the token before `offset`. */
  private receiverChain(text: string, offset: number): string[] {
    const before = text.slice(0, offset);
    const match = /([A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)*)\.(\w*)$/.exec(before);
    if (match === null) return [];
    return match[1].split(".").map((part) => part.trim());
  }

  /**
   * Get the receiver chain when cursor is in a member access (e.g., typing `m.sqrt|`).
   * Finds the last dot before the cursor and returns the receiver parts.
   */
  private receiverChainAtDot(text: string, offset: number): {
    parts: string[];
    partialMember: string;
  } | null {
    const before = text.slice(0, offset);
    // Find the last dot before the cursor
    const lastDotIndex = before.lastIndexOf(".");
    if (lastDotIndex === -1) return null;

    // Get the text before the last dot to extract the receiver chain
    const beforeDot = before.slice(0, lastDotIndex);
    const match = /([A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)*)$/.exec(beforeDot);
    if (match === null) return null;

    const parts = match[1].split(".").map((part) => part.trim());
    // Get the partial member after the last dot
    const partialMember = before.slice(lastDotIndex + 1);
    return { parts, partialMember };
  }

  /** True when offset is directly after `from <module> import ` (or partially typed member). */
  private importMemberContext(
    text: string,
    offset: number,
  ): string | undefined {
    const before = text.slice(0, offset);
    const match =
      /(?:^|\n)\s*from\s+([A-Za-z_.][\w.]*)\s+import\s+(?:as\s+)?([\w, ]*)$/.exec(
        before,
      );
    if (match === null) return undefined;
    return match[1];
  }

  /** True when offset is directly after `import `. */
  private importModuleContext(text: string, offset: number): boolean {
    const before = text.slice(0, offset);
    return /(?:^|\n)\s*(?:import\s+|from\s+)[\w.]*$/.test(before);
  }

  /** Locate an enclosing call `callee(...<CURSOR>` and count prior arguments. */
  private enclosingCall(
    text: string,
    offset: number,
  ): { callee: string; argumentIndex: number } | undefined {
    const before = text.slice(0, offset);
    let depth = 0;
    let calleeStart = -1;
    let calleeEnd = -1;
    let inString = false;
    let stringQuote = "";
    let escapeNext = false;

    // Scan backwards to find the innermost unclosed '('
    for (let i = before.length - 1; i >= 0; i--) {
      const ch = before[i];
      const nextCh = before[i + 1] ?? "";

      // Handle string literals (simplified)
      if (!inString && (ch === '"' || ch === "'")) {
        // Check for triple quotes
        if (i >= 2 && before[i - 2] === ch && before[i - 1] === ch) {
          inString = true;
          stringQuote = ch.repeat(3);
          i -= 2;
        } else {
          inString = true;
          stringQuote = ch;
        }
        continue;
      }
      if (inString) {
        if (escapeNext) {
          escapeNext = false;
        } else if (ch === "\\") {
          escapeNext = true;
        } else if (
          (stringQuote.length === 1 && ch === stringQuote) ||
          (stringQuote.length === 3 &&
            i >= 2 &&
            before[i - 2] === ch &&
            before[i - 1] === ch &&
            ch === stringQuote[0])
        ) {
          inString = false;
          if (stringQuote.length === 3) i -= 2;
        }
        continue;
      }

      if (ch === ")" || ch === "]" || ch === "}") {
        depth++;
      } else if (ch === "(" || ch === "[" || ch === "{") {
        depth--;
        if (depth === 0) {
          // Found the matching opening bracket
          // Look backwards for the callee name
          let j = i - 1;
          while (j >= 0 && /\s/.test(before[j])) j--;
          calleeEnd = j + 1;
          while (j >= 0 && /[A-Za-z0-9_.]/.test(before[j])) j--;
          calleeStart = j + 1;
          break;
        }
      }
    }

    if (calleeStart === -1 || calleeEnd === -1) return undefined;

    const callee = before.slice(calleeStart, calleeEnd);
    // Now count arguments inside this call
    const argumentPart = before.slice(calleeEnd + 1); // skip the '('
    let argDepth = 0;
    let argumentIndex = 0;
    let inStr = false;
    let strQuote = "";
    let escNext = false;

    for (const ch of argumentPart) {
      if (!inStr && (ch === '"' || ch === "'")) {
        inStr = true;
        strQuote = ch;
        continue;
      }
      if (inStr) {
        if (escNext) escNext = false;
        else if (ch === "\\") escNext = true;
        else if (ch === strQuote) inStr = false;
        continue;
      }

      if (ch === "(" || ch === "[" || ch === "{") argDepth++;
      else if (ch === ")" || ch === "]" || ch === "}") argDepth--;
      else if (ch === "," && argDepth === 0) argumentIndex++;
    }

    return { callee, argumentIndex };
  }

  // --------------------------------------------------------------- completion

  /** Build editor-friendly call snippets while preserving optional/variadic args. */
  private functionSnippet(name: string, parameters?: ParameterInfo[]): string {
    if (!parameters || parameters.length === 0) return `${name}($0)`;
    const required = parameters.filter((p) => !p.hasDefault && p.kind !== "kwarg");
    const chosen = required.length > 0 ? required : parameters.slice(0, 1);
    const args = chosen.map((p, i) => {
      const label = p.kind === "vararg" ? `*${p.name}` : p.kind === "kwarg" ? `**${p.name}` : p.name;
      return `\${${i + 1}:${label}}`;
    });
    return `${name}(${args.join(", ")})$0`;
  }

  completion(uri: string, line: number, character: number): CompletionItem[] {
    const { text } = this.analysisOf(uri);
    const { lineText } = this.lineAt(text, line);
    const offset = this.offsetAt(text, line, character);
    const items: CompletionItem[] = [];

    // 1. Import contexts.
    const memberOf = this.importMemberContext(text, offset);
    if (memberOf !== undefined) {
      return this.completionForModuleMembers(memberOf);
    }
    if (this.importModuleContext(text, offset)) {
      return this.completionForModules();
    }

    // 2. Member completion `receiver.`.
    const receiverParts = this.receiverChain(text, offset);
    if (receiverParts.length > 0) {
      return this.completionForMember(receiverParts, uri);
    }

    const prefix = this.wordAt(text, offset).word;

    // 3. Keywords.
    for (const keyword of KEYWORDS) {
      items.push({
        label: keyword,
        kind: COMPLETION_KIND.Keyword,
        detail: KEYWORD_HELP[keyword],
        documentation: KEYWORD_HELP[keyword],
        sortText: `3_${keyword}`,
      });
    }

    // 4. Literals.
    for (const literal of ["true", "false", "none"]) {
      items.push({
        label: literal,
        kind: COMPLETION_KIND.Keyword,
        sortText: `3_${literal}`,
      });
    }

    // 5. Global built-in functions.
    for (const [name, signature] of Object.entries(GLOBAL_FUNCTIONS)) {
      items.push({
        label: name,
        kind: COMPLETION_KIND.Function,
        detail: signature.split("—")[0].trim(),
        documentation: signature,
        insertText: name,
        insertTextFormat: 1,
        sortText: `1_${name}`,
      });
    }

    // 6. Types and exception classes.
    for (const [name, doc] of Object.entries(GLOBAL_TYPES)) {
      items.push({
        label: name,
        kind: COMPLETION_KIND.Class,
        detail: doc,
        documentation: doc,
        sortText: `1_${name}`,
      });
    }

    // 7. Built-in module names (prefixed when typed).
    for (const moduleName of Object.keys(BUILTIN_MODULES)) {
      items.push({
        label: moduleName,
        kind: COMPLETION_KIND.Module,
        detail: MODULE_DESCRIPTIONS[moduleName] ?? "",
        documentation: MODULE_DESCRIPTIONS[moduleName] ?? "",
        sortText: `2_${moduleName}`,
      });
    }

    // 8. Symbols from the current file and imported/open THM modules.
    const { analysis } = this.analysisOf(uri);
    const seen = new Set<string>();
    const pushSymbol = (definition: Definition, originUri: string): void => {
      if (seen.has(definition.name)) return;
      seen.add(definition.name);
      items.push({
        label: definition.name,
        kind:
          definition.kind === "function"
            ? COMPLETION_KIND.Function
            : definition.kind === "class"
              ? COMPLETION_KIND.Class
              : definition.kind === "variable"
                ? COMPLETION_KIND.Variable
                : COMPLETION_KIND.Struct,
        detail:
          definition.detail ??
          (definition.container !== undefined
            ? `${definition.container} member`
            : definition.kind),
        documentation: definition.detail,
        sortText: `0_${definition.name}`,
        data: { name: definition.name, origin: originUri },
        filterText: definition.name,
        insertText: definition.kind === "function"
          ? this.functionSnippet(definition.name, definition.parameters)
          : definition.name,
        insertTextFormat: definition.kind === "function" ? 2 : 1,
        commitCharacters: definition.kind === "function" ? ["("] : ["."],
      });
    };
    for (const definition of analysis.definitions) pushSymbol(definition, uri);
    for (const imported of analysis.imports) {
      const surface = this.workspace.resolveModule(imported.module);
      const moduleUri =
        surface !== undefined && !surface.path.startsWith("<")
          ? pathToUri(surface.path)
          : uri;
      if (imported.members.length > 0) {
        for (const member of imported.members) {
          const found = this.findMemberDefinition(surface, member.name);
          pushSymbol(
            {
              kind: found?.kind ?? "function",
              name: member.alias ?? member.name,
              line: member.column,
              column: member.column,
              length: member.name.length,
              detail: found?.detail ?? `${imported.module}.${member.name}`,
            },
            moduleUri,
          );
        }
      } else {
        const aliasName = imported.alias ?? imported.module.split(".")[0];
        const selfDefinition = {
          kind: "import" as const,
          name: aliasName,
          line: imported.line,
          column: 0,
          length: aliasName.length,
          detail: imported.fromImport
            ? `from ${imported.module}`
            : `import ${imported.module}`,
        };
        pushSymbol(selfDefinition, moduleUri);
      }
    }
    for (const [uriOther, document] of this.workspace.documents) {
      if (uriOther === uri) continue;
      for (const definition of document.definitions) {
        if (definition.container === undefined)
          pushSymbol(definition, uriOther);
      }
    }

    // 9. Module member shortcuts: `os.getcwd` style names when user typed prefix.
    void lineText;
    if (prefix.length > 0) {
      for (const [moduleName, members] of Object.entries(BUILTIN_MODULES)) {
        if (moduleName.startsWith(prefix)) continue; // handled above as module
        for (const memberName of Object.keys(members)) {
          if (!memberName.startsWith(prefix)) continue;
          items.push({
            label: memberName,
            kind: COMPLETION_KIND.Function,
            detail: members[memberName],
            documentation: members[memberName],
            sortText: `4_${memberName}`,
          });
        }
      }
    }

    return items;
  }

  private findMemberDefinition(
    surface: ReturnType<Workspace["resolveModule"]>,
    memberName: string,
  ): Definition | undefined {
    if (surface === undefined) return undefined;
    const member = surface.members.find(
      (candidate) => candidate.name === memberName,
    );
    if (member === undefined) return undefined;
    return {
      kind: member.kind,
      name: member.name,
      line: 0,
      column: 0,
      length: member.name.length,
      detail: member.detail,
    };
  }

  /** Members of a built-in or workspace module after `from module import `. */
  private completionForModuleMembers(moduleName: string): CompletionItem[] {
    const items: CompletionItem[] = [];
    const surface = this.workspace.resolveModule(moduleName);
    if (surface !== undefined) {
      for (const member of surface.members) {
        items.push({
          label: member.name,
          kind:
            member.kind === "class"
              ? COMPLETION_KIND.Class
              : member.kind === "function"
                ? COMPLETION_KIND.Function
                : COMPLETION_KIND.Value,
          detail: member.detail ?? member.kind,
          sortText: `0_${member.name}`,
        });
      }
    }
    const builtinMembers = BUILTIN_MODULES[moduleName.split(".")[0]];
    if (builtinMembers !== undefined) {
      for (const [memberName, doc] of Object.entries(builtinMembers)) {
        if (items.some((item) => item.label === memberName)) continue;
        const isValue = !doc.includes("(");
        items.push({
          label: memberName,
          kind: isValue ? COMPLETION_KIND.Value : COMPLETION_KIND.Function,
          detail: doc,
          documentation: doc,
          sortText: `0_${memberName}`,
        });
      }
    }
    return items;
  }

  /** All importable modules for `import <CURSOR>` contexts. */
  private completionForModules(): CompletionItem[] {
    const items: CompletionItem[] = [];
    for (const [moduleName, description] of Object.entries(
      MODULE_DESCRIPTIONS,
    )) {
      items.push({
        label: moduleName,
        kind: COMPLETION_KIND.Module,
        detail: `[built-in] ${description}`,
        documentation: description,
        sortText: `0_${moduleName}`,
      });
    }
    for (const surface of this.workspace.discoverModules()) {
      if (MODULE_DESCRIPTIONS[surface.name] !== undefined) continue;
      items.push({
        label: surface.name,
        kind: COMPLETION_KIND.Module,
        detail:
          surface.kind === "package"
            ? `[package] ${surface.path}`
            : `[module] ${surface.path}`,
        documentation: surface.members.map((member) => member.name).join(", "),
        sortText: `1_${surface.name}`,
      });
    }
    return items;
  }

  /** Members after a `.` — based on the receiver chain. */
  private completionForMember(
    receiverParts: string[],
    uri: string,
  ): CompletionItem[] {
    const items: CompletionItem[] = [];
    const addMember = (name: string, doc: string, kind: number): void => {
      if (items.some((item) => item.label === name)) return;
      items.push({
        label: name,
        kind,
        detail: doc,
        documentation: doc,
        sortText: `0_${name}`,
      });
    };

    const receiverName = receiverParts[receiverParts.length - 1];

    // Module member: `os.` / `math.` / imported module alias.
    const { analysis } = this.analysisOf(uri);
    const imported = analysis.imports.find(
      (entry) => (entry.alias ?? entry.module.split(".")[0]) === receiverName,
    );
    if (imported !== undefined) {
      this.completionForModuleMembers(imported.module).forEach((item) =>
        items.push(item),
      );
      const surface = this.workspace.resolveModule(imported.module);
      if (surface !== undefined) {
        for (const member of surface.members) {
          addMember(
            member.name,
            member.detail ?? member.kind,
            member.kind === "class"
              ? COMPLETION_KIND.Class
              : COMPLETION_KIND.Function,
          );
        }
      }
      return items;
    }

    // Built-in type members: `"abc".upper()` / `[1].append()`.
    for (const typeName of Object.keys(TYPE_MEMBERS)) {
      if (typeName === receiverName) {
        for (const [memberName, doc] of Object.entries(
          TYPE_MEMBERS[typeName],
        )) {
          addMember(memberName, doc, COMPLETION_KIND.Method);
        }
      }
    }

    // Instances: find variable assignment `x = TypeName(...)` in the file.
    const { text } = this.analysisOf(uri);
    const constructorCall = /(\w+)\s*=\s*([A-Z]\w*)\s*\(/.exec(text);
    if (constructorCall !== null && constructorCall[1] === receiverName) {
      const typeName = constructorCall[2];
      for (const [memberName, doc] of Object.entries(
        TYPE_MEMBERS[typeName] ?? {},
      )) {
        addMember(memberName, doc, COMPLETION_KIND.Method);
      }
      // Instance methods from the class definition in any open document.
      for (const [, document] of this.workspace.documents) {
        const classPattern = new RegExp(
          `class\\s+${typeName}\\b[\\s\\S]*?(?=\\nclass\\b|$)`,
          "m",
        );
        const match = classPattern.exec(document.text);
        if (match === null) continue;
        const methodPattern = /def\s+(\w+)\s*\(([^)]*)\)/g;
        let methodMatch: RegExpExecArray | null;
        while ((methodMatch = methodPattern.exec(match[0])) !== null) {
          if (methodMatch[1] === "__init__") continue;
          const parameters = methodMatch[2]
            .split(",")
            .map((parameter) => parameter.trim())
            .filter(Boolean)
            .slice(1);
          addMember(
            methodMatch[1],
            `${methodMatch[1]}(${parameters.join(", ")}) — method of ${typeName}`,
            COMPLETION_KIND.Method,
          );
        }
      }
      return items;
    }

    // Classes' static members: `Dog.speak`? Infer class name receivers.
    for (const [, document] of this.workspace.documents) {
      const classPattern = new RegExp(
        `class\\s+${receiverName}\\b[\\s\\S]*?(?=\\nclass\\b|$)`,
        "m",
      );
      const match = classPattern.exec(document.text);
      if (match === null) continue;
      const methodPattern = /def\s+(\w+)\s*\(([^)]*)\)/g;
      let methodMatch: RegExpExecArray | null;
      while ((methodMatch = methodPattern.exec(match[0])) !== null) {
        const parameters = methodMatch[2]
          .split(",")
          .map((parameter) => parameter.trim())
          .filter(Boolean);
        addMember(
          methodMatch[1],
          `${methodMatch[1]}(${parameters.join(", ")})`,
          COMPLETION_KIND.Method,
        );
      }
    }

    // Fall back: built-in module members with matching prefix.
    const builtin = BUILTIN_MODULES[receiverName];
    if (builtin !== undefined) {
      for (const [memberName, doc] of Object.entries(builtin))
        addMember(memberName, doc, COMPLETION_KIND.Function);
    }
    return items;
  }

  // -------------------------------------------------------------- goto/refs

  /** Resolve the definition location for the symbol at the position. */
  definition(
    uri: string,
    line: number,
    character: number,
  ): Array<{ uri: string; line: number; character: number }> {
    const { text, analysis } = this.analysisOf(uri);
    const offset = this.offsetAt(text, line, character);
    const { word, start } = this.wordAt(text, offset);
    if (word === "") return [];

    // Attribute on a known module alias resolves into the module file.
    const receiverChain = this.receiverChain(text, start + word.length + 1);
    if (receiverChain.length > 0) {
      const aliasName = receiverChain[0];
      const imported = analysis.imports.find(
        (entry) => (entry.alias ?? entry.module.split(".")[0]) === aliasName,
      );
      if (imported !== undefined) {
        const surface = this.workspace.resolveModule(imported.module);
        const found = this.findMemberDefinition(surface, word);
        if (
          found !== undefined &&
          surface !== undefined &&
          !surface.path.startsWith("<")
        ) {
          return [{ uri: pathToUri(surface.path), line: 0, character: 0 }];
        }
      }
    }

    const local = analysis.definitions.find(
      (definition) =>
        definition.name === word && definition.kind !== "variable",
    );
    if (local !== undefined) {
      return [{ uri, line: local.line, character: local.column }];
    }

    // Imported name resolves into the module file.
    for (const imported of analysis.imports) {
      if (
        imported.members.some(
          (member) => (member.alias ?? member.name) === word,
        )
      ) {
        const surface = this.workspace.resolveModule(imported.module);
        if (surface !== undefined && !surface.path.startsWith("<")) {
          return [{ uri: pathToUri(surface.path), line: 0, character: 0 }];
        }
      }
      if ((imported.alias ?? imported.module.split(".")[0]) === word) {
        const surface = this.workspace.resolveModule(imported.module);
        if (surface !== undefined && !surface.path.startsWith("<")) {
          return [{ uri: pathToUri(surface.path), line: 0, character: 0 }];
        }
      }
    }

    // Cross-file search.
    const matches = this.workspace.findDefinition(word, uri);
    return matches.map((match) => ({
      uri: match.uri,
      line: match.definition.line,
      character: match.definition.column,
    }));
  }

  /** All references to the symbol, optionally including its declaration. */
  references(
    uri: string,
    line: number,
    character: number,
    includeDeclaration: boolean,
  ): Array<{ uri: string; line: number; character: number }> {
    const { text, analysis } = this.analysisOf(uri);
    const offset = this.offsetAt(text, line, character);
    const { word } = this.wordAt(text, offset);
    if (word === "") return [];
    const results: Array<{ uri: string; line: number; character: number }> = [];
    if (includeDeclaration) {
      const declaration = analysis.definitions.find(
        (definition) => definition.name === word,
      );
      if (declaration !== undefined)
        results.push({
          uri,
          line: declaration.line,
          character: declaration.column,
        });
    }
    for (const reference of analysis.references) {
      if (reference.name === word)
        results.push({
          uri,
          line: reference.line,
          character: reference.column,
        });
    }
    for (const [otherUri, document] of this.workspace.documents) {
      if (otherUri === uri) continue;
      const other = analyze(document.text);
      for (const reference of other.references) {
        if (reference.name === word)
          results.push({
            uri: otherUri,
            line: reference.line,
            character: reference.column,
          });
      }
    }
    return results;
  }

  /** Rename: workspace edits covering declaration and references in-file. */
  rename(
    uri: string,
    line: number,
    character: number,
    newName: string,
  ): {
    changes: Record<
      string,
      Array<{
        line: number;
        character: number;
        newLine: number;
        newCharacter: number;
      }>
    >;
  } | null {
    if (!/^[A-Za-z_]\w*$/.test(newName)) return null;
    const locations = this.references(uri, line, character, true);
    if (locations.length === 0) return null;
    const changes: Record<
      string,
      Array<{
        line: number;
        character: number;
        newLine: number;
        newCharacter: number;
      }>
    > = {};
    for (const location of locations) {
      const entry = {
        line: location.line,
        character: location.character,
        newLine: location.line,
        newCharacter: location.character,
      };
      (changes[location.uri] ??= []).push(entry);
    }
    return { changes };
  }

  // ------------------------------------------------------------------- hover

  hover(
    uri: string,
    line: number,
    character: number,
  ): { contents: string; range?: { start: number; end: number } } | null {
    const { text, analysis } = this.analysisOf(uri);
    const offset = this.offsetAt(text, line, character);
    const { word, start } = this.wordAt(text, offset);
    if (word === "") return null;

    // Local definition.
    const local = analysis.definitions.find(
      (definition) =>
        definition.name === word && definition.kind !== "variable",
    );
    if (local !== undefined) {
      const header = local.detail ?? `${local.kind} ${word}`;
      return {
        contents: `thm\n${header}${local.container !== undefined ? `\n(in ${local.container})` : ""}`,
      };
    }

    // Module alias hover.
    const imported = analysis.imports.find(
      (entry) => (entry.alias ?? entry.module.split(".")[0]) === word,
    );
    if (imported !== undefined) {
      const surface = this.workspace.resolveModule(imported.module);
      const memberList =
        surface !== undefined
          ? surface.members.map((member) => member.name).join(", ")
          : "";
      const description =
        MODULE_DESCRIPTIONS[word] ??
        (memberList !== "" ? `Members: ${memberList}` : imported.module);
      return { contents: `thm\nmodule ${imported.module}\n${description}` };
    }

    if (GLOBAL_FUNCTIONS[word] !== undefined)
      return { contents: `thm\n${GLOBAL_FUNCTIONS[word]}` };
    if (GLOBAL_TYPES[word] !== undefined)
      return { contents: `thm\n${GLOBAL_TYPES[word]}` };
    if (KEYWORD_HELP[word] !== undefined)
      return { contents: `thm\nkeyword ${word}\n${KEYWORD_HELP[word]}` };
    if (BUILTIN_MODULES[word] !== undefined) {
      return {
        contents: `thm\nmodule ${word}\n${MODULE_DESCRIPTIONS[word] ?? ""}`,
      };
    }
    void start;
    return null;
  }

  // ----------------------------------------------------------------- symbols

  documentSymbols(
    uri: string,
  ): Array<{
    name: string;
    kind: number;
    range: { line: number; character: number };
    container?: string;
    detail?: string;
  }> {
    const { analysis } = this.analysisOf(uri);
    const kindFor = (definition: Definition): number => {
      switch (definition.kind) {
        case "function":
          return 12; // Function
        case "class":
          return 5; // Class
        case "variable":
          return 13; // Variable
        case "import":
        case "importMember":
          return 9; // Module
        default:
          return 13;
      }
    };
    return analysis.definitions.map((definition) => ({
      name: definition.name,
      kind: kindFor(definition),
      range: { line: definition.line, character: definition.column },
      container: definition.container,
      detail: definition.detail,
    }));
  }

  /** Flat search across open documents. */
  workspaceSymbols(
    query: string,
  ): Array<{
    uri: string;
    name: string;
    kind: number;
    line: number;
    character: number;
  }> {
    const results: Array<{
      uri: string;
      name: string;
      kind: number;
      line: number;
      character: number;
    }> = [];
    const lowerQuery = query.toLowerCase();
    for (const [uri, document] of this.workspace.documents) {
      for (const symbol of this.documentSymbols(uri)) {
        if (
          lowerQuery === "" ||
          symbol.name.toLowerCase().includes(lowerQuery)
        ) {
          results.push({
            uri,
            name: symbol.name,
            kind: symbol.kind,
            line: symbol.range.line,
            character: symbol.range.character,
          });
        }
      }
      void document;
    }
    return results;
  }

// --------------------------------------------------------- signature help

  signatureHelp(
    uri: string,
    line: number,
    character: number,
  ): SignatureHelpInfo {
    const { text, analysis } = this.analysisOf(uri);
    const offset = this.offsetAt(text, line, character);

    // If cursor is on a '(', we're at the start of a call - find the callee before it.
    if (offset < text.length && text[offset] === "(") {
      const beforeParen = text.slice(0, offset);
      const match = /([A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)*)\s*$/.exec(beforeParen);
      if (match !== null) {
        const callee = match[1].trim();
        return this.buildSignatureHelp({ callee, argumentIndex: 0 }, text, offset, analysis);
      }
    }

    // First, check if cursor is on a member access (e.g., m.sqrt| or obj.method|)
    // This takes precedence over enclosing call because the user is typing the callee.
    const memberAccess = this.memberAccessAtCursor(text, offset);
    if (memberAccess !== null) {
      const { receiverParts, memberName } = memberAccess;
      if (receiverParts.length > 0) {
        const receiverName = receiverParts[receiverParts.length - 1];
        // Check if receiver is a known module alias.
        const imported = analysis.imports.find(
          (entry) => (entry.alias ?? entry.module.split(".")[0]) === receiverName,
        );
        if (imported !== undefined) {
          const surface = this.workspace.resolveModule(imported.module);
          if (surface !== undefined) {
            const member = surface.members.find((m) => m.name === memberName);
            if (member !== undefined) {
              return this.signatureForMember(member, memberName);
            }
          }
          // Check built-in modules.
          const builtinMembers = BUILTIN_MODULES[imported.module.split(".")[0]];
          if (builtinMembers !== undefined && builtinMembers[memberName] !== undefined) {
            return this.signatureForBuiltinMember(memberName, builtinMembers[memberName]);
          }
        }
        // Check built-in type members (e.g., str.upper).
        const typeMembers = TYPE_MEMBERS[receiverName];
        if (typeMembers !== undefined && typeMembers[memberName] !== undefined) {
          return this.signatureForBuiltinMember(memberName, typeMembers[memberName]);
        }
      }
    }

    // Then check for enclosing call (after '(').
    const call = this.enclosingCall(text, offset);
    if (call !== undefined) {
      return this.buildSignatureHelp(call, text, offset, analysis);
    }

    // No enclosing call: check if the word at cursor is a known function.
    // This provides signature help while typing the function name (before '(').
    const { word } = this.wordAt(text, offset);
    if (word !== "") {
      // Check built-in globals.
      const builtin = GLOBAL_SIGNATURES[word];
      if (builtin !== undefined) {
        return {
          activeSignature: 0,
          activeParameter: 0,
          signature: {
            label: builtin.label,
            parameters: builtin.parameters.map((parameter) => ({
              label: parameter.label,
            })),
            documentation: builtin.documentation,
          },
        };
      }
      // Check user-defined functions.
      const userFunction = analysis.definitions.find(
        (definition) =>
          definition.name === word && definition.parameters !== undefined,
      );
      if (userFunction?.parameters !== undefined) {
        const labels = userFunction.parameters.map((parameter) =>
          parameter.kind === "vararg"
            ? `*${parameter.name}`
            : parameter.kind === "kwarg"
            ? `**${parameter.name}`
            : parameter.hasDefault
            ? `${parameter.name}=...`
            : parameter.name,
        );
        return {
          activeSignature: 0,
          activeParameter: 0,
          signature: {
            label: `${word}(${labels.join(", ")})`,
            parameters: labels.map((label) => ({ label })),
            documentation:
              userFunction.container !== undefined
                ? `method of ${userFunction.container}`
                : "",
          },
        };
      }
    }

    return { activeSignature: 0, activeParameter: 0, signature: null };
  }

  /**
   * Check if cursor is on a member access pattern (receiver.member|).
   * Returns the receiver parts and member name being typed.
   */
  private memberAccessAtCursor(
    text: string,
    offset: number,
  ): { receiverParts: string[]; memberName: string } | null {
    const before = text.slice(0, offset);
    // Find the last dot before the cursor
    const lastDotIndex = before.lastIndexOf(".");
    if (lastDotIndex === -1) return null;

    // Get the text before the last dot to extract the receiver chain
    const beforeDot = before.slice(0, lastDotIndex);
    const match = /([A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)*)$/.exec(beforeDot);
    if (match === null) return null;

    const receiverParts = match[1].split(".").map((part) => part.trim());
    // Get the full member name at cursor (not just partial after dot)
    const { word } = this.wordAt(text, offset);
    if (word === "") return null;
    return { receiverParts, memberName: word };
  }

  private buildSignatureHelp(
    call: { callee: string; argumentIndex: number },
    text: string,
    offset: number,
    analysis: DocumentAnalysis,
  ): SignatureHelpInfo {
    // Built-in signature.
    const builtin = GLOBAL_SIGNATURES[call.callee];
    if (builtin !== undefined) {
      return {
        activeSignature: 0,
        activeParameter: Math.min(
          call.argumentIndex,
          Math.max(0, builtin.parameters.length - 1),
        ),
        signature: {
          label: builtin.label,
          parameters: builtin.parameters.map((parameter: { label: string }) => ({
            label: parameter.label,
          })),
          documentation: builtin.documentation,
        },
      };
    }

    // User function signature.
    const userFunction = analysis.definitions.find(
      (definition: Definition) =>
        definition.name === call.callee && definition.parameters !== undefined,
    );
    if (userFunction?.parameters !== undefined) {
      const labels = userFunction.parameters.map((parameter: ParameterInfo) =>
        parameter.kind === "vararg"
          ? `*${parameter.name}`
          : parameter.kind === "kwarg"
          ? `**${parameter.name}`
          : parameter.hasDefault
          ? `${parameter.name}=...`
          : parameter.name,
      );
      const keywordNames = this.keywordArgumentsBefore(text, offset);
      let activeParameter = Math.min(
        call.argumentIndex,
        Math.max(0, labels.length - 1),
      );
      const typedName = keywordNames[keywordNames.length - 1];
      if (typedName !== undefined) {
        const match = labels.findIndex(
          (label: string) => label.replace(/^\*+|=...$/, "") === typedName,
        );
        if (match >= 0) activeParameter = match;
      }
      return {
        activeSignature: 0,
        activeParameter,
        signature: {
          label: `${call.callee}(${labels.join(", ")})`,
          parameters: labels.map((label: string) => ({ label })),
          documentation:
            userFunction.container !== undefined
              ? `method of ${userFunction.container}`
              : "",
        },
      };
    }
    return {
      activeSignature: 0,
      activeParameter: call.argumentIndex,
      signature: null,
    };
  }

  private signatureForMember(member: { name: string; kind: string; detail?: string }, name: string): SignatureHelpInfo {
    return {
      activeSignature: 0,
      activeParameter: 0,
      signature: {
        label: `${name}()`,
        parameters: [],
        documentation: member.detail ?? member.kind,
      },
    };
  }

  private signatureForBuiltinMember(name: string, doc: string): SignatureHelpInfo {
    const open = doc.indexOf("(");
    const close = doc.indexOf(")", open);
    const parameterText = open >= 0 && close > open ? doc.slice(open + 1, close) : "";
    const label = doc.split("—")[0].trim();
    return {
      activeSignature: 0,
      activeParameter: 0,
      signature: {
        label,
        parameters: parameterText
          .split(",")
          .map((part) => part.trim())
          .filter((part) => part !== "")
          .map((part) => ({
            label: part.replace(/^\*\*/, "**").replace(/^\*/, "*"),
          })),
        documentation: doc.slice(doc.indexOf("—") + 1).trim() || doc,
      },
    };
  }

  private keywordArgumentsBefore(text: string, offset: number): string[] {
    const before = text.slice(0, offset);
    let depth = 0;
    let calleeStart = -1;
    let calleeEnd = -1;
    let inString = false;
    let stringQuote = "";
    let escapeNext = false;

    // Scan backwards to find the innermost unclosed '('
    for (let i = before.length - 1; i >= 0; i--) {
      const ch = before[i];
      const nextCh = before[i + 1] ?? "";

      // Handle string literals (simplified)
      if (!inString && (ch === '"' || ch === "'")) {
        if (i >= 2 && before[i - 2] === ch && before[i - 1] === ch) {
          inString = true;
          stringQuote = ch.repeat(3);
          i -= 2;
        } else {
          inString = true;
          stringQuote = ch;
        }
        continue;
      }
      if (inString) {
        if (escapeNext) {
          escapeNext = false;
        } else if (ch === "\\") {
          escapeNext = true;
        } else if (
          (stringQuote.length === 1 && ch === stringQuote) ||
          (stringQuote.length === 3 &&
            i >= 2 &&
            before[i - 2] === ch &&
            before[i - 1] === ch &&
            ch === stringQuote[0])
        ) {
          inString = false;
          if (stringQuote.length === 3) i -= 2;
        }
        continue;
      }

      if (ch === ")" || ch === "]" || ch === "}") {
        depth++;
      } else if (ch === "(" || ch === "[" || ch === "{") {
        depth--;
        if (depth === 0) {
          // Found the matching opening bracket
          let j = i - 1;
          while (j >= 0 && /\s/.test(before[j])) j--;
          calleeEnd = j + 1;
          while (j >= 0 && /[A-Za-z0-9_.]/.test(before[j])) j--;
          calleeStart = j + 1;
          break;
        }
      }
    }

    if (calleeStart === -1 || calleeEnd === -1) return [];

    // Extract keyword arguments from the argument part
    const argumentPart = before.slice(calleeEnd + 1); // skip the '('
    const names: string[] = [];
    let argDepth = 0;
    let inStr = false;
    let strQuote = "";
    let escNext = false;
    let currentToken = "";
    let inKeyword = false;

    for (const ch of argumentPart) {
      if (!inStr && (ch === '"' || ch === "'")) {
        inStr = true;
        strQuote = ch;
        continue;
      }
      if (inStr) {
        if (escNext) escNext = false;
        else if (ch === "\\") escNext = true;
        else if (ch === strQuote) inStr = false;
        continue;
      }

      if (ch === "(" || ch === "[" || ch === "{") argDepth++;
      else if (ch === ")" || ch === "]" || ch === "}") argDepth--;

      if (argDepth === 0) {
        if (/[A-Za-z0-9_]/.test(ch)) {
          currentToken += ch;
          inKeyword = true;
        } else if (ch === "=" && inKeyword && currentToken.length > 0) {
          names.push(currentToken);
          currentToken = "";
          inKeyword = false;
        } else if (ch === ",") {
          currentToken = "";
          inKeyword = false;
        } else if (!/\s/.test(ch)) {
          currentToken = "";
          inKeyword = false;
        }
      }
    }

    return names;
  }

  /**
   * Kwarg-specific suggestions for a call: parameter names of the target
   * function that have not been used yet.
   */
  kwargSuggestions(uri: string, line: number, character: number): string[] {
    const { text, analysis } = this.analysisOf(uri);
    const offset = this.offsetAt(text, line, character);
    const call = this.enclosingCall(text, offset);
    if (call === undefined) return [];
    const used = new Set(this.keywordArgumentsBefore(text, offset));
    const target = analysis.definitions.find(
      (definition) =>
        definition.name === call.callee && definition.parameters !== undefined,
    );
    const suggestions: string[] = [];
    if (target?.parameters !== undefined) {
      for (const parameter of target.parameters) {
        if (parameter.kind === "kwarg" || parameter.kind === "vararg") continue;
        if (!used.has(parameter.name)) suggestions.push(`${parameter.name}=`);
      }
    }
    for (const name of Object.keys(
      GLOBAL_SIGNATURES[call.callee]?.parameters ?? {},
    ).length > 0
      ? GLOBAL_SIGNATURES[call.callee]!.parameters.map((parameter) =>
          parameter.label.replace(/=.*/, ""),
        )
      : []) {
      if (!used.has(name)) suggestions.push(`${name}=`);
    }
    return suggestions;
  }

  // ------------------------------------------------------------- diagnostics

  diagnose(
    uri: string,
  ): Array<{
    line: number;
    character: number;
    message: string;
    severity: number;
  }> {
    const { text } = this.analysisOf(uri);
    const diagnostics: Array<{
      line: number;
      character: number;
      message: string;
      severity: number;
    }> = [];
    const tokens = tokenize(text);

    // Unterminated strings and stray characters.
    for (const token of tokens) {
      if (token.kind === "error") {
        diagnostics.push({
          line: token.line,
          character: token.column,
          message:
            token.value.startsWith('"') || token.value.startsWith("'")
              ? "Unterminated string literal"
              : `Unexpected character '${token.value}'`,
          severity: 1,
        });
      }
    }

    // Unbalanced braces/brackets/parens per line region (whole-file summary).
    let depth = 0;
    for (const token of tokens) {
      if (token.kind !== "operator") continue;
      if ("([{".includes(token.value)) depth++;
      if (")]}".includes(token.value)) depth--;
      if (depth < 0) {
        diagnostics.push({
          line: token.line,
          character: token.column,
          message: "Unmatched closing bracket",
          severity: 1,
        });
        depth = 0;
      }
    }
    if (depth > 0) {
      const last = tokens[tokens.length - 1];
      diagnostics.push({
        line: last.line,
        character: last.column,
        message: `${depth} unclosed bracket(s) at end of file`,
        severity: 1,
      });
    }

    // assert with a constant-truthy condition (the classic silent no-op trap).
    const lines = text.split("\n");
    lines.forEach((lineText, index) => {
      const assertMatch = /^\s*assert\s+(.+)$/.exec(lineText);
      if (assertMatch !== null) {
        const condition = assertMatch[1].split(",")[0].trim();
        if (/^[A-Z]\w*(Error)?\s*\(/.test(condition)) {
          diagnostics.push({
            line: index,
            character: lineText.indexOf("assert"),
            message: `assert '${condition}...' constructs an exception object (always truthy) — use 'raise' to throw, or assert a boolean condition`,
            severity: 2,
          });
        }
      }
    });

    // Unknown module imports (warn only).
    const { analysis } = { analysis: analyze(text) };
    for (const imported of analysis.imports) {
      const root = imported.module.split(".")[0];
      if (BUILTIN_MODULES[root] !== undefined) continue;
      if (this.workspace.resolveModule(imported.module) !== undefined) continue;
      if (this.resolvableAsLocalFile(root)) continue;
      diagnostics.push({
        line: imported.line,
        character: 0,
        message: `Cannot resolve module '${imported.module}'`,
        severity: 2,
      });
    }

    return diagnostics;
  }

  private resolvableAsLocalFile(name: string): boolean {
    try {
      return fsExistsSync(`${name}.thm`);
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------- position

  private lineAt(text: string, line: number): { lineText: string } {
    const lines = text.split("\n");
    return { lineText: lines[line] ?? "" };
  }

  private offsetAt(text: string, line: number, character: number): number {
    return offsetToPosition(text, line, character).offset;
  }
}
