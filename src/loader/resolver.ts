import { ThmImportError } from "../errors/errors.js";
import type { Platform } from "../platform/platform.js";

export interface ModuleLocation {
  path: string;
  isPackage: boolean;
}

/** Resolves absolute and package-relative THM module names to source files. */
export class ModuleResolver {
  constructor(private readonly platform: Platform) {}

  resolveName(requestedName: string, packageName = ""): string {
    if (!requestedName.startsWith(".")) return requestedName;
    if (packageName === "") throw new ThmImportError("Relative import outside a package");

    const level = requestedName.length - requestedName.replace(/^\.+/, "").length;
    const suffix = requestedName.slice(level);
    const parts = packageName.split(".");
    if (level > parts.length) {
      throw new ThmImportError("Relative import went beyond top-level package");
    }
    // One leading dot means the current package; each additional dot ascends one level.
    for (let index = 1; index < level; index++) parts.pop();
    if (suffix !== "") parts.push(...suffix.split("."));
    if (parts.length === 0) {
      throw new ThmImportError("Relative import went beyond top-level package");
    }
    return parts.join(".");
  }

  resolveFile(name: string): ModuleLocation | undefined {
    if (!name || name.split(".").some((part) => !/^[A-Za-z_]\w*$/.test(part))) {
      throw new ThmImportError(`Invalid module name '${name}'`);
    }
    const parts = name.split(".");
    const cwd = this.platform.cwd();
    const roots = [cwd, this.platform.joinPath(cwd, "lib")];
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
