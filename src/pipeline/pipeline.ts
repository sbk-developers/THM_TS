/**
 * pipeline/pipeline.ts
 * ---------------------------------------------------------------------------
 * The full THM compilation pipeline:  source text -> bytecode chunk -> bytes.
 *
 * Split into small, single-purpose steps so each stage can be tested and
 * replaced independently:
 *
 *   Step 1  parseSource()  - tokenize + parse, producing an AST (Program).
 *   Step 2  compileAst()   - lower the AST into a validated bytecode Chunk.
 *   Step 3  buildToBytes() - serialize a Chunk into the `.thmc` container.
 *   Step 4  buildFile()    - read a source file and produce `.thmc` bytes.
 *   Step 5  runSource()    - parse + compile + execute in the VM.
 *
 * Everything routes through this module so error handling and search paths
 * stay consistent across the CLI, tests and future tooling (REPL, LSP...).
 */

import { parse } from "../parser/parser.js";
import { compile } from "../compiler.js";
import { serializeChunk, deserializeChunk } from "../compiler/bytecode/bytecode.js";
import type { Chunk } from "../compiler/bytecode/bytecode.js";
import type { Platform } from "../platform/platform.js";
import { VM } from "../vm/vm.js";

/** Where the bundled standard library modules live once installed. */
export const STDLIB_ROOT = "/usr/local/lib/thm/lib";

/** Default VM recursion depth. Shared by every entry point. */
export const DEFAULT_RECURSION_LIMIT = 1000;

/**
 * Step 1 - Parse `.thm` source text into an AST.
 * Throws SyntaxError (with span info) on malformed input.
 */
export function parseSource(source: string) {
  return parse(source);
}

/**
 * Step 2 - Compile an AST into a validated bytecode Chunk.
 * Throws CompileError on semantic/lowering failures.
 */
export function compileAst(program: ReturnType<typeof parseSource>, sourceFile: string): Chunk {
  return compile(program, sourceFile);
}

/**
 * Step 3 - Serialize a Chunk into the version-6 binary container format.
 */
export function chunkToBytes(chunk: Chunk): Uint8Array {
  return serializeChunk(chunk);
}

/**
 * Step 3b - Load a Chunk back from serialized `.thmc` bytes.
 */
export function chunkFromBytes(bytes: Uint8Array): Chunk {
  return deserializeChunk(bytes);
}

/**
 * Step 4 - Full "build" of one source file:
 *          read from disk -> parse -> compile -> serialize.
 *          Returns the bytes to write as `<output>.thmc`.
 */
export function buildFile(platform: Platform, sourcePath: string): Uint8Array {
  const source = platform.readFile(sourcePath);
  return chunkToBytes(compileAst(parseSource(source), sourcePath));
}

/**
 * Step 5 - Compile and immediately execute source text in a fresh VM.
 * Used by the default `thm <file.thm>` invocation.
 */
export function runSource(
  platform: Platform,
  source: string,
  sourceFile: string,
  searchPaths: string[] = [STDLIB_ROOT],
  recursionLimit = DEFAULT_RECURSION_LIMIT,
): ReturnType<VM["run"]> {
  const chunk = compileAst(parseSource(source), sourceFile);
  return new VM(platform, recursionLimit, searchPaths).run(chunk);
}

/**
 * Step 5b - Execute a previously compiled `.thmc` file in a fresh VM.
 * Used by `thm run-bc <file.thmc>`.
 */
export function runBytecodeFile(
  platform: Platform,
  bytecodePath: string,
  searchPaths: string[] = [STDLIB_ROOT],
  recursionLimit = DEFAULT_RECURSION_LIMIT,
): ReturnType<VM["run"]> {
  const chunk = chunkFromBytes(platform.readBinaryFile(bytecodePath));
  return new VM(platform, recursionLimit, searchPaths).run(chunk);
}
