/**
 * compiler/bytecode/bytecode.ts
 * ---------------------------------------------------------------------------
 * THM bytecode: the on-disk format, opcode set, and (de)serialization.
 *
 * A Chunk is one compiled scope (module/function/class/generator). The
 * binary container ("THMC") is versioned so old files can be rejected, and
 * every chunk is validated with validateChunk() before it may be executed.
 */

import { CompileError } from "../../errors/errors.js";

/** Container magic string and current format version. */
export const BYTECODE_MAGIC = "THMC";
export const BYTECODE_VERSION = 7;
const HEADER_SIZE = 14;

/** Every opcode the VM understands. */
export type Opcode =
  | "CONST" | "LOAD" | "STORE" | "POP" | "DUP" | "DUP2" | "SWAP" | "ROT3"
  | "UNARY" | "BINARY" | "COMPARE" | "COMPARE_CHAIN" | "COMPARE_JUMP"
  | "BUILD_LIST" | "BUILD_TUPLE" | "BUILD_SET" | "BUILD_DICT" | "LIST_APPEND"
  | "SET_ADD" | "DICT_SET" | "BUILD_STRING" | "UNPACK_SEQUENCE" | "GET_ATTR"
  | "SET_ATTR" | "DEL_ATTR" | "GET_ITEM" | "SET_ITEM" | "GET_SLICE"
  | "JUMP" | "JUMP_IF_FALSE" | "JUMP_IF_TRUE" | "ITER" | "ITER_NEXT"
  | "MAKE_FUNCTION" | "MAKE_CLASS" | "CALL" | "AWAIT" | "RETURN" | "HALT"
  | "IMPORT" | "RAISE" | "EXC_MATCH" | "DEL_NAME" | "DEL_ITEM" | "DEL_SLICE"
  | "SET_SLICE" | "YIELD";

const opcodes: Opcode[] = [
  "CONST", "LOAD", "STORE", "POP", "DUP", "DUP2", "SWAP", "ROT3", "UNARY", "BINARY",
  "COMPARE", "COMPARE_CHAIN", "COMPARE_JUMP", "BUILD_LIST", "BUILD_TUPLE", "BUILD_SET", "BUILD_DICT", "LIST_APPEND", "SET_ADD", "DICT_SET", "BUILD_STRING",
  "UNPACK_SEQUENCE", "GET_ATTR", "SET_ATTR", "DEL_ATTR", "GET_ITEM", "SET_ITEM", "GET_SLICE", "JUMP",
  "JUMP_IF_FALSE", "JUMP_IF_TRUE", "ITER", "ITER_NEXT", "MAKE_FUNCTION", "MAKE_CLASS", "CALL", "AWAIT", "RETURN", "HALT", "IMPORT",
  "RAISE", "EXC_MATCH", "DEL_NAME", "DEL_ITEM", "DEL_SLICE", "SET_SLICE", "YIELD",
];
const opcodeSet = new Set<Opcode>(opcodes);

// A single bytecode instruction with source location.
export interface Instruction {
  op: Opcode;
  a?: number;
  text?: string;
  line: number;
  column: number;
}

// An exception handler range entry.
export interface ExceptionEntry {
  start: number;
  end: number;
  handler: number;
  kind: "except" | "finally";
  stackDepth: number;
  line: number;
  column: number;
}

// A compiled chunk (module, function, class body, etc.).
export interface Chunk {
  name: string;
  sourceFile: string;
  code: Instruction[];
  constants: Array<null | boolean | bigint | number | string | string[] | Uint8Array>;
  names: string[];
  nested: Chunk[];
  annotations: string[];
  genericParameters: string[];
  parameters: string[];
  localNames: string[];
  exceptions: ExceptionEntry[];
}

// Compute the stack effect of an instruction (for validation).
export function getStackEffect(instruction: Instruction): number {
  switch (instruction.op) {
    case "CONST":
    case "LOAD":
    case "IMPORT":
      return 1;
    case "MAKE_FUNCTION":
      return 1 - functionDefaultCount(instruction);
    case "STORE":
    case "POP":
      return -1;
    case "DUP":
      return 1;
    case "DUP2":
      return 2;
    case "SWAP":
    case "ROT3":
      return 0;
    case "UNARY":
    case "GET_ATTR":
      return 0;
    case "BINARY":
    case "COMPARE":
    case "COMPARE_JUMP":
    case "GET_ITEM":
    case "EXC_MATCH":
      return -1;
    case "COMPARE_CHAIN":
      return 1 - requireOperand(instruction, "comparison count");
    case "BUILD_LIST":
    case "BUILD_TUPLE":
    case "BUILD_SET":
      return 1 - requireOperand(instruction, "element count");
    case "BUILD_DICT":
      return 1 - 2 * requireOperand(instruction, "pair count");
    case "BUILD_STRING":
      return 1 - requireOperand(instruction, "string part count");
    case "LIST_APPEND":
    case "SET_ADD":
      return -1;
    case "DICT_SET":
      return -2;
    case "UNPACK_SEQUENCE":
      return requireOperand(instruction, "target count") - 1;
    case "SET_ATTR":
      return -2;
    case "DEL_ATTR":
      return -1;
    case "DEL_NAME":
      return 0;
    case "DEL_ITEM":
      return -2;
    case "DEL_SLICE":
      return -4;
    case "SET_SLICE":
      return -5;
    case "SET_ITEM":
      return -3;
    case "GET_SLICE":
      return -3;
    case "JUMP":
    case "ITER":
    case "HALT":
      return 0;
    case "MAKE_CLASS":
      return -1;
    case "JUMP_IF_FALSE":
    case "JUMP_IF_TRUE":
      return -1;
    case "ITER_NEXT":
      return 1;
    case "CALL":
      return -requireOperand(instruction, "argument count");
    case "AWAIT":
      return 0;
    case "RETURN":
      return -1;
    case "YIELD":
      return -1;
    case "RAISE":
      return instruction.a === 1 ? -1 : 0;
  }
}

// Parse the default count from MAKE_FUNCTION metadata text.
function functionDefaultCount(instruction: Instruction): number {
  if (instruction.text === undefined) return 0;
  let metadata: unknown;
  try {
    metadata = JSON.parse(instruction.text);
  } catch {
    throw new CompileError("MAKE_FUNCTION has malformed parameter metadata");
  }
  if (typeof metadata !== "object" || metadata === null) {
    throw new CompileError("MAKE_FUNCTION has malformed parameter metadata");
  }
  const record = metadata as Record<string, unknown>;
  if (
    !Number.isInteger(record.defaults) ||
    (record.defaults as number) < 0 ||
    !Array.isArray(record.parameters)
  ) {
    throw new CompileError("MAKE_FUNCTION has malformed parameter metadata");
  }
  return record.defaults as number;
}

// Validate MAKE_FUNCTION parameter metadata against chunk parameters.
function validateFunctionMetadata(instruction: Instruction, parameters: string[]): void {
  const count = functionDefaultCount(instruction);
  if (instruction.text === undefined) return;
  const metadata = JSON.parse(instruction.text) as Record<string, unknown>;
  const rawParameters: unknown[] = metadata.parameters as unknown[];
  let observedDefaults = 0;
  if (rawParameters.length !== parameters.length) {
    throw new CompileError("MAKE_FUNCTION parameter metadata does not match its chunk");
  }
  for (let index = 0; index < rawParameters.length; index++) {
    const item = rawParameters[index];
    if (typeof item !== "object" || item === null) {
      throw new CompileError("MAKE_FUNCTION has malformed parameter metadata");
    }
    const parameter = item as Record<string, unknown>;
    if (
      parameter.name !== parameters[index] ||
      (parameter.kind !== "positional" &&
        parameter.kind !== "vararg" &&
        parameter.kind !== "keywordOnly" &&
        parameter.kind !== "kwarg") ||
      typeof parameter.hasDefault !== "boolean" ||
      (parameter.hasDefault && (parameter.kind === "vararg" || parameter.kind === "kwarg"))
    ) {
      throw new CompileError("MAKE_FUNCTION has malformed parameter metadata");
    }
    if (parameter.hasDefault) observedDefaults++;
  }
  if (observedDefaults !== count) throw new CompileError("MAKE_FUNCTION default count is inconsistent");
  if ("isAsync" in metadata && metadata.isAsync !== undefined && typeof metadata.isAsync !== "boolean") {
    throw new CompileError("MAKE_FUNCTION has malformed parameter metadata");
  }
}

// Validate CALL argument metadata.
function validateCallMetadata(instruction: Instruction): void {
  if (instruction.text === undefined) return;
  let decoded: unknown;
  try {
    decoded = JSON.parse(instruction.text);
  } catch {
    throw new CompileError("CALL has malformed argument metadata");
  }
  if (!Array.isArray(decoded) || decoded.length !== requireOperand(instruction, "argument count")) {
    throw new CompileError("CALL has malformed argument metadata");
  }
  const specs: unknown[] = decoded;
  for (const item of specs) {
    if (typeof item !== "object" || item === null) {
      throw new CompileError("CALL has malformed argument metadata");
    }
    const spec = item as Record<string, unknown>;
    if (
      spec.kind !== "positional" &&
      spec.kind !== "keyword" &&
      spec.kind !== "star" &&
      spec.kind !== "keywordStar"
    ) {
      throw new CompileError("CALL has malformed argument metadata");
    }
    if (spec.kind === "keyword" && typeof spec.name !== "string") {
      throw new CompileError("CALL keyword argument has no name");
    }
  }
}

// Require a non-negative integer operand.
function requireOperand(instruction: Instruction, description: string): number {
  if (!Number.isInteger(instruction.a) || instruction.a! < 0) {
    throw new CompileError(`${instruction.op} requires a non-negative ${description}`);
  }
  return instruction.a!;
}

// Validate a single chunk (instructions, tables, jumps, control flow).
function validateOneChunk(chunk: Chunk): void {
  if (chunk.code.length === 0) throw new CompileError(`Empty bytecode chunk ${chunk.name}`);
  for (let index = 0; index < chunk.code.length; index++) {
    const instruction = chunk.code[index]!;
    if (typeof instruction !== "object" || instruction === null || !opcodeSet.has(instruction.op)) {
      throw new CompileError(`Invalid opcode at instruction ${index}`);
    }
    if (!Number.isInteger(instruction.line) || instruction.line < 1 || !Number.isInteger(instruction.column) || instruction.column < 1) {
      throw new CompileError(`Invalid source location at instruction ${index}`);
    }
    if (instruction.op === "CONST") validateTableIndex(instruction, chunk.constants.length, "constant");
    if (
      instruction.op === "LOAD" ||
      instruction.op === "STORE" ||
      instruction.op === "GET_ATTR" ||
      instruction.op === "SET_ATTR" ||
      instruction.op === "DEL_ATTR" ||
      instruction.op === "DEL_NAME"
    ) {
      validateTableIndex(instruction, chunk.names.length, "name");
    }
    if (instruction.op === "MAKE_FUNCTION" || instruction.op === "MAKE_CLASS") {
      validateTableIndex(instruction, chunk.nested.length, "nested chunk");
      if (instruction.op === "MAKE_FUNCTION") {
        validateFunctionMetadata(instruction, chunk.nested[instruction.a!]!.parameters);
      }
    }
    if (
      instruction.op === "IMPORT" &&
      (typeof instruction.text !== "string" || instruction.text.length === 0)
    ) {
      throw new CompileError("IMPORT requires a non-empty module name");
    }
    if (
      instruction.op === "JUMP" ||
      instruction.op === "COMPARE_JUMP" ||
      instruction.op === "JUMP_IF_FALSE" ||
      instruction.op === "JUMP_IF_TRUE" ||
      instruction.op === "ITER_NEXT"
    ) {
      validateJump(instruction, chunk.code.length, index);
    }
    if (
      instruction.op === "BUILD_LIST" ||
      instruction.op === "BUILD_TUPLE" ||
      instruction.op === "BUILD_SET" ||
      instruction.op === "BUILD_DICT" ||
      instruction.op === "BUILD_STRING" ||
      instruction.op === "UNPACK_SEQUENCE" ||
      instruction.op === "CALL" ||
      instruction.op === "COMPARE_CHAIN" ||
      instruction.op === "ITER_NEXT"
    ) {
      getStackEffect(instruction);
    }
    if (instruction.op === "CALL") validateCallMetadata(instruction);
    if (instruction.op === "RAISE" && instruction.a !== 0 && instruction.a !== 1) {
      throw new CompileError("RAISE operand must select bare or explicit raising");
    }
  }
  validateExceptionTable(chunk);
  validateControlFlow(chunk);
}

// Validate a chunk and all nested chunks recursively.
export function validateChunk(chunk: Chunk): void {
  validateOneChunk(chunk);
  for (const nested of chunk.nested) validateChunk(nested);
}

// Validate a table index is within bounds.
function validateTableIndex(instruction: Instruction, length: number, table: string): void {
  if (!Number.isInteger(instruction.a) || instruction.a! < 0 || instruction.a! >= length) {
    throw new CompileError(`${instruction.op} has an invalid ${table} index`);
  }
}

// Validate a jump destination is valid and not a self-jump.
function validateJump(instruction: Instruction, length: number, at: number): void {
  if (!Number.isInteger(instruction.a) || instruction.a! < 0 || instruction.a! >= length || instruction.a === at) {
    throw new CompileError(`${instruction.op} at ${at} has an invalid jump destination`);
  }
}

// Validate all exception table entries.
function validateExceptionTable(chunk: Chunk): void {
  for (const entry of chunk.exceptions) {
    if (
      !Number.isInteger(entry.start) ||
      !Number.isInteger(entry.end) ||
      !Number.isInteger(entry.handler) ||
      entry.start < 0 ||
      entry.start >= entry.end ||
      entry.end > chunk.code.length ||
      entry.handler < 0 ||
      entry.handler >= chunk.code.length ||
      !Number.isInteger(entry.stackDepth) ||
      entry.stackDepth < 0 ||
      !Number.isInteger(entry.line) ||
      entry.line < 1 ||
      !Number.isInteger(entry.column) ||
      entry.column < 1
    ) {
      throw new CompileError(`Invalid exception range in ${chunk.name}`);
    }
    if (entry.kind !== "except" && entry.kind !== "finally") {
      throw new CompileError(`Invalid exception handler kind in ${chunk.name}`);
    }
  }
}

// Validate control flow and stack depths across the chunk.
function validateControlFlow(chunk: Chunk): void {
  const depths = new Map<number, number>();
  const worklist: Array<[number, number]> = [[0, 0]];
  while (worklist.length > 0) {
    const item = worklist.pop();
    if (item === undefined) break;
    const [index, depth] = item;
    const priorDepth = depths.get(index);
    if (priorDepth !== undefined) {
      if (priorDepth !== depth) throw new CompileError(`Incompatible stack depths at instruction ${index}`);
      continue;
    }
    depths.set(index, depth);
    const instruction = chunk.code[index]!;
    if (instruction.op === "YIELD") {
      if (depth !== 1) {
        throw new CompileError(`YIELD at ${index} must consume exactly one yielded value`);
      }
      worklist.push([index + 1, 0]);
      continue;
    }
    let nextDepth: number;
    try {
      nextDepth = depth + getStackEffect(instruction);
    } catch (error) {
      throw new CompileError(`Invalid stack effect at instruction ${index}: ${String(error)}`);
    }
    if (nextDepth < 0) throw new CompileError(`Stack underflow at instruction ${index}`);
    if (instruction.op === "RETURN") {
      if (depth !== 1) throw new CompileError(`RETURN at ${index} must consume exactly one frame value`);
      continue;
    }
    if (instruction.op === "HALT") {
      if (depth !== 0) throw new CompileError(`HALT at ${index} requires an empty operand stack`);
      continue;
    }
    if (instruction.op === "RAISE") {
      for (const entry of chunk.exceptions) {
        if (index >= entry.start && index < entry.end) worklist.push([entry.handler, entry.stackDepth]);
      }
      continue;
    }
    if (instruction.op === "JUMP") {
      worklist.push([instruction.a!, nextDepth]);
    } else if (instruction.op === "COMPARE_JUMP") {
      if (depth < 2) throw new CompileError(`Stack underflow at comparison instruction ${index}`);
      worklist.push([instruction.a!, nextDepth]);
      if (index + 1 >= chunk.code.length) throw new CompileError(`Control flow falls off chunk ${chunk.name}`);
      worklist.push([index + 1, nextDepth]);
    } else if (instruction.op === "ITER_NEXT") {
      if (depth < 1) throw new CompileError(`Stack underflow at iterator instruction ${index}`);
      worklist.push([instruction.a!, depth - 1]);
      if (index + 1 >= chunk.code.length) throw new CompileError(`Control flow falls off chunk ${chunk.name}`);
      worklist.push([index + 1, nextDepth]);
    } else {
      if (instruction.op === "JUMP_IF_FALSE" || instruction.op === "JUMP_IF_TRUE") {
        worklist.push([instruction.a!, nextDepth]);
      }
      if (index + 1 >= chunk.code.length) throw new CompileError(`Control flow falls off chunk ${chunk.name}`);
      worklist.push([index + 1, nextDepth]);
    }
    for (const entry of chunk.exceptions) {
      if (index >= entry.start && index < entry.end) worklist.push([entry.handler, entry.stackDepth]);
    }
  }
}

// Serialize a chunk to a bytecode Uint8Array (with header and checksum).
export function serializeChunk(chunk: Chunk): Uint8Array {
  validateChunk(chunk);
  const writer = new BytecodeWriter();
  writer.writeChunk(chunk);
  const payloadBytes = writer.finish();
  if (payloadBytes.length > 0xffffffff) throw new CompileError("Bytecode payload is too large");
  const output = new Uint8Array(HEADER_SIZE + payloadBytes.length);
  for (let index = 0; index < BYTECODE_MAGIC.length; index++) {
    output[index] = BYTECODE_MAGIC.charCodeAt(index);
  }
  output[4] = (BYTECODE_VERSION >>> 8) & 0xff;
  output[5] = BYTECODE_VERSION & 0xff;
  writeUint32(output, 6, payloadBytes.length);
  writeUint32(output, 10, checksum(payloadBytes));
  output.set(payloadBytes, HEADER_SIZE);
  return output;
}

// Deserialize a bytecode Uint8Array back into a Chunk.
export function deserializeChunk(serialized: Uint8Array): Chunk {
  if (serialized.length < HEADER_SIZE) {
    throw new CompileError("Malformed bytecode header");
  }
  for (let index = 0; index < BYTECODE_MAGIC.length; index++) {
    if (serialized[index] !== BYTECODE_MAGIC.charCodeAt(index)) throw new CompileError("Malformed bytecode magic");
  }
  const version = (serialized[4]! << 8) | serialized[5]!;
  if (version !== BYTECODE_VERSION) throw new CompileError(`Unsupported bytecode version ${String(version)}`);
  const payloadLength = readUint32(serialized, 6);
  if (payloadLength !== serialized.length - HEADER_SIZE) {
    throw new CompileError("Truncated or trailing bytecode payload");
  }
  const payloadBytes = serialized.slice(HEADER_SIZE);
  if (readUint32(serialized, 10) !== checksum(payloadBytes)) {
    throw new CompileError("Corrupted bytecode checksum");
  }
  let chunk: Chunk;
  try {
    const reader = new BytecodeReader(payloadBytes);
    chunk = reader.readChunk();
    if (!reader.isDone()) throw new CompileError("Trailing bytecode payload data");
  } catch {
    throw new CompileError("Malformed bytecode payload");
  }
  validateChunk(chunk);
  return chunk;
}

// Writes bytecode payload bytes.
class BytecodeWriter {
  private readonly bytes: number[] = [];

  finish(): Uint8Array {
    return new Uint8Array(this.bytes);
  }

  writeByte(value: number): void {
    this.bytes.push(value & 0xff);
  }

  writeUint32(value: number): void {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
      throw new CompileError("Bytecode field is outside the unsigned 32-bit range");
    }
    this.bytes.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
  }

  writeString(value: string): void {
    const encoded = new TextEncoder().encode(value);
    this.writeUint32(encoded.length);
    for (const byte of encoded) this.writeByte(byte);
  }

  writeStrings(values: string[]): void {
    this.writeUint32(values.length);
    for (const value of values) this.writeString(value);
  }

  writeChunk(chunk: Chunk): void {
    this.writeString(chunk.name);
    this.writeString(chunk.sourceFile);

    this.writeUint32(chunk.code.length);
    for (const instruction of chunk.code) {
      const opcode = opcodes.indexOf(instruction.op);
      if (opcode < 0) throw new CompileError(`Unknown opcode ${instruction.op}`);
      this.writeByte(opcode);
      this.writeUint32(instruction.line);
      this.writeUint32(instruction.column);
      this.writeByte((instruction.a === undefined ? 0 : 1) | (instruction.text === undefined ? 0 : 2));
      if (instruction.a !== undefined) this.writeUint32(instruction.a);
      if (instruction.text !== undefined) this.writeString(instruction.text);
    }

    this.writeUint32(chunk.constants.length);
    for (const constant of chunk.constants) {
      if (constant === null) {
        this.writeByte(0);
      } else if (constant === false) {
        this.writeByte(1);
      } else if (constant === true) {
        this.writeByte(2);
      } else if (typeof constant === "number") {
        this.writeByte(3);
        this.writeString(String(constant));
      } else if (typeof constant === "bigint") {
        this.writeByte(6);
        this.writeString(String(constant));
      } else if (typeof constant === "string") {
        this.writeByte(4);
        this.writeString(constant);
      } else if (constant instanceof Uint8Array) {
        this.writeByte(7);
        this.writeUint32(constant.length);
        for (const byte of constant) this.writeByte(byte);
      } else {
        this.writeByte(5);
        this.writeStrings(constant);
      }
    }

    this.writeStrings(chunk.names);
    this.writeUint32(chunk.nested.length);
    for (const nested of chunk.nested) this.writeChunk(nested);
    this.writeStrings(chunk.annotations);
    this.writeStrings(chunk.genericParameters);
    this.writeStrings(chunk.parameters);
    this.writeStrings(chunk.localNames);

    this.writeUint32(chunk.exceptions.length);
    for (const entry of chunk.exceptions) {
      this.writeUint32(entry.start);
      this.writeUint32(entry.end);
      this.writeUint32(entry.handler);
      this.writeByte(entry.kind === "except" ? 0 : 1);
      this.writeUint32(entry.stackDepth);
      this.writeUint32(entry.line);
      this.writeUint32(entry.column);
    }
  }
}

// Reads bytecode payload bytes.
class BytecodeReader {
  private offset = 0;
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });

  constructor(private readonly bytes: Uint8Array) {}

  isDone(): boolean {
    return this.offset === this.bytes.length;
  }

  private readByte(): number {
    if (this.offset >= this.bytes.length) throw new CompileError("Unexpected end of bytecode payload");
    return this.bytes[this.offset++]!;
  }

  private readUint32(): number {
    if (this.offset + 4 > this.bytes.length) throw new CompileError("Unexpected end of bytecode payload");
    const value = readUint32(this.bytes, this.offset);
    this.offset += 4;
    return value;
  }

  private readCount(): number {
    const count = this.readUint32();
    if (count > this.bytes.length - this.offset) throw new CompileError("Invalid bytecode collection length");
    return count;
  }

  private readString(): string {
    const length = this.readUint32();
    if (length > this.bytes.length - this.offset) throw new CompileError("Invalid bytecode string length");
    const value = this.decoder.decode(this.bytes.slice(this.offset, this.offset + length));
    this.offset += length;
    return value;
  }

  private readStrings(): string[] {
    const count = this.readCount();
    const values: string[] = [];
    for (let index = 0; index < count; index++) values.push(this.readString());
    return values;
  }

  readChunk(depth = 0): Chunk {
    if (depth > 256) throw new CompileError("Bytecode nesting limit exceeded");
    const name = this.readString();
    const sourceFile = this.readString();
    const codeCount = this.readCount();
    const code: Instruction[] = [];
    for (let index = 0; index < codeCount; index++) {
      const opcode = opcodes[this.readByte()];
      if (opcode === undefined) throw new CompileError("Invalid bytecode opcode");
      const line = this.readUint32();
      const column = this.readUint32();
      const flags = this.readByte();
      if ((flags & ~3) !== 0) throw new CompileError("Invalid bytecode instruction flags");
      const instruction: Instruction = { op: opcode, line, column };
      if ((flags & 1) !== 0) instruction.a = this.readUint32();
      if ((flags & 2) !== 0) instruction.text = this.readString();
      code.push(instruction);
    }

    const constantCount = this.readCount();
    const constants: Chunk["constants"] = [];
    for (let index = 0; index < constantCount; index++) {
      const tag = this.readByte();
      if (tag === 0) constants.push(null);
      else if (tag === 1) constants.push(false);
      else if (tag === 2) constants.push(true);
      else if (tag === 3) {
        const number = Number(this.readString());
        if (!Number.isFinite(number)) throw new CompileError("Invalid numeric bytecode constant");
        constants.push(number);
      } else if (tag === 4) constants.push(this.readString());
      else if (tag === 5) constants.push(this.readStrings());
      else if (tag === 6) constants.push(BigInt(this.readString()));
      else if (tag === 7) {
        const length = this.readUint32();
        const bytes = new Uint8Array(length);
        for (let i = 0; i < length; i++) bytes[i] = this.readByte();
        constants.push(bytes);
      } else throw new CompileError("Invalid bytecode constant tag");
    }

    const names = this.readStrings();
    const nestedCount = this.readCount();
    const nested: Chunk[] = [];
    for (let index = 0; index < nestedCount; index++) nested.push(this.readChunk(depth + 1));
    const annotations = this.readStrings();
    const genericParameters = this.readStrings();
    const parameters = this.readStrings();
    const localNames = this.readStrings();
    const exceptionCount = this.readCount();
    const exceptions: ExceptionEntry[] = [];
    for (let index = 0; index < exceptionCount; index++) {
      const start = this.readUint32();
      const end = this.readUint32();
      const handler = this.readUint32();
      const kind = this.readByte();
      if (kind > 1) throw new CompileError("Invalid bytecode exception kind");
      exceptions.push({
        start,
        end,
        handler,
        kind: kind === 0 ? "except" : "finally",
        stackDepth: this.readUint32(),
        line: this.readUint32(),
        column: this.readUint32(),
      });
    }

    return {
      name, sourceFile, code, constants, names, nested, annotations, genericParameters,
      parameters, localNames, exceptions,
    };
  }
}

// FNV-1a checksum of the payload bytes.
function checksum(bytes: Uint8Array): number {
  let value = 2166136261;
  for (const byte of bytes) {
    value ^= byte;
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

// Write a uint32 into a buffer at offset.
function writeUint32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

// Read a uint32 from a buffer at offset.
function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset]! * 0x1000000) +
    (bytes[offset + 1]! << 16) +
    (bytes[offset + 2]! << 8) +
    bytes[offset + 3]!
  );
}

// Type guard for Chunk.
function isChunk(value: unknown): value is Chunk {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.name === "string" &&
    typeof candidate.sourceFile === "string" &&
    Array.isArray(candidate.code) &&
    Array.isArray(candidate.constants) &&
    Array.isArray(candidate.names) &&
    Array.isArray(candidate.nested) &&
    Array.isArray(candidate.annotations) &&
    Array.isArray(candidate.genericParameters) &&
    Array.isArray(candidate.parameters) &&
    Array.isArray(candidate.localNames) &&
    Array.isArray(candidate.exceptions) &&
    candidate.code.every(isInstruction)
    && candidate.constants.every(isConstant)
    && candidate.names.every((item) => typeof item === "string")
    && candidate.nested.every(isChunk)
    && candidate.annotations.every((item) => typeof item === "string")
    && candidate.genericParameters.every((item) => typeof item === "string")
    && candidate.parameters.every((item) => typeof item === "string")
    && candidate.localNames.every((item) => typeof item === "string")
    && candidate.exceptions.every(isExceptionEntry)
  );
}

// Type guard for Instruction.
function isInstruction(value: unknown): value is Instruction {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.op === "string" &&
    opcodeSet.has(candidate.op as Opcode) &&
    Number.isInteger(candidate.line) &&
    Number.isInteger(candidate.column) &&
    (candidate.a === undefined || Number.isInteger(candidate.a)) &&
    (candidate.text === undefined || typeof candidate.text === "string")
  );
}

// Type guard for a constant value.
function isConstant(value: unknown): value is Chunk["constants"][number] {
  return (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "bigint" ||
    typeof value === "number" ||
    typeof value === "string" ||
    (Array.isArray(value) && value.every((item) => typeof item === "string"))
  );
}

// Type guard for an exception entry.
function isExceptionEntry(value: unknown): value is ExceptionEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    Number.isInteger(entry.start) &&
    Number.isInteger(entry.end) &&
    Number.isInteger(entry.handler) &&
    (entry.kind === "except" || entry.kind === "finally") &&
    Number.isInteger(entry.stackDepth) &&
    Number.isInteger(entry.line) &&
    Number.isInteger(entry.column)
  );
}
