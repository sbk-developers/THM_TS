import { SyntaxError } from "../../src/errors/errors.js";
import { tokenize } from "../../src/lexer/tokenizer.js";
import { assert, deepEqual, equal, test, throws } from "../harness.js";

test("lexer preserves statement newlines inside braces", () => {
  const tokens = tokenize("def f() {\n  value = {\n    \"key\": 1\n  }\n  return value\n}\n");
  equal(tokens.filter((token) => token.kind === "newline").length, 6);
});

test("lexer suppresses newlines only in parens, brackets and continuations", () => {
  const tokens = tokenize("x = (1,\n  2)\ny = [3,\n  4]\nz = 1 +\n  2\nw = 5, \\\n  6\n");
  const lines = tokens.filter((token) => token.kind === "newline").length;
  equal(lines, 4);
});

test("lexer treats LF and CRLF as the same statement boundaries", () => {
  const lf = tokenize("a = 1\nb = 2\n").map((token) => [token.kind, token.value]);
  const crlf = tokenize("a = 1\r\nb = 2\r\n").map((token) => [token.kind, token.value]);
  deepEqual(crlf, lf);
});

test("lexer preserves brace newlines and recognizes f-string tokens", () => {
  const tokens = tokenize('data = {\n "x": f"value {x + 1}"\n}\n');
  assert(tokens.some((token) => token.kind === "fstring" && token.value === "value {x + 1}"));
  equal(tokens.filter((token) => token.kind === "newline").length, 3);
});

test("lexer rejects unsupported escapes and unmatched delimiters", () => {
  throws(() => tokenize('"bad\\q"'), (error) => error instanceof SyntaxError);
  throws(() => tokenize("]"), (error) => error instanceof SyntaxError);
});

test("lexer handles BOM, raw/triple strings, escapes, and source spans", () => {
  const [raw, triple, escaped, eof] = tokenize(
    "\uFEFFr'raw\\n' \"\"\"first\r\nsecond\"\"\" '\\0\\x41\\u0042'",
    "sample.thm",
  );
  assert(raw !== undefined && triple !== undefined && escaped !== undefined && eof !== undefined);
  equal(raw.value, "raw\\n");
  equal(raw.file, "sample.thm");
  equal(raw.column, 1);
  equal(raw.length, 8);
  equal(triple.value, "first\nsecond");
  equal(triple.line, 1);
  equal(escaped.value, "\0AB");
  equal(eof.file, "sample.thm");
  equal(eof.length, 0);
});

test("lexer recognizes all number bases, decimal forms, and underscores", () => {
  const numbers = tokenize("0xff 0b101 0o17 1_000 .5 1.5 1e3")
    .filter((token) => token.kind === "number")
    .map((token) => Number(token.value.split("_").join("")));
  deepEqual(numbers, [255, 5, 15, 1000, 0.5, 1.5, 1000]);
  throws(() => tokenize("0x"), (error) => error instanceof SyntaxError);
  throws(() => tokenize("1__0"), (error) => error instanceof SyntaxError);
});

test("lexer recognizes every specified operator as a complete token", () => {
  const operators = tokenize("+ - * / // % ** == != < > <= >= = += -= *= /= //= %= **= & | ^ ~ << >> -> . , : ; ( ) [ ] { } @")
    .filter((token) => token.kind === "operator" || token.kind === "newline")
    .map((token) => token.value);
  deepEqual(operators, [
    "+", "-", "*", "/", "//", "%", "**", "==", "!=", "<", ">", "<=", ">=", "=", "+=", "-=", "*=", "/=", "//=", "%=", "**=",
    "&", "|", "^", "~", "<<", ">>", "->", ".", ",", ":", "\n", "(", ")", "[", "]", "{", "}", "@",
  ]);
});

test("lexer preserves all required keywords and treats dunder names as identifiers", () => {
  const words = "if elif else while for in def return class break continue pass try except finally raise import from as and or not is lambda global nonlocal true false none";
  const values = tokenize(`${words} __init__ __str__ __name__`)
    .filter((token) => token.kind !== "eof")
    .map((token) => token.value);
  deepEqual(values, [...words.split(" "), "__init__", "__str__", "__name__"]);
  const identifiers = tokenize("__init__ __str__ __name__").filter((token) => token.kind !== "eof");
  assert(identifiers.every((token) => token.kind === "identifier"));
});

test("lexer decodes every specified escape and honors comments and whitespace", () => {
  const source = " \tvalue = \"\\n\\t\\r\\\\\\'\\\"\\0\\x41\\u0042\" # ignored\n";
  const tokens = tokenize(source);
  const literal = tokens.find((token) => token.kind === "string");
  assert(literal !== undefined);
  equal(literal.value, "\n\t\r\\'\" \0AB".replace(" ", ""));
  equal(tokens.filter((token) => token.value === "#").length, 0);
  equal(tokens[0]?.column, 3);
});
