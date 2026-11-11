import { compile } from "../../src/compiler.js";
import { parse } from "../../src/parser/parser.js";
import { VM } from "../../src/vm/vm.js";
import type { Platform } from "../../src/platform/platform.js";
import { equal, test } from "../harness.js";

function run(source: string): string {
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
  new VM(platform).run(compile(parse(source), "test.thm"));
  return output.join("");
}

test("import random works and seeding is reproducible", () => {
  equal(
    run("import random\nrandom.seed(7)\na = random.randint(1, 1000)\nrandom.seed(7)\nwrite(a == random.randint(1, 1000))\n"),
    "true\n",
  );
  equal(run("from random import choice\nwrite(choice([4]))\n"), "4\n");
});

test("str methods", () => {
  equal(run('write("Hello".upper(), "a,b".split(","), " x ".strip(), "-".join(["a", "b"]))\n'), 'HELLO ["a", "b"] x a-b\n');
  equal(run('write("abc".center(9, "*"), "5".zfill(3), "aXb".replace("X", "-"))\n'), "***abc*** 005 a-b\n");
});

test("list, dict and set methods", () => {
  equal(run("l = [3, 1, 2]\nl.sort(reverse=true)\nwrite(l)\n"), "[3, 2, 1]\n");
  equal(run('d = {"a": none}\nwrite(d.get("a", 5))\n'), "none\n");
  equal(run("s = {1, 2}\nwrite(s.issubset({1, 2, 3}), s | {9}, s & {1})\n"), "true {1, 2, 9} {1}\n");
});

test("del and slice assignment", () => {
  equal(run('d = {"x": 1, "y": 2}\ndel d["x"]\nl = [1, 2, 3, 4]\ndel l[1:3]\nl[0:1] = [7, 8]\nwrite(d, l)\n'), '{"y": 2} [7, 8, 4]\n');
});

test("adjacent strings and integral float display", () => {
  equal(run('write("a" "b", 10 / 5)\n'), 'ab 2\n');
});
