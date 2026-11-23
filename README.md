# THM

THM is a TypeScript implementation of a brace-block scripting language. Its
source is organized into compiler front-end, bytecode, VM, runtime, platform,
error, and CLI areas under `src/`. The project is still being implemented
against the original Master Prompt and its correction addendum.

## Source layout

THM keeps each compiler/runtime responsibility in its own top-level module:

```text
src/
  loader/             Module-name and source-file resolution
  lexer/              Source text to tokens
  parser/             Tokens to AST
  semantic-analyzer/  Scope, symbol, and control-flow validation
  compiler/           Bytecode format, validation, and disassembler
  compiler.ts         AST to bytecode compiler
  vm/                 Stack VM and managed heap
  runtime/            THM values, environments, and object model
  builtins/           Built-in registry and built-in modules
  platform/           Host filesystem, process, and clock abstraction
  errors/             Compile-time, import, and runtime errors
  cli/                Command-line interface
tests/                Tests grouped by subsystem
examples/             Example THM programs
lib/                  Project/user THM modules and packages
docs/                 Design and bytecode documentation
```

The loader owns module-name normalization and file lookup. The VM owns module
execution and caching. The lexer, parser, semantic analyzer, compiler, bytecode
format, and VM can be tested independently. Built-in modules are registered
through `src/builtins/registry.ts`.

## Toolchain

The project is verified with ScriptC 0.4.8. ScriptC performs TypeScript
compilation and can build a native executable without requiring Node.js at
runtime.

```sh
npm install
npm run build
npm test
```

Run a supported example:

```sh
npm run thm -- examples/hello.thm
```

`.thmc` chunks can be compiled and run with:

```sh
./build/thm compile examples/core.thm -o /tmp/core.thmc
./build/thm run-bc /tmp/core.thmc
```

`Platform.clock()` is monotonic elapsed milliseconds. Files are read and
written as UTF-8. `joinPath()` uses the target platform's separator, paths
passed to filesystem methods are interpreted relative to `cwd()` unless
absolute, and host filesystem failures are converted to `PlatformError`.
`isDirectory()` follows symbolic links. `exit()` terminates the executable
with the supplied status code. THM's collector accounts for objects in its
logical heap; physical memory reclamation remains controlled by the host.

## Modules

`import name`, `import name as alias`, and `from name import member` are
supported. THM searches the user-supplied `-p` paths first (in the order
given), then the current working directory, then `lib/`; each location can
contain either `name.thm` or a package directory with an `__init__.thm`.
Packages can use relative imports such as
`from .helpers import format`. Imported modules execute once per VM and keep
their own global namespace.

The built-in `req` module provides HTTP-only `get(url)` (http/https URLs via
curl; local file access is intentionally not supported) returning a response
object with `status` and `text`. The `bytes` module rejects non-integer
values. Strings use Unicode code-point semantics: `len("😀") == 1`, indexing
and iteration yield whole characters.

The `random` built-in module provides `seed`, `random`, `randint`, `randrange`,
`uniform`, `gauss`, `getrandbits`, `choice`, `choices`, `shuffle`, and `sample`.
The `math` built-in module provides `pi`, `e`, `tau`, `sqrt`, `floor`, `ceil`,
`sin`, and `cos`. To add a built-in module:

1. Create `src/builtins/modules/greet.ts` and register its functions/constants.
2. Import `./modules/greet.js` in [src/builtins/index.ts](./src/builtins/index.ts).
   That entry point loads each module so it registers before the VM imports it.
3. Add a test under `tests/integration/` and run `npm test`.

[src/builtins/modules/test_sbk.ts](./src/builtins/modules/test_sbk.ts) is a
working example: it calls `registerBuiltinModule("test_sbk", { values, functions })`
and is loaded by [src/builtins/index.ts](./src/builtins/index.ts).

The built-in `os` module provides `getcwd()`, `exists(path)`, `isdir(path)`,
`listdir([path])`, and `join(...paths)`, backed by the host `Platform` API.
It also exposes `system(command)` (executes a host shell command — UNSAFE:
never run untrusted THM scripts that import `os`), plus `platform()`,
`arch()`, `version()`, and `cpus()` host information functions.

```thm
import os
from os import getcwd, join

write(getcwd())
write(os.exists("data.txt"), os.isdir("lib"))
write(os.listdir("lib"))
write(join("lib", "helpers.thm"))
```

`listdir()` with no argument lists the current directory. These functions
accept path strings; filesystem errors from `listdir()` are surfaced as
runtime errors.

For example, the implementation file can register a native function and a
constant:

```ts
import { ThmTypeError } from "../../errors/errors.js";
import { registerBuiltinModule } from "../registry.js";

registerBuiltinModule("greet", {
  values: { default_name: "world" },
  functions: {
    hello: (_vm, _receiver, args) => {
      if (args.length > 1) throw new ThmTypeError("hello() accepts zero or one argument");
      const name = args[0] ?? "world";
      if (typeof name !== "string") throw new ThmTypeError("hello() name must be a string");
      return `Hello, ${name}!`;
    },
  },
});
```

`functions` callbacks use the signature
`(vm, receiver, args) => value`; `args` contains the THM arguments and the
return value must be a THM `Value`. Throw a THM error for invalid arguments.
Use `values` for exported constants. The registry rejects duplicate module
names and invalid identifiers. Built-ins are implemented in THM's TypeScript
source, not dynamically loaded plugins.

After registering the example, THM programs can use it like any other module:

```thm
import greet
from greet import hello as say_hello

write(greet.default_name)
write(say_hello("THM"))
```

`registerBuiltinModule()` and its types live in
[src/builtins/registry.ts](./src/builtins/registry.ts); built-in implementations
are kept separate under [src/builtins/modules/](./src/builtins/modules/).

### Add a global built-in function or value

You can register a global function or initial value from the same
`src/builtins/modules/` implementation file. Import the registration helpers
from `../registry.js`, then add that file to `src/builtins/index.ts`:

```ts
import { ThmTypeError } from "../../errors/errors.js";
import {
  registerBuiltinGlobalFunction,
  registerBuiltinGlobalValue,
} from "../registry.js";

registerBuiltinGlobalValue("APP_NAME", "THM");
registerBuiltinGlobalFunction("greet", (_vm, _receiver, args) => {
  if (args.length > 1) throw new ThmTypeError("greet() accepts zero or one argument");
  const name = args[0] ?? "world";
  if (typeof name !== "string") throw new ThmTypeError("greet() name must be a string");
  return `Hello, ${name}!`;
});
```

THM code can call these without importing a module:

```thm
write(APP_NAME)
write(greet("Sobuj"))
```

Global values are initial primitive values and can be reassigned in THM code.
Global function/value names must be unique and must not shadow an existing
core built-in. The registry reports conflicts instead of silently replacing
an existing name. `registerBuiltinGlobalFunction()` callbacks receive
`(vm, receiver, args)` and return a THM value; validate arguments and throw a
THM error for invalid input.

## Functions and classes

Functions support positional defaults, variadic positional and keyword-only
parameters, keyword arguments, and `*`/`**` call unpacking. Defaults are
evaluated when the function is created. Classes use brace blocks; `__init__`
initializes instances, and methods use an explicit first parameter. Multiple
inheritance uses C3 MRO; overridden methods can use zero-argument `super()`.
The runtime also implements properties, static/class methods, custom
descriptors, decorators, metaclasses, and magic-method operator dispatch.
Generic class parameters are retained as metadata; subscriptions such as
`Box[int]` do not enforce runtime types.

```thm
class Animal {
    def __init__(self, name) { self.name = name }
    def speak(self) { return self.name + " makes a sound" }
}

class Dog(Animal) {
    def speak(self) { return super().speak() + " and barks" }
}

dog = Dog("Rex")
write(dog.speak())
write(isinstance(dog, Dog), isinstance(dog, Animal))
```

`raise`/`assert`/`try` work, including `try/finally` unwinding and nested
handlers. Comprehensions are supported in all four forms — list, set, dict,
and lazy generator expressions — including the bare call form
(`", ".join(x for x in xs)`). Adjacent string literals concatenate. Instance
custom `__str__`/`__repr__` methods are used by `str()`, `print()` and f-strings.
`None`, `True`, and `False` are recognized literals, and `is` treats `None` as
a singleton. Uncaught exceptions print a Python-style traceback with source
lines. Remaining gaps are broader standard-library coverage (tracked in
[PROGRESS.md](./PROGRESS.md)) and full acceptance tests.

## Current status

ScriptC 0.4.8 has been verified for TypeScript compilation, native builds,
filesystem access, stdout/stderr, CLI arguments, exit status, path operations
and a monotonic clock.

The lexer supports raw/triple-quoted strings, escapes, source spans,
decimal/base-prefixed number tokens, and the specified operators. The bytecode
format has a versioned binary container, validation, and a disassembler.
Integer literals use arbitrary-precision integers; floats use binary
floating-point. The parser, semantic analyzer, compiler, VM, module imports,
functions, object model, and collection operations are implemented to varying
degrees and covered by tests. The full language is **not complete**: the
standard library (intentionally deferred), full built-in coverage, caret
diagnostics in tracebacks, and full acceptance remain open. Generator
functions with `yield`, generator expressions, and circular imports are
working. See
[PROGRESS.md](./PROGRESS.md) for tracked gaps.

See [PROGRESS.md](./PROGRESS.md) for gate status,
[docs/DECISIONS.md](./docs/DECISIONS.md) for deviations, and
[docs/SCRIPTC_NOTES.md](./docs/SCRIPTC_NOTES.md) for toolchain evidence.
Physical memory reclamation is controlled by ScriptC's host runtime; THM's
collector only tracks logical managed objects. The latest available verification
ran `npm test` and `npm run build`; these are verification results, not full
specification acceptance.
