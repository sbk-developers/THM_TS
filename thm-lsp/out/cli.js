#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * thm-lsp command line entry point.
 *
 *   thm-lsp --stdio          run the language server over stdio (default)
 *   thm-lsp --version        print the version
 */
const rpc_js_1 = require("./rpc.js");
const server_js_1 = require("./server.js");
const args = process.argv.slice(2);
if (args.includes("--version") || args.includes("-v")) {
    process.stdout.write("thm-lsp 0.1.0\n");
    process.exit(0);
}
const server = new server_js_1.ThmLanguageServer({
    send: (message) => (0, rpc_js_1.sendMessage)(process.stdout, { jsonrpc: "2.0", ...message }),
    log: (line) => console.error(`[thm-lsp] ${line}`),
});
process.on("SIGINT", () => process.exit(0));
process.stdin.on("data", () => { }); // keep the pipe flowing immediately
(0, rpc_js_1.serveStdio)({ onMessage: (message) => server.handleMessage(message) });
void server;
