import { compile } from "../../src/compiler.js";
import { parse } from "../../src/parser/parser.js";
import { SyntaxError } from "../../src/errors/errors.js";
import type { Platform } from "../../src/platform/platform.js";
import { VM } from "../../src/vm/vm.js";
import { equal, test, throws } from "../harness.js";

function run(source: string): string {
  const output: string[] = [];
  const platform: Platform = {
    readFile: () => {
      throw new Error("unexpected read");
    },
    writeFile: () => undefined,
    readBinaryFile: () => new Uint8Array(),
    writeBinaryFile: () => undefined,
    exists: () => false,
    listDir: () => [],
    isDirectory: () => false,
    stdout: (text) => output.push(text),
    stderr: () => undefined,
    args: () => [],
    exit: () => {
      throw new Error("unexpected exit");
    },
    cwd: () => "/project",
    joinPath: (...segments) => segments.join("/"),
    clock: () => 0,
  };
  new VM(platform).run(compile(parse(source), "/project/main.thm"));
  return output.join("");
}

test("async def returns a coroutine that runs when awaited", () => {
  equal(
    run(
      "async def greet(name) {\n" +
        '    return "hello " + name\n' +
        "}\n" +
        'write(await greet("THM"))\n',
    ),
    "hello THM\n",
  );
});

test("awaiting a non-coroutine value returns it unchanged", () => {
  equal(run("value = 41\nwrite(await value + 1)\n"), "42\n");
});

test("await is rejected outside async functions", () => {
  throws(
    () => compile(parse("def f() { x = await 1 }\n")),
    (error) => error instanceof SyntaxError,
  );
  // Module/top-level await is allowed in THM scripts.
  compile(parse("x = await 1\n"));
});

test("async functions can await other async functions and use control flow", () => {
  equal(
    run(
      "async def add(a, b) { return a + b }\n" +
        "async def compute() {\n" +
        "    total = 0\n" +
        "    for value in [1, 2, 3] {\n" +
        "        total = await add(total, value)\n" +
        "    }\n" +
        "    return total\n" +
        "}\n" +
        "write(await compute())\n",
    ),
    "6\n",
  );
});

test("async def works with closures, defaults, and keyword arguments", () => {
  equal(
    run(
      "def make(prefix) {\n" +
        "    async def format(name, suffix = '!') {\n" +
        "        return prefix + name + suffix\n" +
        "    }\n" +
        "    return format\n" +
        "}\n" +
        "formatter = make('hi ')\n" +
        "write(await formatter(name = 'THM', suffix = '?'))\n",
    ),
    "hi THM?\n",
  );
});

test("exceptions from awaited async functions propagate", () => {
  throws(
    () =>
      run(
        'async def fail() { raise ValueError("boom") }\n' +
          "async def main() { return await fail() }\n" +
          "write(await main())\n",
      ),
    (error) => error instanceof Error && error.name === "ValueError",
  );
});
