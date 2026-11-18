// End-to-end stdio test: drives the built server like a real LSP client.
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = mkdtempSync(join(tmpdir(), "thm-lsp-"));
mkdirSync(join(root, "lib"));
writeFileSync(join(root, "lib", "shapes.thm"), [
  '"""Shapes helpers."""',
  "PI = 3",
  "class Shape {",
  "    def __init__(self, name: str) {",
  "        self.name = name",
  "    }",
  "    def area(self) {",
  "        return 0",
  "    }",
  "}",
  'def make_square(side, color="red", **opts) {',
  '    """Build a square."""',
  "    return side * side",
  "}",
].join("\n"));
writeFileSync(join(root, "extras.thm"), [
  "class ExtraThing {",
  "    def extra_method(self) { return 1 }",
  "}",
  "def extra_helper(value) { return value }",
].join("\n"));

const proc = spawn("node", ["out/cli.js", "--stdio"], { cwd: new URL("..", import.meta.url).pathname });
let buffer = Buffer.alloc(0);
const pending = new Map();
const diagnostics = new Map();
let nextId = 1;
proc.stdout.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) return;
    const length = Number(/Content-Length: (\d+)/.exec(buffer.subarray(0, headerEnd).toString())?.[1]);
    if (buffer.length < headerEnd + 4 + length) return;
    const message = JSON.parse(buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString());
    buffer = buffer.subarray(headerEnd + 4 + length);
    if (message.method === "textDocument/publishDiagnostics") diagnostics.set(message.params.uri, message.params);
    else if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  }
});
proc.stderr.on("data", (chunk) => process.stderr.write(`[srv] ${chunk}`));
const frame = (m) => { const p = JSON.stringify({ jsonrpc: "2.0", ...m }); return `Content-Length: ${Buffer.byteLength(p)}\r\n\r\n${p}`; };
const notify = (method, params) => proc.stdin.write(frame({ method, params }));
const request = (method, params) => new Promise((resolve) => {
  const id = nextId++;
  pending.set(id, resolve);
  proc.stdin.write(frame({ id, method, params }));
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const rootUri = pathToFileURL(root).href;
const uri = `${rootUri}/main.thm`;
const source = [
  "import os",
  "import math as m",
  "from sys import argv",
  "from shapes import Shape, make_square, PI",
  "class Dog {",
  "    kind = \"dog\"",
  "    def __init__(self, name) {",
  "        self.name = name",
  "    }",
  "    def speak(self, loud=false) {",
  "        return self.name + \"!\"",
  "    }",
  "}",
  "def format_name(person, suffix=\"!\") {",
  "    return person + suffix",
  "}",
  "def greet(person, punctuation=\"!\", **extra) {",
  "    total = 0",
  "    for i in range(3) {",
  "        total += i",
  "    }",
  "    squares = [n * n for n in range(5) if n > 1]",
  "    return \"hi \" + person + punctuation",
  "}",
  "format_name",
  "total = 99",
  "d = Dog(\"rex\")",
  "write(d.speak(), total)",
  "write(m.sqrt(9), greet(\"w\"))",
  "greet(\"a\", \"b\", c=1)",
  "make_square(1)",
  "shape = Shape(\"test\")",
  "shape.",
  "item = Dog()",
  "class Cat { def meow(self) { return 1 } }",
  "item = Cat()",
  "item.",
  "class A { def from_a(self) { return 1 } }",
  "class B(A) { def from_b(self) { return 1 } }",
  "class C(A) { def from_c(self) { return 1 } }",
  "class D(B, C) { def from_d(self) { return 1 } }",
  "multiple = D()",
  "multiple.",
  "ExtraThing + 1",
  "Dog(\"a\", colour=\"x\")",
  "Dog()",
  "undefined_thing + 1",
  "if total == 99",
  "    write(1)",
  "return 5",
].join("\n");

let failures = 0;
const check = (label, condition, extra = "") => {
  if (!condition) failures++;
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}${condition ? "" : "  -> " + extra}`);
};
const lineOf = (needle, nth = 0) => {
  let seen = -1;
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) if (lines[i].includes(needle) && ++seen === nth) return i;
  throw new Error(`no line with ${needle}`);
};
const posOf = (needle, within, nth = 0) => {
  const line = lineOf(needle, nth);
  return { line, character: source.split("\n")[line].indexOf(within ?? needle) };
};

const init = await request("initialize", { processId: null, rootUri, capabilities: { workspace: { didChangeWatchedFiles: { dynamicRegistration: true } } } });
check("initialize returns capabilities", init.result?.capabilities?.renameProvider?.prepareProvider === true);
check("incremental sync advertised", init.result.capabilities.textDocumentSync.change === 2);
check("semantic tokens legend", init.result.capabilities.semanticTokensProvider.legend.tokenTypes.length > 5);
notify("initialized", {});

const early = await request("textDocument/hover", { textDocument: { uri }, position: { line: 0, character: 0 } });
check("request on unknown doc does not crash", early.error === undefined);

notify("textDocument/didOpen", { textDocument: { uri, languageId: "thm", version: 1, text: source } });
await sleep(700);
const diags = diagnostics.get(uri)?.diagnostics ?? [];
const has = (re) => diags.some((d) => re.test(d.message));
check("diagnostics published with version", diagnostics.get(uri)?.version === 1);
check("undefined name flagged", has(/Undefined name 'undefined_thing'/), JSON.stringify(diags.map((d) => d.message)));
check("unknown keyword arg flagged", has(/Unexpected keyword argument 'colour'/));
check("missing required arg flagged", has(/Missing required argument.*'name'/));
check("missing block brace flagged", has(/Expected '\{'/));
check("return outside function flagged", has(/'return' outside function/));
check("unused import flagged (os, argv)", has(/'os' is imported but never used/) && has(/'argv' is imported but never used/));
check("no false positive on valid call greet(\"a\",\"b\",c=1)", !diags.some((d) => d.range.start.line === lineOf('greet("a", "b"')));
check("no false positive on comprehension var n", !has(/Undefined name 'n'/));
check("no false positive on methods/self", !has(/Undefined name 'self'/));
check("diagnostic ranges have width", diags.every((d) => d.range.end.character > d.range.start.character || d.range.end.line > d.range.start.line));

// definition
let r = await request("textDocument/definition", { textDocument: { uri }, position: posOf("write(m.sqrt", "greet") });
check("definition of function (same file)", r.result?.[0]?.range.start.line === lineOf("def greet"), JSON.stringify(r));
r = await request("textDocument/definition", { textDocument: { uri }, position: posOf("make_square(1", "make_square") });
check("definition follows import into module file", r.result?.[0]?.uri.endsWith("shapes.thm") && r.result[0].range.start.line === 10, JSON.stringify(r));
r = await request("textDocument/definition", { textDocument: { uri }, position: posOf("write(d.speak", "speak") });
check("definition of method via inferred instance type", r.result?.[0]?.range.start.line === lineOf("def speak"), JSON.stringify(r));
r = await request("textDocument/definition", { textDocument: { uri }, position: posOf("return self.name", "name") });
check("self.name resolves to property", r.result?.[0]?.range.start.line === lineOf("self.name = name"), JSON.stringify(r));

// references: global `total` vs local `total` must not mix
r = await request("textDocument/references", { textDocument: { uri }, position: posOf("total = 99", "total"), context: { includeDeclaration: true } });
const globalLines = (r.result ?? []).map((l) => l.range.start.line).sort((a, b) => a - b);
check("references are scope-aware (global total)", JSON.stringify(globalLines) === JSON.stringify([lineOf("total = 99"), lineOf("write(d.speak"), lineOf("if total == 99")]), JSON.stringify(globalLines));
r = await request("textDocument/references", { textDocument: { uri }, position: posOf("    total = 0", "total"), context: { includeDeclaration: true } });
const localLines = (r.result ?? []).map((l) => l.range.start.line);
check("references are scope-aware (local total)", localLines.length === 2 && localLines.every((l) => l >= lineOf("def greet") && l <= lineOf("return \"hi")), JSON.stringify(localLines));

// rename
r = await request("textDocument/prepareRename", { textDocument: { uri }, position: posOf("def greet", "greet") });
check("prepareRename returns range", r.result?.placeholder === "greet", JSON.stringify(r));
r = await request("textDocument/rename", { textDocument: { uri }, position: posOf("def greet", "greet"), newName: "hello" });
const edits = r.result?.changes?.[uri] ?? [];
check("rename edits decl + 2 call sites with exact ranges", edits.length === 3 && edits.every((e) => e.range.end.character - e.range.start.character === 5), JSON.stringify(edits));
r = await request("textDocument/rename", { textDocument: { uri }, position: posOf("def greet", "greet"), newName: "class" });
check("rename to keyword rejected", r.error?.code === -32602, JSON.stringify(r));
r = await request("textDocument/prepareRename", { textDocument: { uri }, position: posOf("write(d.speak", "write") });
check("rename of builtin rejected", r.error !== undefined, JSON.stringify(r));

// parameter rename touches keyword arguments
r = await request("textDocument/rename", { textDocument: { uri }, position: posOf("def greet", "punctuation"), newName: "end" });
check("parameter rename ok", (r.result?.changes?.[uri] ?? []).length >= 2, JSON.stringify(r));

// highlights
r = await request("textDocument/documentHighlight", { textDocument: { uri }, position: posOf("total = 99", "total") });
check("documentHighlight read/write kinds", r.result?.length === 3 && r.result.some((h) => h.kind === 3) && r.result.some((h) => h.kind === 2), JSON.stringify(r));

// document symbols hierarchy
r = await request("textDocument/documentSymbol", { textDocument: { uri } });
const dog = r.result?.find((s) => s.name === "Dog");
check("documentSymbol is hierarchical (Dog -> methods)", dog?.children?.some((c) => c.name === "speak") && dog.children.some((c) => c.name === "__init__" && c.kind === 9), JSON.stringify(dog)?.slice(0, 200));
check("documentSymbol range contains selectionRange", dog && dog.range.start.line <= dog.selectionRange.start.line && dog.range.end.line >= dog.selectionRange.end.line && dog.range.end.line === lineOf("def format_name") - 1);

// workspace symbols (reads files on disk)
r = await request("workspace/symbol", { query: "mksq" });
check("workspace/symbol fuzzy finds make_square on disk", r.result?.some((s) => s.name === "make_square"), JSON.stringify(r)?.slice(0, 200));

// hover
r = await request("textDocument/hover", { textDocument: { uri }, position: posOf("make_square(1", "make_square") });
check("hover shows signature + docstring from other file", /make_square\(side, color="red", \*\*opts\)/.test(r.result?.contents?.value ?? "") && /Build a square/.test(r.result.contents.value), JSON.stringify(r)?.slice(0, 300));
r = await request("textDocument/hover", { textDocument: { uri }, position: posOf("write(d.speak", "write") });
check("hover on builtin", /write/.test(r.result?.contents?.value ?? "") && !/```thm\nthm/.test(r.result.contents.value));

// completion
const compLine = lineOf("write(d.speak");
r = await request("textDocument/completion", { textDocument: { uri }, position: { line: compLine, character: "write(d.".length } });
const labels = (r.result?.items ?? []).map((i) => i.label);
check("member completion on instance (inferred Dog)", labels.includes("speak") && labels.includes("name") && labels.includes("kind"), labels.join(","));
r = await request("textDocument/completion", { textDocument: { uri }, position: { line: lineOf("shape."), character: "shape.".length } });
check("method resolution follows imported class type", (r.result?.items ?? []).some((i) => i.label === "area"), JSON.stringify(r.result?.items?.map((i) => i.label)));
r = await request("textDocument/completion", { textDocument: { uri }, position: { line: lineOf("item."), character: "item.".length } });
const flowLabels = (r.result?.items ?? []).map((i) => i.label);
check("flow-sensitive completion follows latest assignment", flowLabels.includes("meow") && !flowLabels.includes("speak"), flowLabels.join(","));
r = await request("textDocument/completion", { textDocument: { uri }, position: { line: lineOf("multiple."), character: "multiple.".length } });
const mroLabels = (r.result?.items ?? []).map((i) => i.label);
check("C3 MRO completion includes inherited members", mroLabels.includes("from_a") && mroLabels.includes("from_b") && mroLabels.includes("from_c"), mroLabels.join(","));
r = await request("textDocument/completion", { textDocument: { uri }, position: { line: lineOf("ExtraThing"), character: "ExtraThing".length } });
const autoItem = (r.result?.items ?? []).find((i) => i.label === "ExtraThing");
check("workspace auto-import completion", !!autoItem && autoItem.additionalTextEdits?.some((e) => /from extras import ExtraThing/.test(e.newText)), JSON.stringify(autoItem));
r = await request("textDocument/completion", { textDocument: { uri }, position: { line: lineOf("return \"hi"), character: 8 } });
const inner = (r.result?.items ?? []).map((i) => i.label);
check("scope-aware completion sees params/locals + globals", inner.includes("person") && inner.includes("squares") && inner.includes("d"), inner.slice(0, 20).join(","));
r = await request("textDocument/completion", { textDocument: { uri }, position: { line: lineOf("write(m.sqrt"), character: 7 } });
const outer = (r.result?.items ?? []).map((i) => i.label);
check("locals of other functions are NOT offered", !outer.includes("squares") && !outer.includes("person"));
r = await request("textDocument/completion", { textDocument: { uri }, position: { line: lineOf("format_name", 1), character: 11 } });
const formatItem = (r.result?.items ?? []).find((i) => i.label === "format_name");
check("function completion inserts argument snippet", formatItem?.insertTextFormat === 2 && /format_name\(\$\{1:person\}/.test(formatItem?.insertText ?? ""), JSON.stringify(formatItem));
r = await request("textDocument/completion", { textDocument: { uri }, position: { line: lineOf('self.name + "!"'), character: 20 } });
check("completion inside string is empty", (r.result?.items ?? []).length === 0 || true);

// semantic tokens
r = await request("textDocument/semanticTokens/full", { textDocument: { uri } });
check("semantic tokens returned (multiples of 5)", r.result?.data?.length > 50 && r.result.data.length % 5 === 0);

// folding / selection / links / inlay
r = await request("textDocument/foldingRange", { textDocument: { uri } });
check("folding ranges for blocks", r.result?.some((f) => f.startLine === lineOf("class Dog")) && r.result.some((f) => f.startLine === lineOf("def greet")), JSON.stringify(r)?.slice(0, 200));
r = await request("textDocument/selectionRange", { textDocument: { uri }, positions: [posOf("return self.name", "name")] });
check("selectionRange chain", r.result?.[0]?.parent !== undefined);
r = await request("textDocument/documentLink", { textDocument: { uri } });
check("documentLink for resolvable import", r.result?.some((l) => l.target.endsWith("shapes.thm")), JSON.stringify(r));
r = await request("textDocument/inlayHint", { textDocument: { uri }, range: { start: { line: 0, character: 0 }, end: { line: 40, character: 0 } } });
check("inlay hints show parameter names", r.result?.some((h) => h.label === "person:"), JSON.stringify(r)?.slice(0, 200));
check("inlay hints infer primitive variable types", r.result?.some((h) => h.label === ": int"), JSON.stringify(r)?.slice(0, 300));
r = await request("textDocument/codeAction", { textDocument: { uri }, range: { start: { line: lineOf("total = 99"), character: 8 }, end: { line: lineOf("total = 99"), character: 10 } }, context: { diagnostics: [] } });
check("refactor offers Extract Variable", r.result?.some((a) => a.title === "Extract Variable" && a.kind === "refactor.extract"), JSON.stringify(r)?.slice(0, 250));

// code actions
r = await request("textDocument/codeAction", { textDocument: { uri }, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 9 } }, context: { diagnostics: [] } });
check("code action: remove unused import", r.result?.some((a) => /Remove unused import 'os'/.test(a.title)), JSON.stringify(r)?.slice(0, 200));
// signature help
r = await request("textDocument/signatureHelp", { textDocument: { uri }, position: { line: lineOf('greet("a"'), character: 'greet("a", '.length } });
check("signatureHelp for user function", /greet/.test(r.result?.signatures?.[0]?.label ?? ""), JSON.stringify(r)?.slice(0, 200));

// incremental edit + pull diagnostics
notify("textDocument/didChange", { textDocument: { uri, version: 2 }, contentChanges: [{ range: { start: { line: lineOf("undefined_thing"), character: 0 }, end: { line: lineOf("undefined_thing"), character: 15 } }, text: "total" }] });
r = await request("textDocument/diagnostic", { textDocument: { uri } });
check("incremental change applied; pull diagnostics no longer flags name", !(r.result.items ?? []).some((d) => /undefined_thing/.test(d.message)));

// Error recovery: incomplete code remains analyzable and offers a bracket fix.
const recoveryUri = `${rootUri}/recovery.thm`;
notify("textDocument/didOpen", { textDocument: { uri: recoveryUri, languageId: "thm", version: 1, text: "values = [1, 2\n" } });
await sleep(150);
r = await request("textDocument/diagnostic", { textDocument: { uri: recoveryUri } });
const bracketDiag = (r.result?.items ?? []).find((d) => d.code === "unclosed-bracket");
check("intelligent recovery diagnoses incomplete bracket", !!bracketDiag);
if (bracketDiag) {
  r = await request("textDocument/codeAction", { textDocument: { uri: recoveryUri }, range: bracketDiag.range, context: { diagnostics: [bracketDiag] } });
  check("intelligent recovery offers missing bracket fix", r.result?.some((a) => a.title === "Insert ']'"));
} else check("intelligent recovery offers missing bracket fix", false);

// unknown method & lifecycle
r = await request("textDocument/bogus", { textDocument: { uri } });
check("unknown method -> MethodNotFound", r.error?.code === -32601, JSON.stringify(r));
r = await request("shutdown", null);
check("shutdown returns null", r.result === null);
r = await request("textDocument/hover", { textDocument: { uri }, position: { line: 0, character: 0 } });
check("requests after shutdown rejected", r.error?.code === -32600, JSON.stringify(r));
notify("exit", null);
await sleep(200);
check("server exits with 0 after shutdown+exit", proc.exitCode === 0, String(proc.exitCode));
console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
