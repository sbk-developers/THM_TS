/**
 * builtins/modules/os.ts
 * ---------------------------------------------------------------------------
 * `os` built-in module: filesystem queries (getcwd, exists, isdir, listdir,
 * join), process execution (system) and host info (platform, arch, version,
 * cpus).
 */

import { ThmTypeError, ThmOSError } from "../../errors/errors.js";
import type { NativeCallback } from "../../runtime/values.js";
import { makeList } from "../../runtime/values.js";
import { registerBuiltinModule } from "../registry.js";
import { execSync } from "node:child_process";
import os from "node:os";

/** Require between min and max string arguments; returns them as paths. */
function requirePathArguments(
  args: unknown[],
  functionName: string,
  minimum: number,
  maximum: number,
): string[] {
  if (args.length < minimum || args.length > maximum) {
    throw new ThmTypeError(`${functionName}() expects ${minimum === maximum ? `exactly ${minimum}` : `${minimum} to ${maximum}`} argument(s)`);
  }
  const paths: string[] = [];
  for (const argument of args) {
    if (typeof argument !== "string") {
      throw new ThmTypeError(`${functionName}() arguments must be strings`);
    }
    paths.push(argument);
  }
  return paths;
}

const getcwd: NativeCallback = (vm, _receiver, args) => {
  if (args.length !== 0) throw new ThmTypeError("getcwd() expects no arguments");
  return vm.platform.cwd();
};

const exists: NativeCallback = (vm, _receiver, args) => {
  const [path] = requirePathArguments(args, "exists", 1, 1);
  return vm.platform.exists(path!);
};

const isdir: NativeCallback = (vm, _receiver, args) => {
  const [path] = requirePathArguments(args, "isdir", 1, 1);
  return vm.platform.exists(path!) && vm.platform.isDirectory(path!);
};

const listdir: NativeCallback = (vm, _receiver, args) => {
  const [path] = requirePathArguments(args, "listdir", 0, 1);
  const entries: string[] = [];
  for (const e of vm.platform.listDir(path ?? ".")) entries.push(e);
  return makeList(vm.heap, entries);
};

const join: NativeCallback = (vm, _receiver, args) => {
  const paths = requirePathArguments(args, "join", 0, Number.MAX_SAFE_INTEGER);
  return vm.platform.joinPath(...paths);
};

const system: NativeCallback = (_vm, _re, args) => {
  // SECURITY: os.system() executes an arbitrary shell command with full
  // process privileges. Never run untrusted THM code with this module loaded.
  if (args.length !== 1) throw new ThmTypeError("system() takes exactly one argument");
  if (typeof args[0] !== "string") throw new ThmTypeError("system() argument must be a string");
  try {
    return String(execSync(args[0])).trim();
  } catch (error) {
    if (error instanceof Error) {
      throw new ThmOSError(error.message);
    } else {
      throw new ThmOSError(String(error));
    }
  }
};

const platform: NativeCallback = (_vm, _rs, args) => {
  if (args.length !== 0) throw new ThmTypeError("platform() takes no arguments");
  const plt = os.platform();
  switch (plt) {
    case "win32": return "Windows";
    case "linux": return "Linux";
    case "freebsd": return "FreeBSD";
    case "openbsd": return "OpenBSD";
    case "darwin": return "MacOs";
    default: return "Unknown";
  }
};

const arch: NativeCallback = (_vm, _rs, args) => {
  if (args.length !== 0) throw new ThmTypeError("arch() takes no arguments");
  return os.arch();
};

const version: NativeCallback = (_vm, _rs, args) => {
  if (args.length !== 0) throw new ThmTypeError("version() takes no arguments");
  return os.release();
};

const cpus: NativeCallback = (_vm, _rs, args) => {
  if (args.length !== 0) throw new ThmTypeError("cpus() takes no arguments");
  return os.cpus()[0]?.model;
};

registerBuiltinModule("os", {
  functions: { getcwd, exists, isdir, listdir, join, system, platform, arch, version, cpus },
});
