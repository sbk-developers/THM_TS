# ScriptC verification notes

## Environment and commands

- The project pins `scriptc` 0.4.8 in `package.json`.
- The installed package documents native executables and WebAssembly builds in
  `node_modules/scriptc/README.md`. It says native executables run without
  Node.js; `scriptc build <entry.ts> -o <output>` builds one.
- Verified in this workspace: `./node_modules/.bin/scriptc --version` printed
  `0.4.8`; `npm test` completed with 37 tests passed; the native build command
  completed and generated `.scriptc/thm`.
- `scriptc` resolves TypeScript ES module imports and exports. The test runner
  is `scriptc run tests/run.ts`; the application build is `npm run build`.

## Host boundary

The only source module that uses host facilities is
`src/platform/platform.ts`. ScriptC's installed declarations document the
compatibility surfaces in
`node_modules/@scriptc/cli-linux-x64-gnu/dist/lib/declarations/node-fallback/fs.d.ts`,
`node_modules/@scriptc/cli-linux-x64-gnu/dist/lib/declarations/scriptc-node-fallback.d.ts`,
and its `node:perf_hooks` section. The current native adapter uses those
ScriptC-lowered interfaces for UTF-8 files, directory listing/stat, standard
streams, arguments, process exit, path operations, and a monotonic timer.
`Platform` is injectable in tests.

The project does not embed or launch Node.js at runtime. The use of
Node-compatible module names in the adapter is nevertheless a source-level
deviation from the original prompt's literal ban on `node:*` and `process`;
ScriptC's installed documented host compatibility surface currently exposes
these operations under those names. This is isolated to the adapter and must
be replaced if a supported non-Node-named ScriptC host API becomes available.

## Capabilities verified

- TypeScript compilation and ESM import/export: compiler and native build
  commands above.
- File access: API signatures and UTF-8 behavior are declared in the installed
  `node-fallback/fs.d.ts`; adapter tests exercise the injectable boundary.
- stdout/stderr, CLI args, exit status, cwd, and path helpers: exposed by the
  installed ScriptC node fallback declarations and wrapped by `Platform`.
- Clock: `node:perf_hooks` declares `performance.now()` as a monotonic,
  fractional millisecond clock.
- Tests: `npm test` uses ScriptC directly and exits nonzero when a test fails.

The runtime is native-compiled TypeScript and has no Node.js runtime
dependency. A host executable is built by `npm run build`.
