/**
 * Workspace-wide index: parsed documents, cross-file definition lookup, and
 * THM module discovery (`name.thm` / `pkg/__init__.thm` in cwd or lib/).
 */

import * as fs from "fs";
import * as path from "path";
import { analyze, type Definition } from "./analyzer.js";
import { bindDocument, type Binding } from "./binder.js";
import { LineIndex } from "./positions.js";

export interface WorkspaceDocument {
  uri: string;
  filePath: string;
  text: string;
  version: number;
  definitions: Definition[];
  isUntitled: boolean;
  lines: LineIndex;
  /** Lazily computed scope-aware binding (cached until the text changes). */
  binding: Binding;
}

/** Exported symbol surface of an imported THM module. */
export interface ModuleSurface {
  name: string;
  kind: "module" | "package";
  path: string;
  members: Array<{ name: string; kind: Definition["kind"]; detail?: string }>;
}

export class Workspace {
  readonly documents = new Map<string, WorkspaceDocument>();

  /** Roots used for resolving `import name` — the cwd and lib/ beneath it. */
  private rootDirs: string[] = [];

  setRoot(rootUri: string): void {
    this.setRoots([rootUri]);
  }

  /** Configure all workspace folders (multi-root aware). */
  setRoots(rootUris: string[]): void {
    const folders = rootUris.filter((uri) => uri.startsWith("file://")).map(uriToPath);
    this.folders = folders;
    this.rootDirs = folders.flatMap((folder) => [folder, path.join(folder, "lib")]);
    if (this.rootFromCwd === undefined && folders.length > 0) this.rootFromCwd = folders[0];
    this.diskCache.clear();
    this.fileListCache = undefined;
  }
  private rootFromCwd: string | undefined;
  private folders: string[] = [];
  private diskCache = new Map<string, { mtime: number; doc: WorkspaceDocument }>();
  private fileListCache: { at: number; files: string[] } | undefined;

  workspaceFolders(): string[] {
    return this.folders.length > 0 ? this.folders : [process.cwd()];
  }

  invalidateFiles(): void {
    this.fileListCache = undefined;
    this.diskCache.clear();
  }

  /** Every .thm file under the workspace folders (cached for a few seconds). */
  listThmFiles(limit = 4000): string[] {
    const now = Date.now();
    if (this.fileListCache !== undefined && now - this.fileListCache.at < 5000) return this.fileListCache.files;
    const files: string[] = [];
    const skip = new Set(["node_modules", ".git", "out", "build", "dist", ".venv", "__pycache__"]);
    const walk = (directory: string, depth: number): void => {
      if (files.length >= limit || depth > 12) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith(".") && entry.name !== ".") continue;
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (!skip.has(entry.name)) walk(full, depth + 1);
        } else if (entry.name.endsWith(".thm")) files.push(full);
      }
    };
    for (const folder of this.workspaceFolders()) walk(folder, 0);
    this.fileListCache = { at: now, files };
    return files;
  }

  /** Open document by path if open, otherwise parse (and cache) the file on disk. */
  loadByPath(filePath: string): WorkspaceDocument | undefined {
    for (const document of this.documents.values()) if (document.filePath === filePath) return document;
    try {
      const mtime = fs.statSync(filePath).mtimeMs;
      const cached = this.diskCache.get(filePath);
      if (cached !== undefined && cached.mtime === mtime) return cached.doc;
      const text = fs.readFileSync(filePath, "utf8");
      const doc = this.build(pathToUri(filePath), text, 0);
      this.diskCache.set(filePath, { mtime, doc });
      return doc;
    } catch {
      return undefined;
    }
  }

  /** Resolve `import a.b` to a file, looking beside the importer, then the roots. */
  resolveModuleFile(moduleName: string, fromFile?: string): string | undefined {
    if (moduleName === "") return undefined;
    const leading = /^\.+/.exec(moduleName)?.[0].length ?? 0;
    const parts = moduleName.slice(leading).split(".").filter((part) => part !== "");
    const roots: string[] = [];
    if (fromFile !== undefined && fromFile !== "") {
      let base = path.dirname(fromFile);
      for (let i = 1; i < leading; i++) base = path.dirname(base);
      roots.push(base);
    }
    if (leading === 0) roots.push(...this.rootDirs);
    if (roots.length === 0) roots.push(process.cwd());
    for (const root of roots) {
      const dir = path.join(root, ...parts);
      const init = path.join(dir, "__init__.thm");
      if (fs.existsSync(init)) return init;
      if (parts.length > 0 && fs.existsSync(`${dir}.thm`)) return `${dir}.thm`;
      if (parts.length === 0 && leading > 0 && fs.existsSync(init)) return init;
    }
    return undefined;
  }

  open(uri: string, text: string, version: number): WorkspaceDocument {
    const document = this.build(uri, text, version);
    this.documents.set(uri, document);
    return document;
  }

  private build(uri: string, text: string, version: number): WorkspaceDocument {
    const document: WorkspaceDocument = {
      uri,
      filePath: uriToPath(uri),
      text,
      version,
      definitions: analyze(text).definitions.filter(
        (definition) => definition.container === undefined,
      ),
      isUntitled: uri.startsWith("untitled:"),
      lines: new LineIndex(text),
      binding: bindDocument(text),
    };
    return document;
  }

  update(uri: string, text: string, version: number): WorkspaceDocument {
    return this.open(uri, text, version);
  }

  close(uri: string): void {
    this.documents.delete(uri);
  }

  get(uri: string): WorkspaceDocument | undefined {
    return this.documents.get(uri);
  }

  /**
   * Find a definition for `name` in the open documents, preferring the same
   * file, then functions/classes, then variables.
   */
  findDefinition(
    name: string,
    preferredUri: string,
  ): Array<{ uri: string; definition: Definition }> {
    const results: Array<{ uri: string; definition: Definition }> = [];
    const addFrom = (uri: string, definitions: Definition[]): void => {
      for (const definition of definitions) {
        if (definition.name === name && definition.kind !== "variable") {
          results.push({ uri, definition });
        }
      }
    };
    addFrom(preferredUri, this.documents.get(preferredUri)?.definitions ?? []);
    for (const [uri, document] of this.documents) {
      if (uri !== preferredUri) addFrom(uri, document.definitions);
    }
    // Variables considered only if nothing stronger exists.
    if (results.length === 0) {
      for (const [uri, document] of this.documents) {
        for (const definition of analyze(document.text).definitions) {
          if (
            definition.name === name &&
            (definition.kind === "variable" || definition.kind === "parameter")
          ) {
            results.push({ uri, definition });
          }
        }
      }
    }
    return results;
  }

  /** Resolve the possible source files for `import name`. */
  resolveModule(name: string): ModuleSurface | undefined {
    const dotted = name.split(".");
    const candidateRoots = [...this.rootDirs];
    if (candidateRoots.length === 0 && process.cwd())
      candidateRoots.push(process.cwd());

    const direct = this.moduleFileCandidates(candidateRoots, dotted);
    if (direct === undefined) return this.virtualModule(name);

    const members = this.readModuleMembers(direct.path);
    return {
      name,
      kind: direct.isPackage ? "package" : "module",
      path: direct.path,
      members,
    };
  }

  /** All importable module names visible from the workspace roots. */
  discoverModules(): ModuleSurface[] {
    const surfaces: ModuleSurface[] = [];
    const seen = new Set<string>();
    for (const root of this.rootDirs.length > 0
      ? this.rootDirs
      : [process.cwd()]) {
      for (const entry of safeReaddir(root)) {
        if (entry.endsWith(".thm")) {
          const name = entry.slice(0, -4);
          if (!seen.has(name)) {
            seen.add(name);
            surfaces.push({
              name,
              kind: "module",
              path: path.join(root, entry),
              members: this.readModuleMembers(path.join(root, entry)),
            });
          }
        } else if (
          fs.statSync(path.join(root, entry)).isDirectory() &&
          fs.existsSync(path.join(root, entry, "__init__.thm"))
        ) {
          if (!seen.has(entry)) {
            seen.add(entry);
            surfaces.push({
              name: entry,
              kind: "package",
              path: path.join(root, entry, "__init__.thm"),
              members: this.readModuleMembers(
                path.join(root, entry, "__init__.thm"),
              ),
            });
          }
        }
      }
    }
    return surfaces;
  }

  /** Built-in modules always resolve, even though they have no source file. */
  private virtualModule(name: string): ModuleSurface | undefined {
    if (isBuiltinModuleName(name)) {
      return { name, kind: "module", path: `<builtin:${name}>`, members: [] };
    }
    return undefined;
  }

  private moduleFileCandidates(
    roots: string[],
    parts: string[],
  ): { path: string; isPackage: boolean } | undefined {
    for (const root of roots) {
      const packageDirectory = path.join(root, ...parts);
      const initFile = path.join(packageDirectory, "__init__.thm");
      if (fs.existsSync(initFile)) return { path: initFile, isPackage: true };
      const moduleFile = `${path.join(root, ...parts)}.thm`;
      if (fs.existsSync(moduleFile))
        return { path: moduleFile, isPackage: false };
    }
    return undefined;
  }

  /** Top-level definitions of a module source file (parsed fresh, uncached). */
  private readModuleMembers(
    filePath: string,
  ): Array<{ name: string; kind: Definition["kind"]; detail?: string }> {
    if (filePath.startsWith("<builtin:")) return [];
    try {
      const text = fs.readFileSync(filePath, "utf8");
      return analyze(text)
        .definitions.filter(
          (definition) =>
            definition.container === undefined &&
            definition.kind !== "variable",
        )
        .map((definition) => ({
          name: definition.name,
          kind: definition.kind,
          detail: definition.detail,
        }));
    } catch {
      return [];
    }
  }
}

function isBuiltinModuleName(name: string): boolean {
  return [
    "math",
    "os",
    "random",
    "sys",
    "bytes",
    "requests",
    "test_sbk",
  ].includes(name);
}

function safeReaddir(directory: string): string[] {
  try {
    return fs.readdirSync(directory).filter((entry) => !entry.startsWith("."));
  } catch {
    return [];
  }
}

export function uriToPath(uri: string): string {
  if (!uri.startsWith("file://")) return uri;
  let decoded = decodeURIComponent(uri.replace(/^file:\/\/(localhost)?/, ""));
  if (/^\/[A-Za-z]:/.test(decoded)) {
    // Windows drive path: /c:/Users/x -> C:\Users\x
    decoded = decoded.slice(1);
    decoded = decoded[0].toUpperCase() + decoded.slice(1);
    return path.win32.normalize(decoded);
  }
  return decoded;
}

export function pathToUri(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const drive = /^([A-Za-z]):(\/.*)?$/.exec(normalized);
  if (drive !== null) {
    const rest = (drive[2] ?? "/").split("/").map(encodeURIComponent).join("/");
    return `file:///${drive[1].toLowerCase()}%3A${rest}`;
  }
  const withSlash = normalized.startsWith("/") ? normalized : `/${normalized}`;
  return `file://${withSlash.split("/").map(encodeURIComponent).join("/")}`;
}
