/**
 * compiler/bytecode/disassembler.ts
 * ---------------------------------------------------------------------------
 * Bytecode disassembler: renders a compiled Chunk (and its nested chunks)
 * as a human-readable instruction listing, useful for debugging the
 * compiler output.
 */

import type { Chunk, Instruction } from "./bytecode.js";

/** Render a chunk tree as a text listing. */
export function disassembleChunk(chunk: Chunk): string {
  const lines: string[] = [];
  appendChunk(lines, chunk);
  return lines.join("\n");
}

/** Append one chunk plus nested chunks to the listing lines. */
function appendChunk(lines: string[], chunk: Chunk): void {
  if (lines.length > 0) lines.push("");
  lines.push(`chunk ${JSON.stringify(chunk.name)} (${JSON.stringify(chunk.sourceFile)})`);
  for (let index = 0; index < chunk.code.length; index++) {
    const instruction = chunk.code[index]!;
    lines.push(`${String(index).padStart(4, "0")} ${formatInstruction(instruction)}`);
  }
  for (const nested of chunk.nested) appendChunk(lines, nested);
}

// Format a single instruction as text.
function formatInstruction(instruction: Instruction): string {
  let result = `${instruction.line}:${instruction.column} ${instruction.op}`;
  if (instruction.a !== undefined) result += ` ${instruction.a}`;
  if (instruction.text !== undefined) result += ` ${JSON.stringify(instruction.text)}`;
  return result;
}
