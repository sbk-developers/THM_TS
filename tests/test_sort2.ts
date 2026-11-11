import { compile } from "../src/compiler.js";
import { parse } from "../src/parser/parser.js";
import { VM } from "../src/vm/vm.js";
import type { Platform } from "../src/platform/platform.js";
import { equal, test, runTests } from "./harness.js";

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
    stdout: (text: string) => output.push(text),
    stderr: () => undefined,
    args: () => [],
    exit: () => { throw new Error("unexpected exit"); },
    cwd: () => "/test",
    joinPath: (...parts: string[]) => parts.join("/"),
    clock: () => 0,
  };
  new VM(platform).run(compile(parse(source), "test.thm"));
  return output.join("");
}

test("list sort reverse", () => {
  const result = run("l = [3, 1, 2]\nl.sort(reverse=true)\nwrite(l)\n");
  console.log("Result:", JSON.stringify(result));
  equal(result, "[3, 2, 1]\n");
});

runTests();