# THM project progress

The project is incomplete. Do not treat this file as a compliance claim.

| Stage | Status | Latest evidence | Known gaps |
|---|---|---|---|
| 1. ScriptC, platform, setup, harness | Foundation complete | `npm test` → 109 passed; `npm run build` → exit 0; ScriptC 0.4.8 | Platform uses ScriptC-lowered Node-compatible shims despite the literal source-level ban |
| 2. Tokenizer | Implemented; gate not formally closed | Lexer coverage is included in the passing test suite; raw/triple strings, escapes, spans, numeric token forms, operators, BOM, comments, LF/CRLF and continuations covered | Full language numeric acceptance remains |
| 3. AST and parser | In progress | Lambdas, keyword/star arguments, generic classes, `while-else`, comprehensions (list/set/dict/generator), bare generator-expression call arguments, and `None`/`True`/`False` literals | Full required grammar and all acceptance cases remain |
| 4. Semantic analysis | In progress | Separate scope analyzer is integrated; capture metadata, declarations, targets and control-flow checks are tested | Full specification-level validation remains |
| 5. Bytecode | In progress | Version-6 field-oriented binary container; class-construction opcode, validation, disassembler, and parameter/call metadata round trips | Full opcode metadata/format acceptance and remaining VM-required opcodes |
| 6. Runtime values/object model | In progress | Managed classes/instances, C3 MRO, descriptors, metaclasses and magic-method dispatch have regression coverage; `__str__`/`__repr__` honored by stringify | Complete object protocol and full acceptance |
| 7. VM | In progress | Module loading, class features, generic class metadata, `while-else`, expanded argument binding, and working generator/`yield` suspension+resume (loop iterator preserved across yields); 109 tests pass | Complete builtins, full frame semantics, async generators |
| 8. Functions/classes/exceptions | In progress | Closures, recursion, defaults, keyword-only/variadic args, keyword calls, unpacking, generic classes, `while-else`, descriptors, decorators and `super()` tested; `raise`/`try`/`except`/`finally` unwinding works including through callback boundaries | `else` on try, exception `__traceback__` chaining details |
| 9. Builtins | Partial | A subset of builtins and methods exist (per user request, standard-library breadth is out of scope for this pass) | Full required builtin and string/list/dict/set APIs |
| 10. Module loader | Working for common cases | Separate resolver, package-relative resolution, cache and import integration tests exist; circular imports terminate (module registered before execution) | Full import acceptance remains |
| 11. Standard library | Not passed (intentionally skipped per user request) | Not implemented | Required bundled modules and integration tests |
| 12. Tracebacks | Implemented (basic) | Uncaught exceptions print `Traceback (most recent call last):` with file, line, function name and source line; attached to exception values via `readTraceback` | Caret diagnostics and import-chain frames |
| 13. CLI and `.thmc` | In progress | Source, compile, and run-bytecode paths work; native compile/run of `.thmc` verified; traceback reporting in CLI | Full required CLI forms and exact exit semantics |
| 14. Full acceptance | In progress | Latest `npm test`: 109 passed, 0 failed; `npm run build` succeeded | Required language coverage, stress/integration tests, and all acceptance checks |

Latest verification: `npm test` reports 109 passed and zero failed. Since the
2026-11-23 pass: generator expressions `(x for x in xs)` (including the bare
`f(x for x in xs)` call form), generator functions with `yield` inside loops
(iterators survive suspension), `is None` singleton identity, `None`/`True`/
`False` capitalized literals, user-defined `__str__`/`__repr__` used by
`str()`/`print()`, uncaught-exception tracebacks with source lines, and
circular-import termination. Passing the current tests does not mean the full
THM language or acceptance suite is complete.

## OOP decorator work (2026-11-06)

- Enabled generic function decorators in the compiler.
- Enabled generic class decorators in the compiler.
- Decorators are applied bottom-up (`@outer` over `@inner` becomes `outer(inner(value))`).
- Added an integration regression test for stacked function decorators and a class decorator.
- Implemented after this note: `staticmethod`, `classmethod`, `property`, custom descriptor protocol (`__get__`, `__set__`, `__delete__`), and metaclasses.

## Generator/comprehension/traceback pass (2026-11-23)

- Parser: parenthesized generator expressions compile to lazy generators
  (`container: "generator"` comprehension backed by a nested generator chunk).
- Parser: bare generator call arguments (`", ".join(x for x in xs)`).
- Parser: `None`, `True`, `False` accepted as capitalized literals.
- Compiler: generator comprehensions compile the clauses to a real generator
  function and call it; `yield` statements inside generated clause loops.
- VM: `YIELD` clears its scratch slot, suspension truncates to stackBase,
  resume pads one slot, and the generator's in-flight loop iterator is
  preserved on the generator object (`loopIterator`) so `for`-loop generators
  survive suspend/resume cycles.
- VM: RETURN from an exhausted generator frame drops its scratch slot.
- VM: `is`/`is not` treat all none values as the same singleton.
- VM: `str()`/`print()` on instances call user `__str__` (and `__repr__` for
  repr contexts) with a safe fallback on error.
- VM: traceback capture tolerates missing instructions; uncaught exceptions in
  the CLI print frames with filename, line, function and source line.
