import { deserializeChunk, serializeChunk } from "../compiler/bytecode/bytecode.js";
import { compile } from "../compiler.js";
import { parse } from "../parser/parser.js";
import { getPlatform, type Platform } from "../platform/platform.js";
import { VM } from "../vm/vm.js";
import { readTraceback } from "../errors/errors.js";

const VERSION = "0.1.0";

export function main(platform: Platform = getPlatform()): void {
  const args = platform.args();
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    platform.stdout(
      "THM 0.1.0\nUsage:\n  thm <source.thm>\n  thm compile <source.thm> -o <output.thmc>\n  thm run-bytecode <file.thmc>\n",
    );
    return;
  }
  if (args[0] === "--version") {
    platform.stdout(`THM ${VERSION}\n`);
    return;
  }

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

    if (args[0] === "run-bytecode") {
      if (args.length !== 2) {
        platform.stderr("Usage: thm run-bytecode <file.thmc>\n");
        platform.exit(2);
      }
      const chunk = deserializeChunk(platform.readBinaryFile(args[1]!));
      new VM(platform).run(chunk);
      return;
    }

    if (args.length !== 1) {
      platform.stderr("Usage: thm <source.thm>\n");
      platform.exit(2);
    }
    const source = platform.readFile(args[0]!);
    new VM(platform).run(compile(parse(source), args[0]!));
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
