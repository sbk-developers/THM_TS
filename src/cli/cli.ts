import { deserializeChunk, serializeChunk } from "../compiler/bytecode/bytecode.js";
import { compile } from "../compiler.js";
import { parse } from "../parser/parser.js";
import { getPlatform, type Platform } from "../platform/platform.js";
import { VM } from "../vm/vm.js";
import { readTraceback } from "../errors/errors.js";
import os from "node:os";

const VERSION = "0.1.0";

export function main(platform: Platform = getPlatform()): void {
  const args = platform.args();
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    platform.stdout(
      "THM 0.1.0\nUsage:\n  thm <source.thm> [-p <path>]...\n  thm compile <source.thm> -o <output.thmc>\n  thm run-bytecode <file.thmc>\n",
    );
    return;
  }
  if (args[0] === "--version") {
    platform.stdout(`THM ${VERSION}\n`);
    return;
  }
  
const libdir = os.platform() === "win32" ? "C:\\Program Files\\THM\\Lib\\" : "/usr/local/lib/thm/lib/";

  // Module search paths from -p/--path options (may repeat).
  const searchPaths: string[] = [libdir];
  const remaining: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "-p" || arg === "--path") {
      const value = args[++index];
      if (value === undefined) {
        platform.stderr(`Missing value after ${arg}\n`);
        platform.exit(2);
        return;
      }
      searchPaths.push(value);
      continue;
    }
    remaining.push(arg);
  }
  args.length = 0;
  args.push(...remaining);

  try {
    if (args[0] === "compile") {
      if (args.length !== 4 || args[2] !== "-o") {
        platform.stderr("Usage: thm compile <source.thm> -o <output.thmc>\n");
        platform.exit(2);
      }
      const source = platform.readFile(args[1]!);
      const chunk = compile(parse(source), args[1]!);
      platform.writeBinaryFile(args[3]!, serializeChunk(chunk));
      return;
    }

    if (args[0] === "run-bc") {
      if (args.length !== 2) {
        platform.stderr("Usage: thm run-bc <file.thmc>\n");
        platform.exit(2);
      }
      const chunk = deserializeChunk(platform.readBinaryFile(args[1]!));
      new VM(platform, 1000, searchPaths).run(chunk);
      return;
    }

    if (args.length !== 1) {
      platform.stderr("Usage: thm <source.thm> [-p <path>]\n");
      platform.exit(2);
    }
    const sourceFile = args[0]!;
    // The directory of the entry script is an implicit search root (current path).
    const directory = sourceFile.includes("/") ? sourceFile.slice(0, sourceFile.lastIndexOf("/")) : ".";
    if (!searchPaths.includes(directory)) searchPaths.push(directory);
    const source = platform.readFile(sourceFile);
    new VM(platform, 1000, searchPaths).run(compile(parse(source), sourceFile));
  } catch (error) {
    const traceback = readTraceback(error);
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    if (traceback !== undefined && traceback.frames.length > 0) {
      const parts: string[] = ["Traceback (most recent call last):\n"];
      for (const frame of traceback.frames) {
        parts.push(`  File "${frame.filename}", line ${frame.line}, in ${frame.name}\n`);
        if (frame.sourceLine !== undefined) {
          parts.push(`    ${frame.sourceLine}\n`);
        }
      }
      parts.push(`${detail}\n`);
      platform.stderr(parts.join(""));
    } else {
      platform.stderr(`${detail}\n`);
    }
    platform.exit(1);
  }
}

main();
