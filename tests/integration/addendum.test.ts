import { compile } from "../../src/compiler.js";
import { deserializeChunk, serializeChunk } from "../../src/compiler/bytecode/bytecode.js";
import {
  CompileError,
  SyntaxError,
  ThmNameError,
  ThmTypeError,
  ThmValueError,
  ThmKeyError,
  RuntimeError,
} from "../../src/errors/errors.js";
import { tokenize } from "../../src/lexer/tokenizer.js";
import { parse, parseExpression } from "../../src/parser/parser.js";
import { VM } from "../../src/vm/vm.js";
import type { Platform } from "../../src/platform/platform.js";
import { assert, deepEqual, equal, test, throws } from "../harness.js";

function run(source: string, recursionLimit = 1000, useBytecodeFile = false): string {
  const output: string[] = [];
  const platform: Platform = {
    readFile: () => { throw new Error("not available"); },
    writeFile: () => undefined,
    readBinaryFile: () => new Uint8Array(),
    writeBinaryFile: () => undefined,
    exists: () => false,
    listDir: () => [],
    isDirectory: () => false,
    stdout: (text) => output.push(text),
    stderr: () => undefined,
    args: () => [],
    exit: () => { throw new Error("unexpected exit"); },
    cwd: () => "/test",
    joinPath: (...parts) => parts.join("/"),
    clock: () => 0,
  };
  const compiled = compile(parse(source), "test.thm");
  new VM(platform, recursionLimit).run(
    useBytecodeFile ? deserializeChunk(serializeChunk(compiled)) : compiled,
  );
  return output.join("");
}

test("Function parameter and call metadata survives binary bytecode round trips", () => {
  const source =
    "def choose(first, second=2, *rest, required, **options) {\n" +
    " write(first, second, rest, required, options)\n" +
    "}\n" +
    "choose(*[1, 3, 5], required=7, extra=9)\n";
  equal(run(source, 1000, true), "1 3 (5,) 7 {\"extra\": 9}\n");
});

test("A1: newlines preserved inside block bodies and dict literals", () => {
  const tokens = tokenize('def test() {\n    data = {\n        "name": "Sobuj",\n        "age": 20\n    }\n\n    write(data.name)\n}\n');
  // Newlines after {, after "Sobuj",, after 20, after }, after blank line, after write, after } => all statement/structural boundaries preserved as tokens
  equal(tokens.filter((t) => t.kind === "newline").length, 7);
});

test("A2: block vs empty dict vs dict/set in expressions", () => {
  const program = parse('if condition == ({}) {\n    write("OK")\n}\n');
  const stmt = program.statements[0];
  assert(stmt?.kind === "if");
  assert(stmt.condition.kind === "compare");
  const right = stmt.condition.rest[0]?.right;
  assert(right?.kind === "dict");
  equal(right.items.length, 0);
  const emptyExpr = parseExpression("{}");
  assert(emptyExpr.kind === "dict");
  equal(emptyExpr.items.length, 0);
});

test("A3/B1: f-strings and annotations are metadata only", () => {
  equal(
    run(
      'name = "Sobuj"\n' +
      'age = 20\n' +
      'write(f"Hello {name}")\n' +
      'write(f"Age: {age + 1}")\n' +
      'write(f"Result: {{literal braces}}")\n' +
      `write(f"Nested: {f'Value {age}'}")\n` +
      'a: int = "Hello"\n' +
      'write(a)\n' +
      'def test(value: list[str]) -> dict[str, int] {\n    return {}\n}\n' +
      'write(test("x"))\n',
    ),
    "Hello Sobuj\nAge: 21\nResult: {literal braces}\nNested: Value 20\nHello\n{}\n",
  );
  throws(() => run('x: int\nwrite(x)\n'), (e) => e instanceof ThmNameError);
  throws(() => run('value = 1\nwrite(f"{value:04}")\n'), (e) => e instanceof SyntaxError);
});

test("B2: generic declarations/subscriptions are metadata/runtime identity", () => {
  equal(
    run(
      'def identity[T](value: T) -> T {\n    return value\n}\n' +
      'write(identity[int](100), identity[str]("ok"))\n',
    ),
    '100 ok\n',
  );
});

test("C1-C4: assignment, unpacking, augmented once, slices", () => {
  equal(
    run(
      'calls = 0\n' +
      'def next_value() {\n    global calls\n    calls += 1\n    return calls\n}\n' +
      'a = b = c = next_value()\n' +
      'write(a, b, c, calls)\n' +
      'a, b = 10, 20\n' +
      'a, b = b, a\n' +
      'write(a, b)\n' +
      'items = [0, 1, 2, 3, 4]\n' +
      'write(items[1:4], items[:3], items[2:], items[::2], items[::-1])\n' +
      'idx = 0\n' +
      'def get_index() {\n    global idx\n    idx += 1\n    return 0\n}\n' +
      'items[get_index()] += 1\n' +
      'write(idx, items[0])\n',
    ),
    '1 1 1 1\n20 10\n[1, 2, 3] [0, 1, 2] [2, 3, 4] [0, 2, 4] [4, 3, 2, 1, 0]\n1 1\n',
  );
  throws(() => run('a, b = [1]\n'), (e) => e instanceof ThmValueError);
  throws(() => run('items = [1]\nitems[::0]\n'), (e) => e instanceof ThmValueError);
});

test("C5: short-circuit returns operands, comparisons, is/in, conditional, precedence", () => {
  equal(
    run(
      'calls = 0\n' +
      'def side() {\n    global calls\n    calls += 1\n    return 99\n}\n' +
      'write(0 and side(), 7 and 8, 0 or 9, 7 or side(), not 0, calls)\n' +
      'write(1 is not 2, "a" in "cat", "z" not in "cat")\n' +
      'write(4 if true else 5, 4 if false else 5)\n' +
      'write(-2 ** 2, 2 ** 3 ** 2)\n',
    ),
    '0 8 9 7 true 0\ntrue true true\n4 5\n-4 512\n',
  );
});

test("D1: closures use shared cells across calls", () => {
  equal(
    run(
      'def counter() {\n' +
      '    value = 0\n' +
      '    def increment() {\n' +
      '        nonlocal value\n' +
      '        value += 1\n' +
      '        return value\n' +
      '    }\n' +
      '    return increment\n' +
      '}\n' +
      'count = counter()\n' +
      'write(count())\n' +
      'write(count())\n',
    ),
    '1\n2\n',
  );
});

test("D2: scope validation errors", () => {
  throws(() => compile(parse('def f() {\n nonlocal missing\n}\n')), (e) => e instanceof SyntaxError);
  throws(() => compile(parse('return 1\n')), (e) => e instanceof SyntaxError);
  throws(() => compile(parse('break\n')), (e) => e instanceof SyntaxError);
  throws(() => compile(parse('continue\n')), (e) => e instanceof SyntaxError);
  throws(() => compile(parse('def f(a, a) {\n pass\n}\n')), (e) => e instanceof SyntaxError);
  throws(() => compile(parse('def f() {\n global x\n nonlocal x\n}\n')), (e) => e instanceof SyntaxError);
});

test("I1/I2/I4: bool/int semantics, floor/mod, hashing/key equivalence", () => {
  equal(
    run(
      'write(true + 1, isinstance(true, int), type(true) == bool, true == 1)\n' +
      'write(-7 // 2, -7 % 3)\n' +
      'd = {true: "first"}\n' +
      'd[1] = "updated"\n' +
      'write(len(d), d[true])\n',
    ),
    '2 true true true\n-4 2\n1 updated\n',
  );
});

test("J: dict attribute access precedence and bracket access", () => {
  equal(
    run(
      'd = {"keys": "item", "name": "Sobuj", "age": 20}\n' +
      'write(d.name, d["keys"], type(d.keys))\n' +
      'd.city = "Dhaka"\n' +
      'd["age"] = 21\n' +
      'write(d.city, d.age, d["age"])\n',
    ),
    'Sobuj item <class \'builtin_function\'>\nDhaka 21 21\n',
  );
  throws(() => run('d = {}\nwrite(d.missing)\n'), (e) => e instanceof ThmKeyError);
});

test("Decorators: generic function and class decorators apply bottom-up", () => {
  equal(
    run(
      'def add_one(fn) {\n    def wrapped() {\n        return fn() + 1\n    }\n    return wrapped\n}\n' +
      'def double(fn) {\n    def wrapped() {\n        return fn() * 2\n    }\n    return wrapped\n}\n' +
      '@add_one\n@double\ndef answer() {\n    return 20\n}\n' +
      'write(answer())\n' +
      'def rename(cls) {\n    cls.label = "decorated"\n    return cls\n}\n' +
      '@rename\nclass Item {\n}\n' +
      'write(Item.label)\n',
    ),
    '41\ndecorated\n',
  );
});

test("raise, assert, handlers, else, and finally unwind correctly", () => {
  equal(
    run(
      'try {\n' +
      '    raise ValueError("bad")\n' +
      '} except TypeError {\n' +
      '    write("wrong")\n' +
      '} except ValueError as error {\n' +
      '    write(error)\n' +
      '} else {\n' +
      '    write("else")\n' +
      '} finally {\n' +
      '    write("finally")\n' +
      '}\n' +
      'try {\n' +
      '    assert false, "failed"\n' +
      '} except AssertionError {\n' +
      '    write("assert caught")\n' +
      '}\n',
    ),
    "ValueError: bad\nfinally\nassert caught\n",
  );
  equal(
    run(
      'def result() {\n' +
      '    try {\n' +
      '        return 7\n' +
      '    } finally {\n' +
      '        write("return cleanup")\n' +
      '    }\n' +
      '}\n' +
      'write(result())\n' +
      'i = 0\n' +
      'while i < 2 {\n' +
      '    i += 1\n' +
      '    try {\n' +
      '        continue\n' +
      '    } finally {\n' +
      '        write("loop cleanup")\n' +
      '    }\n' +
      '}\n',
    ),
    "return cleanup\n7\nloop cleanup\nloop cleanup\n",
  );
  throws(
    () => run('try {\n    raise ValueError("bad")\n} except TypeError {\n    pass\n}\n'),
    (error) => error instanceof Error && error.name === "ValueError",
  );
  throws(
    () => run('try {\n    raise ValueError("bad")\n} except ValueError {\n    raise\n}\n'),
    (error) => error instanceof Error && error.name === "ValueError",
  );
});

test("try with else and finally (no except) runs finally on both paths", () => {
  equal(
    run(
      'try {\n' +
      '    write("try body")\n' +
      '} else {\n' +
      '    write("else body")\n' +
      '} finally {\n' +
      '    write("finally")\n' +
      '}\n' +
      'write("after")\n',
    ),
    "try body\nelse body\nfinally\nafter\n",
  );
  throws(
    () => run(
      'try {\n' +
      '    write("try body")\n' +
      '} else {\n' +
      '    raise ValueError("else error")\n' +
      '} finally {\n' +
      '    write("finally")\n' +
      '}\n',
    ),
    (error) => error instanceof Error && error.name === "ValueError",
  );
});
