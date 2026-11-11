import { parse, parseExpression } from "../../src/parser/parser.js";
import { SyntaxError } from "../../src/errors/errors.js";
import { assert, equal, test } from "../harness.js";

test("parser distinguishes code blocks from multiline dictionaries", () => {
  const program = parse(
    'def test() {\n  data = {\n    "name": "Sobuj",\n    "age": 20\n  }\n  write(data.name)\n}\n',
  );
  equal(program.statements.length, 1);
  const fn = program.statements[0];
  assert(fn?.kind === "function");
  equal(fn.body.length, 2);
  const assignment = fn.body[0];
  assert(assignment?.kind === "assign");
  assert(assignment.value.kind === "dict");
  equal(assignment.value.items.length, 2);
});

test("parser treats empty braces at expression position as a dictionary", () => {
  const program = parse("if condition == ({}) {\n  pass\n}\n");
  const statement = program.statements[0];
  assert(statement?.kind === "if");
  assert(statement.condition.kind === "compare");
  const empty = statement.condition.rest[0]?.right;
  assert(empty?.kind === "dict");
  equal(empty.items.length, 0);
});

test("parser preserves annotation and generic syntax as metadata", () => {
  const program = parse(
    'a: int = "Hello"\ndef identity[T](value: list[str]) -> dict[str, int] {\n  return value\n}\n',
  );
  const annotation = program.statements[0];
  const fn = program.statements[1];
  assert(annotation?.kind === "annotate");
  equal(annotation.annotation, "int");
  assert(fn?.kind === "function");
  equal(fn.typeParameters[0], "T");
  equal(fn.parameters[0]?.annotation, "list [ str ]");
  equal(fn.returnAnnotation, "dict [ str , int ]");
});

test("parser constructs tuple assignments and chained assignments", () => {
  const program = parse("a, b = 10, 20\nx = y = 10\n");
  const tupleAssignment = program.statements[0];
  const chainedAssignment = program.statements[1];
  assert(tupleAssignment?.kind === "assign");
  assert(tupleAssignment.targets[0]?.kind === "tuple");
  assert(tupleAssignment.value.kind === "tuple");
  assert(chainedAssignment?.kind === "assign");
  equal(chainedAssignment.targets.length, 2);
});

test("parser handles precedence, chained comparisons and nested f-strings", () => {
  const negative = parseExpression("-2 ** 2");
  assert(negative.kind === "unary");
  assert(negative.operand.kind === "binary");
  equal(negative.operand.operator, "**");

  const comparison = parseExpression("a is not b and 0 < 1 < 2");
  assert(comparison.kind === "binary");
  const firstComparison = comparison.left;
  assert(firstComparison.kind === "compare");
  equal(firstComparison.rest[0]?.operator, "is not");
  assert(comparison.right.kind === "compare");
  equal(comparison.right.rest.length, 2);

  const nested = parseExpression("f\"Nested: {f'Value {age}'}\"");
  assert(nested.kind === "fstring");
  const interpolation = nested.parts.find((part) => typeof part !== "string");
  assert(interpolation !== undefined && typeof interpolation !== "string");
  assert(interpolation.kind === "fstring");
});

test("parser concatenates adjacent string literals", () => {
  const expression = parseExpression('"a" "b"');
  assert(expression.kind === "literal");
  equal(expression.value, "ab");
});

test("parser builds list, set, and dict comprehensions with filters and nested clauses", () => {
  const list = parseExpression("[x * 2 for x in values if x > 1]");
  assert(list.kind === "comprehension");
  equal(list.container, "list");
  equal(list.clauses.length, 1);
  equal(list.clauses[0]?.filters.length, 1);

  const set = parseExpression("{x for x in left for y in right if y > 0}");
  assert(set.kind === "comprehension");
  equal(set.container, "set");
  equal(set.clauses.length, 2);

  const dictionary = parseExpression("{x: x * x for x in values if x != 0}");
  assert(dictionary.kind === "comprehension");
  equal(dictionary.container, "dict");
  assert(dictionary.key?.kind === "name");
});

test("parser handles lambda expressions, call arguments, and parameter kinds", () => {
  const expression = parseExpression("lambda x, y: x | y ^ 2 & 3 << 1");
  assert(expression.kind === "lambda");
  equal(expression.parameters.length, 2);
  assert(expression.body.kind === "binary");
  equal(expression.body.operator, "|");

  const call = parseExpression("f(1, name=2, *items, **options)");
  assert(call.kind === "call");
  equal(call.args.map((argument) => argument.kind).join(","), "positional,keyword,star,keywordStar");

  const program = parse("def f(a=1, *args, flag, **kwargs) {\n pass\n}\n");
  const fn = program.statements[0];
  assert(fn?.kind === "function");
  equal(fn.parameters.map((parameter) => parameter.kind).join(","), "positional,vararg,keywordOnly,kwarg");
});

test("parser reports unsupported syntax by construct", () => {
  for (const [source, construct] of [
    ["with resource {}", "with"],
    ["match value {}", "match"],
    ["value := 1", "Walrus"],
    ["from module import *", "import *"],
  ] as const) {
    let caught = false;
    try {
      parse(source);
    } catch (error) {
      assert(error instanceof SyntaxError);
      assert(error.message.includes(construct), error.message);
      caught = true;
    }
    assert(caught, `Expected ${construct} syntax to be rejected`);
  }
  const assertion = parse("assert true\n").statements[0];
  assert(assertion?.kind === "assert");
  equal(parse("with = 2\ndel = 3\nmatch = 4\n").statements.length, 3);
});
