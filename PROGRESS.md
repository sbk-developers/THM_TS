# THM project progress

The project is incomplete. Do not treat this file as a compliance claim.

| Stage | Status | Latest evidence | Known gaps |
|---|---|---|---|
| 1. ScriptC, platform, setup, harness | Foundation complete | Latest `npm test` → 77 passed; `npm run build` → exit 0; ScriptC 0.4.8 | Platform uses ScriptC-lowered Node-compatible shims despite the literal source-level ban |
| 2. Tokenizer | Implemented; gate not formally closed | Lexer coverage is included in the passing test suite; raw/triple strings, escapes, spans, numeric token forms, operators, BOM, comments, LF/CRLF and continuations covered | Full language numeric acceptance remains |
| 3. AST and parser | In progress | Lambdas, keyword/star arguments, generic classes, and `while-else` are covered | Full required grammar and all acceptance cases remain |
| 4. Semantic analysis | In progress | Separate scope analyzer is integrated; capture metadata, declarations, targets and control-flow checks are tested | Full specification-level validation remains |
| 5. Bytecode | In progress | Version-6 field-oriented binary container; class-construction opcode, validation, disassembler, and parameter/call metadata round trips | Full opcode metadata/format acceptance and remaining VM-required opcodes |
| 6. Runtime values/object model | In progress | Managed classes/instances, C3 MRO, descriptors, metaclasses and magic-method dispatch have regression coverage | Complete object protocol and full acceptance |
| 7. VM | In progress | Module loading, class features, generic class metadata, `while-else`, and expanded argument binding; 77 tests pass and native build succeeds | Exception unwinding, complete builtins, full frame/traceback semantics |
| 8. Functions/classes/exceptions | In progress | Closures, recursion, defaults, keyword-only/variadic args, keyword calls, unpacking, generic classes, `while-else`, descriptors, decorators and `super()` tested | `raise`/`assert`/`try`, finally unwinding |
| 9. Builtins | Not passed | A subset of builtins and methods exist | Full required builtin and string/list/dict/set APIs |
| 10. Module loader | In progress | Separate resolver, package-relative resolution, cache and import integration tests exist | Circular-import states and full import acceptance remain |
| 11. Standard library | Not passed | Not implemented | Required bundled modules and integration tests |
| 12. Tracebacks | Not passed | Not implemented | Source lines, caret diagnostics, frame/import tracebacks |
| 13. CLI and `.thmc` | In progress | Source, compile, and run-bytecode paths work; native compile/run of `.thmc` verified | Full required CLI forms and exact exit semantics |
| 14. Full acceptance | Not passed | Latest `npm test`: 77 passed, 0 failed; `npm run build` succeeded | Required language coverage, stress/integration tests, and all acceptance checks |

Latest verification: `npm test` reports 77 passed and zero failed; `npm run
build` succeeds with ScriptC 0.4.8. Function defaults, keyword-only and
variadic arguments, keyword calls, unpacking, class constructor keywords, and
serialized call metadata are covered. Generic classes currently retain type
parameters as metadata only. Passing the current tests does not mean the full
THM language or acceptance suite is complete.

## OOP decorator work (2026-11-06)

- Enabled generic function decorators in the compiler.
- Enabled generic class decorators in the compiler.
- Decorators are applied bottom-up (`@outer` over `@inner` becomes `outer(inner(value))`).
- Added an integration regression test for stacked function decorators and a class decorator.
- Implemented after this note: `staticmethod`, `classmethod`, `property`, custom descriptor protocol (`__get__`, `__set__`, `__delete__`), and metaclasses.
