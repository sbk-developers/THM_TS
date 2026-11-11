import { ThmImportError } from "../../src/errors/errors.js";
import { ModuleResolver } from "../../src/loader/resolver.js";
import type { Platform } from "../../src/platform/platform.js";
import { equal, test, throws } from "../harness.js";

function platformWith(files: string[]): Platform {
  const existing = new Set(files);
  return {
    readFile: () => { throw new Error("not available"); },
    writeFile: () => { throw new Error("not available"); },
    readBinaryFile: () => { throw new Error("not available"); },
    writeBinaryFile: () => { throw new Error("not available"); },
    exists: (file) => existing.has(file),
    listDir: () => [],
    isDirectory: () => false,
    stdout: () => {},
    stderr: () => {},
    args: () => [],
    exit: () => { throw new Error("unexpected exit"); },
    cwd: () => "/project",
    joinPath: (...parts) => parts.join("/"),
    clock: () => 0,
  };
}

test("loader resolves absolute and package-relative module names", () => {
  const resolver = new ModuleResolver(platformWith([]));
  equal(resolver.resolveName("math"), "math");
  equal(resolver.resolveName(".helpers", "pkg.sub"), "pkg.sub.helpers");
  equal(resolver.resolveName("..shared", "pkg.sub"), "pkg.shared");
  throws(() => resolver.resolveName(".helpers"), (error) => error instanceof ThmImportError);
  throws(() => resolver.resolveName("...helpers", "pkg"), (error) => error instanceof ThmImportError);
});

test("loader resolves project modules and package initializers before lib modules", () => {
  const resolver = new ModuleResolver(platformWith([
    "/project/pkg/__init__.thm",
    "/project/lib/pkg.thm",
  ]));
  const resolved = resolver.resolveFile("pkg");
  equal(resolved?.path, "/project/pkg/__init__.thm");
  equal(resolved?.isPackage, true);
});

test("loader rejects path traversal and malformed module names", () => {
  const resolver = new ModuleResolver(platformWith([]));
  throws(() => resolver.resolveFile("../secret"), (error) => error instanceof ThmImportError);
  throws(() => resolver.resolveFile("pkg..child"), (error) => error instanceof ThmImportError);
});
