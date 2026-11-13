"use strict";
/**
 * Workspace-wide index: parsed documents, cross-file definition lookup, and
 * THM module discovery (`name.thm` / `pkg/__init__.thm` in cwd or lib/).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.Workspace = void 0;
exports.uriToPath = uriToPath;
exports.pathToUri = pathToUri;
const fs = require("fs");
const path = require("path");
const analyzer_js_1 = require("./analyzer.js");
class Workspace {
    documents = new Map();
    /** Roots used for resolving `import name` — the cwd and lib/ beneath it. */
    rootDirs = [];
    setRoot(rootUri) {
        if (!rootUri.startsWith("file://"))
            return;
        const rootPath = uriToPath(rootUri);
        this.rootDirs = [rootPath, path.join(rootPath, "lib")];
        if (this.rootFromCwd === undefined)
            this.rootFromCwd = rootPath;
    }
    rootFromCwd;
    open(uri, text, version) {
        const document = {
            uri,
            filePath: uriToPath(uri),
            text,
            version,
            definitions: (0, analyzer_js_1.analyze)(text).definitions.filter((definition) => definition.container === undefined),
            isUntitled: uri.startsWith("untitled:"),
        };
        this.documents.set(uri, document);
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
    let decoded = decodeURIComponent(uri.replace(/^file:\/\//, ""));
    if (/^\/[A-Za-z]:/.test(decoded))
        decoded = decoded.slice(1); // windows drive
    return decoded;
}
function pathToUri(filePath) {
    return `file://${filePath.split(path.sep).map(encodeURIComponent).join("/")}`;
}
