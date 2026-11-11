import { analyzeScope } from "../../src/semantic-analyzer/analyzer.js";
import { compile } from "../../src/compiler.js";
import { SyntaxError } from "../../src/errors/errors.js";
import { parse } from "../../src/parser/parser.js";
import { assert, equal, test, throws } from "../harness.js";

test("semantic analysis resolves captures before bytecode generation", () => {
  const chunk = compile(parse(
    "def outer() {\n" +
      " value = 10\n" +
      " def inner() { return value }\n" +
      " return inner\n" +
      "}\n",
  ));
  const outer = chunk.nested[0];
  assert(outer !== undefined);
  const inner = outer.nested[0];
  assert(inner !== undefined);
  const load = inner.code.find((instruction) => instruction.op === "LOAD");
  assert(load !== undefined);
  equal(load.text, "closure");
});

test("semantic analysis leaves undefined names dynamic and bare annotations unbound", () => {
  const bare = analyzeScope(parse("value: int\n").statements, {
    isFunction: false,
    parameters: [],
    enclosingNames: new Set(),
  });
  equal(bare.localNames.size, 0);

  const assignment = analyzeScope(parse('value: unknown = "ok"\n').statements, {
    isFunction: false,
    parameters: [],
    enclosingNames: new Set(),
  });
  assert(assignment.localNames.has("value"));

  const unresolved = compile(parse("write(undefined_name)\n"));
  assert(unresolved.code.some((instruction) => instruction.op === "LOAD"));
});

test("semantic analysis rejects invalid assignment targets", () => {
  throws(
    () => compile(parse("call() = 1\n")),
    (error) => error instanceof SyntaxError && error.message.includes("Invalid assignment target"),
  );
});
