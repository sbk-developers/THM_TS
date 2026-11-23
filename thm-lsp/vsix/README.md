# THM Language Support (VS Code extension)

Syntax highlighting plus an integrated language server for the THM language.

- TextMate grammar (`source.thm`) using standard VS Code scope names, so any
  installed theme (Default Dark+, Default Light+, One Dark, Monokai, ...) colors
  THM code automatically — dark and light themes are both supported.
- Bundled language server (`server/thmlsp.cjs`) started over stdio by the
  client; no external Node.js or THM installation is required.

## Install

```sh
code --install-extension thm-language-0.4.0.vsix
```

## Features

Completion, hover, go-to-definition, references, rename, document/workspace
symbols, semantic tokens, inlay hints, quick fixes, diagnostics from the AST
type checker, CFG and data-flow analysis.
