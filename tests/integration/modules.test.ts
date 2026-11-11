import {
  registerBuiltinGlobalFunction,
  registerBuiltinGlobalValue,
  registerBuiltinModule,
} from "../../src/builtins/index.js";
import { compile } from "../../src/compiler.js";
import { parse } from "../../src/parser/parser.js";
import { ThmImportError, ThmTypeError } from "../../src/errors/errors.js";
import type { Platform } from "../../src/platform/platform.js";
import { VM } from "../../src/vm/vm.js";
import { equal, test, throws } from "../harness.js";

function run(source: string, files: Record<string, string> = {}): string {
  const output: string[] = [];
  const platform: Platform = {
    readFile: (filePath) => {
      const contents = files[filePath];
      if (contents === undefined) throw new Error(`Missing test file ${filePath}`);
      return contents;
    },
    writeFile: () => undefined,
    readBinaryFile: () => new Uint8Array(),
    writeBinaryFile: () => undefined,
    exists: (filePath) => files[filePath] !== undefined,
    listDir: () => ["entry"],
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

test("imports modules from the project directory and caches their execution", () => {
  equal(
    run(
      "value = 99\nimport helper\nimport helper as again\nwrite(helper.get(), again.value, value)\n",
      {
        "/project/helper.thm": "value = 7\nwrite('loaded')\ndef get() { return value }\n",
      },
    ),
    "loaded\n7 7 99\n",
  );
});

test("imports packages from lib, runs __init__.thm, and supports relative imports", () => {
  equal(
    run(
      "from packs import greeting\nimport packs as package\nwrite(greeting, package.greeting, package.__name__)\n",
      {
        "/project/lib/packs/__init__.thm": "from .child import greeting\n",
        "/project/lib/packs/child.thm": 'greeting = "hello from package"\n',
      },
    ),
    "hello from package hello from package packs\n",
  );
});

test("imports built-in modules and supports from-import aliases", () => {
  equal(
    run("import math as m\nfrom math import pi as circle\nwrite(m.sqrt(81), m.floor(2.8), circle == m.pi)\n"),
    "9 2 true\n",
  );
});

test("a module file can register an importable built-in module", () => {
  equal(
    run(
      'import test_sbk\nfrom test_sbk import greet as say_hello\n' +
        'write(test_sbk.author, test_sbk.greet("THM"), say_hello())\n',
    ),
    "SBK Hello, THM! Hello, world!\n",
  );
  throws(
    () => run('import test_sbk\ntest_sbk.greet(42)\n'),
    (error) => error instanceof ThmTypeError,
  );
});

test("the built-in os module exposes platform filesystem and path helpers", () => {
  equal(
    run(
      'import os\nfrom os import getcwd, join\n' +
        'write(getcwd(), os.exists("/project/helper.thm"), os.isdir("/project/helper.thm"))\n' +
        'write(os.listdir(), join("folder", "file.thm"))\n',
      { "/project/helper.thm": "" },
    ),
    '/project true false\n["entry"] folder/file.thm\n',
  );
  throws(
    () => run('import os\nos.exists(10)\n'),
    (error) => error instanceof ThmTypeError,
  );
});

test("built-in modules can be extended through the registration API", () => {
  registerBuiltinModule("test_extra", {
    values: { answer: 42 },
    functions: {
      greet: (_vm, _receiver, args) => `hello ${String(args[0] ?? "world")}`,
    },
  });
  equal(
    run("from test_extra import answer, greet\nwrite(answer, greet('THM'))\n"),
    "42 hello THM\n",
  );
});

test("registered built-in functions and values are installed in the global scope", () => {
  registerBuiltinGlobalValue("THM_TEST_VERSION", "dev");
  registerBuiltinGlobalFunction("thm_test_greet", (_vm, _receiver, args) => {
    if (args.length !== 1 || typeof args[0] !== "string") {
      throw new ThmTypeError("thm_test_greet() expects one string");
    }
    return `hello ${args[0]}`;
  });
  equal(
    run('write(THM_TEST_VERSION, thm_test_greet("THM"))\n'),
    "dev hello THM\n",
  );
  throws(
    () => registerBuiltinGlobalFunction("THM_TEST_VERSION", () => null),
    (error) => error instanceof Error && error.message.includes("already registered"),
  );
});

test("built-in module registration rejects ambiguous member definitions", () => {
  throws(
    () =>
      registerBuiltinModule("test_ambiguous", {
        functions: { duplicate: () => null },
        values: { duplicate: 1 },
      }),
    (error) => error instanceof Error && error.message.includes("both a function and a value"),
  );
});

test("missing modules raise an import error", () => {
  throws(
    () => run("import missing_module\n"),
    (error) => error instanceof ThmImportError,
  );
});
