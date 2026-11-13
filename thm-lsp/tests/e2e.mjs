// End-to-end stdio test: drives the built server like an LSP client would.
import { spawn } from "node:child_process";

const proc = spawn("node", ["out/cli.js", "--stdio"], { cwd: new URL("..", import.meta.url).pathname });
let buffer = Buffer.alloc(0);
const pending = new Map();
let nextId = 1;

proc.stdout.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (; ;) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) return;
    const length = Number(/Content-Length: (\d+)/.exec(buffer.slice(0, headerEnd).toString())?.[1]);
    if (!Number.isFinite(length) || buffer.length < headerEnd + 4 + length) return;
    const body = buffer.slice(headerEnd + 4, headerEnd + 4 + length).toString();
    buffer = buffer.slice(headerEnd + 4 + length);
    const message = JSON.parse(body);
    if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)(message.result ?? message.error);
      pending.delete(message.id);
    }
  }
});
proc.stderr.on("data", (chunk) => process.stderr.write(`[srv] ${chunk}`));

const notify = (method, params) => {
  const payload = JSON.stringify({ jsonrpc: "2.0", method, params });
  proc.stdin.write(`Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`);
};
const request = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    proc.stdin.write(`Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`);
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const rootUri = "file:///home/sbk/thm";
const uri = `${rootUri}/examples/lsp-demo.thm`;
const source = [
  "import os",
  'import math as m',
  "from sys import argv, exit",
  "class Dog {",
  "    def speak(self) { return \"woof\" }",
  "}",
  "def greet(person, punctuation=\"!\", **extra) {",
  "    return \"hi \" + person + punctuation",
  "}",
  "d = Dog()",
  "write(d.speak())",
  "write(m.sqrt(9))",
  'greet("world")',
  'assert ValueError("haha")',
].join("\n");

let failures = 0;
const check = (label, condition, extra = "") => {
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}${extra ? "  → " + extra : ""}`);
  if (!condition) failures++;
};

notify("initialize", { rootUri });
await sleep(100);
notify("initialized", {});
notify("textDocument/didOpen", { textDocument: { uri, languageId: "thm", version: 1, text: source } });
await sleep(200);

const completions = await request("textDocument/completion", { textDocument: { uri }, position: { line: 10, character: 0 } });
check("completion count > 60", completions.items.length > 60, `${completions.items.length} items`);
check("completion has write/len/isinstance", ["write", "len", "isinstance"].every((n) => completions.items.some((i) => i.label === n)));

const mathMembers = await request("textDocument/completion", { textDocument: { uri }, position: { line: 11, character: 9 } });
check("member completion after 'm.' includes sqrt/pi", ["sqrt", "pi"].every((n) => mathMembers.items.some((i) => i.label === n)), mathMembers.items.map((i) => i.label).join(","));

const importMembers = await request("textDocument/completion", { textDocument: { uri }, position: { line: 2, character: 18 } });
check("from-import member completion includes argv/exit", ["argv", "exit"].every((n) => importMembers.items.some((i) => i.label === n)), importMembers.items.map((i) => i.label).join(","));

const moduleItems = await request("textDocument/completion", { textDocument: { uri }, position: { line: 0, character: 7 } });
check("module completion includes builtins + workspace .thm", moduleItems.items.some((i) => i.label === "math") && moduleItems.items.some((i) => i.label === "test_sort"), moduleItems.items.map((i) => i.label).slice(0, 12).join(","));

const kwargs = await request("textDocument/completion", { textDocument: { uri }, position: { line: 10, character: 6 } });
check("completion includes local defs (greet, Dog)", ["greet", "Dog", "d"].every((n) => kwargs.items.some((i) => i.label === n)));

const hover = await request("textDocument/hover", { textDocument: { uri }, position: { line: 10, character: 2 } });
check("hover over write documents it", hover !== null && String(hover.contents?.value ?? "").includes("write"), hover?.contents?.value?.slice(0, 80));

const sig = await request("textDocument/signatureHelp", { textDocument: { uri }, position: { line: 11, character: 10 } });
check("signatureHelp for sqrt", sig.signatures?.[0]?.label === "sqrt(x)", sig.signatures?.[0]?.label);

const gotoDog = await request("textDocument/definition", { textDocument: { uri }, position: { line: 9, character: 5 } });
check("go-to-definition on Dog finds class", gotoDog !== null && gotoDog.length > 0 && gotoDog[0].range.start.line === 3, JSON.stringify(gotoDog));

// greet is defined at line 6, character 4 (the 'g' in 'greet')
const gotoGreet = await request("textDocument/definition", { textDocument: { uri }, position: { line: 6, character: 4 } });
check("go-to-definition on greet finds def", gotoGreet !== null && Array.isArray(gotoGreet) && gotoGreet.length > 0 && gotoGreet[0].range.start.line === 6, JSON.stringify(gotoGreet));

// speak is defined at line 4, character 8 (the 's' in 'speak')
const refs = await request("textDocument/references", { textDocument: { uri }, position: { line: 4, character: 8 }, context: { includeDeclaration: true } });
check("references to speak finds decl + usage", refs.length >= 2, JSON.stringify(refs));

const symbols = await request("textDocument/documentSymbol", { textDocument: { uri } });
check("document symbols include Dog/greet/d", ["Dog", "greet", "d", "speak"].every((n) => symbols.some((s) => s.name === n)), symbols.map((s) => s.name).join(","));

const diag = await request("textDocument/diagnostic", { textDocument: { uri } });
check("diagnostic warns on assert ValueError(...)", diag.items.some((d) => d.message.includes("use 'raise'")), JSON.stringify(diag.items.map((d) => d.message)));

// greet is defined at line 6, character 4
const rename = await request("textDocument/rename", { textDocument: { uri }, position: { line: 6, character: 4 }, newName: "who" });
check("rename greet proposes edits", rename !== null && (rename.changes?.[uri]?.length ?? 0) >= 2, JSON.stringify(Object.keys(rename?.changes ?? {})));

// greet is called at line 11: greet("world") - signature help at 'greet(' character 5
const kwargSig = await request("textDocument/signatureHelp", { textDocument: { uri }, position: { line: 11, character: 5 } });
check("signatureHelp shows **extra kwarg", kwargSig.signatures?.[0]?.label.includes("**extra"), kwargSig.signatures?.[0]?.label);

// kwarg suggestions at greet( character 5
const kwargSuggest = await request("thm/kwargSuggestions", { textDocument: { uri }, position: { line: 11, character: 5 } });
check("kwargSuggestions returns person=/punctuation=", Array.isArray(kwargSuggest) && kwargSuggest.includes("person=") && kwargSuggest.includes("punctuation="), JSON.stringify(kwargSuggest));

// Cross-file go-to-definition: open a module, import it from the demo file.
const libUri = `${rootUri}/lib/helpers.thm`;
notify("textDocument/didOpen", { textDocument: { uri: libUri, languageId: "thm", version: 1, text: "def format_greeting(name) {\n    return \"hello \" + name\n}\n" } });
await sleep(100);
const modUri = `${rootUri}/examples/uses-helper.thm`;
notify("textDocument/didOpen", { textDocument: { uri: modUri, languageId: "thm", version: 1, text: "from helpers import format_greeting\nwrite(format_greeting(\"sbk\"))\n" } });
await sleep(150);
const crossGoto = await request("textDocument/definition", { textDocument: { uri: modUri }, position: { line: 1, character: 8 } });
check("cross-file goto into lib/helpers.thm", crossGoto !== null && String(crossGoto[0]?.uri ?? "").endsWith("helpers.thm"), JSON.stringify(crossGoto));
const modMembers = await request("textDocument/completion", { textDocument: { uri: modUri }, position: { line: 0, character: 22 } });
check("from helpers import completes its functions", modMembers.items.some((i) => i.label === "format_greeting"), modMembers.items.map((i) => i.label).join(","));

console.log(failures === 0 ? "\nE2E: ALL TESTS PASSED" : `\nE2E: ${failures} FAILURES`);
proc.kill();
process.exit(failures === 0 ? 0 : 1);