/**
 * loader/resolver.ts
 * ---------------------------------------------------------------------------
 * Module resolution for `import` statements.
 *
 * Turns a dotted module name into a source file on disk. Search order per
 * root: `<name>/__init__.thm` (package) then `<name>.thm` (plain module).
 * Relative imports (.mod, ..mod) are rewritten against the importing
 * package's name before the file search starts.
 */

import { ThmImportError } from "../errors/errors.js";
import type { Platform } from "../platform/platform.js";

/** Where a resolved module lives: a file path and whether it is a package. */
export interface ModuleLocation {
  path: string;
  isPackage: boolean;
}

/** Resolves THM module names to files under configured search roots. */
export class ModuleResolver {
  constructor(
    private readonly platform: Platform,
    private readonly extraPaths: string[] = [],
  ) {}

  /** Register an extra search root (highest priority after cwd/lib). */
  addSearchPath(searchPath: string): void {
    if (!this.extraPaths.includes(searchPath)) this.extraPaths.push(searchPath);
  }

  /** The configured extra search roots, in priority order. */
  searchPaths(): string[] {
    return [...this.extraPaths];
  }

  /** Rewrite relative imports (leading dots) against the package name. */
  resolveName(requestedName: string, packageName = ""): string {
    if (!requestedName.startsWith(".")) return requestedName;
    if (packageName === "") throw new ThmImportError("Relative import outside a package");

    const level = requestedName.length - requestedName.replace(/^\.+/, "").length;
    const suffix = requestedName.slice(level);
    const parts = packageName.split(".");
    if (level > parts.length) {
      throw new ThmImportError("Relative import went beyond top-level package");
    }
    // One leading dot means current package; each additional dot ascends one level.
    for (let index = 1; index < level; index++) parts.pop();
    if (suffix !== "") parts.push(...suffix.split("."));
    if (parts.length === 0) {
      throw new ThmImportError("Relative import went beyond top-level package");
    }
    return parts.join(".");
  }

  /** Find a module file or package directory, or undefined if not found. */
  resolveFile(name: string): ModuleLocation | undefined {
    if (!name || name.split(".").some((part) => !/^[A-Za-z_]\w*$/.test(part))) {
      throw new ThmImportError(`Invalid module name '${name}'`);
    }
    const parts = name.split(".");
    const cwd = this.platform.cwd();
    // Search order: user-configured extra paths (highest priority), current directory, then lib.
    const roots = [...this.extraPaths, cwd, this.platform.joinPath(cwd, "lib")];
    for (const root of roots) {
      const packageDirectory = this.platform.joinPath(root, ...parts);
      const packageFile = this.platform.joinPath(packageDirectory, "__init__.thm");
      if (this.platform.exists(packageFile)) return { path: packageFile, isPackage: true };
      const moduleFile = `${this.platform.joinPath(root, ...parts)}.thm`;
      if (this.platform.exists(moduleFile)) return { path: moduleFile, isPackage: false };
    }
    return undefined;
  }
}
