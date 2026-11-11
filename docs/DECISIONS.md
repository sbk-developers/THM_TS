# THM implementation decisions

## Confirmed decisions

- Blocks use braces, while indentation is whitespace only.
- Annotations and generic parameters are metadata; they do not enforce types.
- The native heap collector tracks logical managed objects. ScriptC controls
  physical memory reclamation.
- UTF-8 source and host files are read through the platform boundary.
- Unsupported syntax must fail explicitly; it must not be reinterpreted.
- The correction addendum takes precedence over conflicting original details.

## Known deviations awaiting implementation

- Source modules are being moved into the required compiler, VM, runtime,
  errors, loader, builtins, and CLI areas. Components still grouped together
  are listed in `PROGRESS.md`.
- `.thmc` version 6 uses a checksummed, field-oriented binary payload and a
  separate disassembler. Opcode ordering is part of the versioned format.
- The platform adapter uses ScriptC's Node-compatible host shims because the
  inspected ScriptC package exposes filesystem and process operations through
  those declarations. No Node.js runtime is embedded, but the literal
  source-level ban is not yet satisfied.
- Integers are represented as arbitrary-precision `bigint` values and floats
  as JavaScript `number` values. Range/index APIs still use safe-range numbers.
- Classes, exception unwinding, imports, and the bundled standard library are
  incomplete. See `PROGRESS.md` for current gate status.
