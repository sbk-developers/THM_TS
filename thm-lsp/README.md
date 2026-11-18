# THM Language Server

A TypeScript Language Server Protocol (LSP) implementation for THM 0.3.0. It aims for a Python/JavaScript-style editor experience while respecting THM syntax and brace-delimited blocks.

## Requirements

- Node.js 18 or newer
- VS Code, or another editor with LSP support

## Build and run

```bash
npm install
npm run build
node out/cli.js --stdio
```

Run the end-to-end protocol tests with:

```bash
npm test
```

## VS Code setup

For a manual VS Code setup, configure the THM extension/client to launch:

```json
{
  "thm.server.path": "node",
  "thm.server.args": ["/absolute/path/to/thm-lsp/out/cli.js", "--stdio"],
  "thm.languageId": "thm",
  "thm.fileExtensions": [".thm"]
}
```

The setting names above are an example client configuration; a VS Code extension must register the language client and pass the executable/arguments to it.

## Editor features

### IntelliSense

- Scope-aware completion for locals, parameters, globals, classes, functions, imports, built-ins and modules.
- Type-aware member completion for inferred instances, class members, built-in types and imported modules.
- Flow-sensitive instance inference: member suggestions follow the latest assignment before the cursor.
- Primitive/container inference for common literals (`str`, `int`, `float`, `bool`, `None`, `list`, `dict`, `tuple`) and inferred variable-type inlay hints.
- Workspace auto-import completion for exported functions, classes and variables, including an import text edit.
- Inheritance-aware member lookup using C3 method-resolution order, including imported base classes.
- Function completion inserts call snippets with tab-stoppable required arguments.
- Import completion for `import ...` and `from ... import ...`.
- Signature help tracks the active argument and supports user functions, methods and built-ins.
- Hover shows signatures, inferred types and available docstrings.
- Inlay parameter-name hints at call sites.

### Navigation and refactoring

- Go to definition, including imported modules and inferred instance methods.
- Find references, document highlights, prepare rename and cross-file rename.
- Selection-based Extract Variable and Extract Function refactorings.
- Hierarchical document symbols and fuzzy workspace symbols.
- Selection ranges, folding ranges and document links.

### Diagnostics and editing

- Syntax and delimiter diagnostics, undefined names, unresolved imports/members, call argument checks, invalid control-flow placement and unused imports.
- Quick fixes and organize-import actions, including workspace-symbol auto-imports and missing/unmatched bracket repairs.
- Full and range semantic tokens.
- Incremental document synchronization and pull/push diagnostics.

## Project layout

- `src/lexer.ts` — tolerant tokenization used by editor features.
- `src/analyzer.ts` — source analysis and symbol extraction.
- `src/binder.ts`, `src/semantic.ts` — scopes, semantic analysis, type/member inference and diagnostics.
- `src/features.ts` — completion, hover, definition, references and signature help.
- `src/workspace.ts` — open documents and module resolution.
- `src/server.ts`, `src/rpc.ts` — LSP server and JSON-RPC transport.
- `tests/e2e.mjs` — end-to-end stdio protocol regression tests.

The server analyzes incomplete source while the user is typing; it does not require a successful THM program parse before providing editor assistance. Error recovery is token/binder based rather than a full error-correcting compiler parser. Type inference is intentionally conservative: it handles common assignments and class instances, but it is not yet a complete Python-compatible type checker, and branch joins, complex generics, overloads and dynamic metaprogramming may remain `Any`/unknown.


## THM LSP 0.4.0 — static type engine

This release adds `src/type-system.ts`, a tolerant AST/type-analysis layer:

- Type algebra: `Any`, `Never`, `None`, `Optional[T]`, `Union[A, B]`,
  `A | B`, `Literal[...]`, generic instances (`list[T]`, `dict[K, V]`),
  named type variables, and structural Protocol type descriptors.
- AST: logical statements and expression nodes are represented explicitly,
  while incomplete editor input remains recoverable.
- CFG: statement blocks, predecessor/successor edges, and bounded forward
  data-flow propagation with join points.
- Flow-sensitive analysis: assignment inference, annotation compatibility,
  branch joins, and `x is not None` narrowing.
- Diagnostics are published through normal `textDocument/publishDiagnostics`
  with codes `type-mismatch` and related type-engine identifiers.

The public type helpers (`parseAst`, `buildCfg`, `checkTypes`, `unionType`,
`optionalType`, and `typeToString`) can also be imported by future THM tooling.

### Type syntax examples

```thm
from typing import Any, Never, Optional, Union, Literal, Protocol, Generic

value: int | str = 42
maybe_name: Optional[str] = None
mode: Literal["read", "write"] = "read"
items: list[int] = [1, 2, 3]
mapping: dict[str, int] = {"answer": 42}
```

Note: this is the LSP's static-analysis model, not a runtime implementation of
`typing`. Protocol and Generic descriptors are represented in the type algebra;
full declaration-site generic constraint solving and complete Python-compatible
overload resolution remain future work.
