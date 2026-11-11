import { getStackEffect, deserializeChunk, serializeChunk, type Chunk } from "../../src/compiler/bytecode/bytecode.js";
import { disassembleChunk } from "../../src/compiler/bytecode/disassembler.js";
import { compile } from "../../src/compiler.js";
import { CompileError, SyntaxError } from "../../src/errors/errors.js";
import { parse } from "../../src/parser/parser.js";
import { assert, deepEqual, equal, test, throws } from "../harness.js";

test("compiler preserves annotation and generic metadata without emitting type checks", () => {
  const chunk = compile(parse('value: unknown = "text"\ndef identity[T](item: T) -> T {\n return item\n}\n'));
  equal(chunk.annotations[0], "value: unknown");
  equal(chunk.nested[0]?.genericParameters[0], "T");
  equal(chunk.nested[0]?.annotations[0], "parameter item: T");
  equal(chunk.nested[0]?.annotations[1], "return: T");
  equal(chunk.code.some((instruction) => instruction.op === "MAKE_FUNCTION"), true);
});

test("compiler emits operand-dependent stack effects", () => {
  equal(getStackEffect({ op: "CALL", a: 3, line: 1, column: 1 }), -3);
  equal(getStackEffect({ op: "BUILD_LIST", a: 4, line: 1, column: 1 }), -3);
  equal(getStackEffect({ op: "BUILD_DICT", a: 2, line: 1, column: 1 }), -3);
  equal(getStackEffect({ op: "UNPACK_SEQUENCE", a: 3, line: 1, column: 1 }), 2);
});

test("bytecode serialization round-trips deterministically and rejects corruption", () => {
  const chunk = compile(parse('x = {"one": 1}\nwrite(x["one"])\n'), "sample.thm");
  const serialized = serializeChunk(chunk);
  equal(String.fromCharCode(...serialized.slice(0, 4)), "THMC");
  deepEqual(
    Array.from(serializeChunk(deserializeChunk(serialized))),
    Array.from(serialized),
  );
  const corrupted = serialized.slice();
  corrupted[corrupted.length - 1] = corrupted[corrupted.length - 1]! ^ 1;
  throws(() => deserializeChunk(corrupted), (error) => error instanceof CompileError);
  const unsupported = serialized.slice();
  unsupported[4] = 0;
  unsupported[5] = 99;
  throws(() => deserializeChunk(unsupported), (error) => error instanceof CompileError);
  throws(() => deserializeChunk(new Uint8Array([1, 2, 3])), (error) => error instanceof CompileError);
  throws(() => deserializeChunk(serialized.slice(0, -1)), (error) => error instanceof CompileError);
  const trailing = new Uint8Array(serialized.length + 1);
  trailing.set(serialized);
  throws(() => deserializeChunk(trailing), (error) => error instanceof CompileError);
});

test("bytecode disassembler includes source locations, operands, and nested chunks", () => {
  const chunk = compile(parse('def greet(name) {\n write("hi", name)\n}\ngreet("THM")\n'), "greet.thm");
  const output = disassembleChunk(chunk);
  assert(output.includes('chunk "<module>" ("greet.thm")'));
  assert(output.includes("CONST "));
  assert(output.includes("MAKE_FUNCTION"));
  assert(output.includes('chunk "greet" ("greet.thm")'));
});

test("compiler validates return, break, continue, and nonlocal scopes", () => {
  const empty: Chunk = {
    name: "broken",
    sourceFile: "test.thm",
    code: [
      { op: "POP", line: 1, column: 1 },
      { op: "HALT", line: 1, column: 1 },
    ],
    constants: [],
    names: [],
    nested: [],
    annotations: [],
    genericParameters: [],
    parameters: [],
    localNames: [],
    exceptions: [],
  };
  throws(() => compile(parse("return 1\n")), (error) => error instanceof SyntaxError);
  throws(() => compile(parse("break\n")), (error) => error instanceof SyntaxError);
  throws(() => compile(parse("continue\n")), (error) => error instanceof SyntaxError);
  throws(
    () => compile(parse("def f() {\n nonlocal missing\n}\n")),
    (error) => error instanceof SyntaxError,
  );
  throws(() => serializeChunk(empty), (error) => error instanceof CompileError);
});

test("class bytecode includes a serializable class-body chunk", () => {
  const chunk = compile(
    parse("class User {\n def __init__(self, name) { self.name = name }\n}\nitem = User()\ndel item.name\n"),
    "class.thm",
  );
  equal(chunk.code.some((instruction) => instruction.op === "MAKE_CLASS"), true);
  equal(chunk.code.some((instruction) => instruction.op === "DEL_ATTR"), true);
  equal(getStackEffect({ op: "MAKE_CLASS", a: 0, text: "User", line: 1, column: 1 }), -1);
  const restored = deserializeChunk(serializeChunk(chunk));
  equal(restored.code.some((instruction) => instruction.op === "MAKE_CLASS"), true);
  equal(restored.code.some((instruction) => instruction.op === "DEL_ATTR"), true);
  equal(restored.nested[0]?.name, "<class User>");
});
