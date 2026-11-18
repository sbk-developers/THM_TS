"use strict";
/**
 * Workspace-wide index: parsed documents, cross-file definition lookup, and
 * THM module discovery (`name.thm` / `pkg/__init__.thm` in cwd or lib/).
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.Workspace = void 0;
exports.uriToPath = uriToPath;
exports.pathToUri = pathToUri;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const analyzer_js_1 = require("./analyzer.js");
const binder_js_1 = require("./binder.js");
const positions_js_1 = require("./positions.js");
class Workspace {
    documents = new Map();
    /** Roots used for resolving `import name` — the cwd and lib/ beneath it. */
    rootDirs = [];
    setRoot(rootUri) {
        this.setRoots([rootUri]);
    }
    /** Configure all workspace folders (multi-root aware). */
    setRoots(rootUris) {
        const folders = rootUris.filter((uri) => uri.startsWith("file://")).map(uriToPath);
        this.folders = folders;
        this.rootDirs = folders.flatMap((folder) => [folder, path.join(folder, "lib")]);
        if (this.rootFromCwd === undefined && folders.length > 0)
            this.rootFromCwd = folders[0];
        this.diskCache.clear();
        this.fileListCache = undefined;
    }
    rootFromCwd;
    folders = [];
    diskCache = new Map();
    fileListCache;
    workspaceFolders() {
        return this.folders.length > 0 ? this.folders : [process.cwd()];
    }
    invalidateFiles() {
        this.fileListCache = undefined;
        this.diskCache.clear();
    }
    /** Every .thm file under the workspace folders (cached for a few seconds). */
    listThmFiles(limit = 4000) {
        const now = Date.now();
        if (this.fileListCache !== undefined && now - this.fileListCache.at < 5000)
            return this.fileListCache.files;
        const files = [];
        const skip = new Set(["node_modules", ".git", "out", "build", "dist", ".venv", "__pycache__"]);
        const walk = (directory, depth) => {
            if (files.length >= limit || depth > 12)
                return;
            let entries;
            try {
                entries = fs.readdirSync(directory, { withFileTypes: true });
            }
            catch {
                return;
            }
            for (const entry of entries) {
                if (entry.name.startsWith(".") && entry.name !== ".")
                    continue;
                const full = path.join(directory, entry.name);
                if (entry.isDirectory()) {
                    if (!skip.has(entry.name))
                        walk(full, depth + 1);
                }
                else if (entry.name.endsWith(".thm"))
                    files.push(full);
            }
        };
        for (const folder of this.workspaceFolders())
            walk(folder, 0);
        this.fileListCache = { at: now, files };
        return files;
    }
    /** Open document by path if open, otherwise parse (and cache) the file on disk. */
    loadByPath(filePath) {
        for (const document of this.documents.values())
            if (document.filePath === filePath)
                return document;
        try {
            const mtime = fs.statSync(filePath).mtimeMs;
            const cached = this.diskCache.get(filePath);
            if (cached !== undefined && cached.mtime === mtime)
                return cached.doc;
            const text = fs.readFileSync(filePath, "utf8");
            const doc = this.build(pathToUri(filePath), text, 0);
            this.diskCache.set(filePath, { mtime, doc });
            return doc;
        }
        catch {
            return undefined;
        }
    }
    /** Resolve `import a.b` to a file, looking beside the importer, then the roots. */
    resolveModuleFile(moduleName, fromFile) {
        if (moduleName === "")
            return undefined;
        const leading = /^\.+/.exec(moduleName)?.[0].length ?? 0;
        const parts = moduleName.slice(leading).split(".").filter((part) => part !== "");
        const roots = [];
        if (fromFile !== undefined && fromFile !== "") {
            let base = path.dirname(fromFile);
            for (let i = 1; i < leading; i++)
                base = path.dirname(base);
            roots.push(base);
        }
        if (leading === 0)
            roots.push(...this.rootDirs);
        if (roots.length === 0)
            roots.push(process.cwd());
        for (const root of roots) {
            const dir = path.join(root, ...parts);
            const init = path.join(dir, "__init__.thm");
            if (fs.existsSync(init))
                return init;
            if (parts.length > 0 && fs.existsSync(`${dir}.thm`))
                return `${dir}.thm`;
            if (parts.length === 0 && leading > 0 && fs.existsSync(init))
                return init;
        }
        return undefined;
    }
    open(uri, text, version) {
        const document = this.build(uri, text, version);
        this.documents.set(uri, document);
        return document;
    }
    build(uri, text, version) {
        const document = {
            uri,
            filePath: uriToPath(uri),
            text,
            version,
            definitions: (0, analyzer_js_1.analyze)(text).definitions.filter((definition) => definition.container === undefined),
            isUntitled: uri.startsWith("untitled:"),
            lines: new positions_js_1.LineIndex(text),
            binding: (0, binder_js_1.bindDocument)(text),
        };
        return document;
    }
    update(uri, text, version) {
        return this.open(uri, text, version);
    }
    close(uri) {
        this.documents.delete(uri);
    }
    get(uri) {
        return this.documents.get(uri);
    }
    /**
     * Find a definition for `name` in the open documents, preferring the same
     * file, then functions/classes, then variables.
     */
    findDefinition(name, preferredUri) {
        const results = [];
        const addFrom = (uri, definitions) => {
            for (const definition of definitions) {
                if (definition.name === name && definition.kind !== "variable") {
                    results.push({ uri, definition });
                }
            }
        };
        addFrom(preferredUri, this.documents.get(preferredUri)?.definitions ?? []);
        for (const [uri, document] of this.documents) {
            if (uri !== preferredUri)
                addFrom(uri, document.definitions);
        }
        // Variables considered only if nothing stronger exists.
        if (results.length === 0) {
            for (const [uri, document] of this.documents) {
                for (const definition of (0, analyzer_js_1.analyze)(document.text).definitions) {
                    if (definition.name === name &&
                        (definition.kind === "variable" || definition.kind === "parameter")) {
                        results.push({ uri, definition });
                    }
                }
            }
        }
        return results;
    }
    /** Resolve the possible source files for `import name`. */
    resolveModule(name) {
        const dotted = name.split(".");
        const candidateRoots = [...this.rootDirs];
        if (candidateRoots.length === 0 && process.cwd())
            candidateRoots.push(process.cwd());
        const direct = this.moduleFileCandidates(candidateRoots, dotted);
        if (direct === undefined)
            return this.virtualModule(name);
        const members = this.readModuleMembers(direct.path);
        return {
            name,
            kind: direct.isPackage ? "package" : "module",
            path: direct.path,
            members,
        };
    }
    /** All importable module names visible from the workspace roots. */
    discoverModules() {
        const surfaces = [];
        const seen = new Set();
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
                }
                else if (fs.statSync(path.join(root, entry)).isDirectory() &&
                    fs.existsSync(path.join(root, entry, "__init__.thm"))) {
                    if (!seen.has(entry)) {
                        seen.add(entry);
                        surfaces.push({
                            name: entry,
                            kind: "package",
                            path: path.join(root, entry, "__init__.thm"),
                            members: this.readModuleMembers(path.join(root, entry, "__init__.thm")),
                        });
                    }
                }
            }
        }
        return surfaces;
    }
    /** Built-in modules always resolve, even though they have no source file. */
    virtualModule(name) {
        if (isBuiltinModuleName(name)) {
            return { name, kind: "module", path: `<builtin:${name}>`, members: [] };
        }
        return undefined;
    }
    moduleFileCandidates(roots, parts) {
        for (const root of roots) {
            const packageDirectory = path.join(root, ...parts);
            const initFile = path.join(packageDirectory, "__init__.thm");
            if (fs.existsSync(initFile))
                return { path: initFile, isPackage: true };
            const moduleFile = `${path.join(root, ...parts)}.thm`;
            if (fs.existsSync(moduleFile))
                return { path: moduleFile, isPackage: false };
        }
        return undefined;
    }
    /** Top-level definitions of a module source file (parsed fresh, uncached). */
    readModuleMembers(filePath) {
        if (filePath.startsWith("<builtin:"))
            return [];
        try {
            const text = fs.readFileSync(filePath, "utf8");
            return (0, analyzer_js_1.analyze)(text)
                .definitions.filter((definition) => definition.container === undefined &&
                definition.kind !== "variable")
                .map((definition) => ({
                name: definition.name,
                kind: definition.kind,
                detail: definition.detail,
            }));
        }
        catch {
            return [];
        }
    }
}
exports.Workspace = Workspace;
function isBuiltinModuleName(name) {
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
function safeReaddir(directory) {
    try {
        return fs.readdirSync(directory).filter((entry) => !entry.startsWith("."));
    }
    catch {
        return [];
    }
}
function uriToPath(uri) {
    if (!uri.startsWith("file://"))
        return uri;
    let decoded = decodeURIComponent(uri.replace(/^file:\/\/(localhost)?/, ""));
    if (/^\/[A-Za-z]:/.test(decoded)) {
        // Windows drive path: /c:/Users/x -> C:\Users\x
        decoded = decoded.slice(1);
        decoded = decoded[0].toUpperCase() + decoded.slice(1);
        return path.win32.normalize(decoded);
    }
    return decoded;
}
function pathToUri(filePath) {
    const normalized = filePath.replace(/\\/g, "/");
    const drive = /^([A-Za-z]):(\/.*)?$/.exec(normalized);
    if (drive !== null) {
        const rest = (drive[2] ?? "/").split("/").map(encodeURIComponent).join("/");
        return `file:///${drive[1].toLowerCase()}%3A${rest}`;
    }
    const withSlash = normalized.startsWith("/") ? normalized : `/${normalized}`;
    return `file://${withSlash.split("/").map(encodeURIComponent).join("/")}`;
}
