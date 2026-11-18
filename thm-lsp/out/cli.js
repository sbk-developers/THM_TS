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
    process.stdout.write(`thm-lsp ${server_js_1.SERVER_VERSION}\n`);
    process.exit(0);
}
if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write("Usage: thm-lsp [--stdio]\nTHM language server (LSP over stdio).\n");
    process.exit(0);
}
const server = new server_js_1.ThmLanguageServer({
    send: (message) => (0, rpc_js_1.sendMessage)(process.stdout, { jsonrpc: "2.0", ...message }),
    log: (line) => console.error(`[thm-lsp] ${line}`),
});
// A bug in one request must never take the whole server down.
process.on("uncaughtException", (error) => console.error(`[thm-lsp] uncaught: ${error.stack ?? error}`));
process.on("unhandledRejection", (reason) => console.error(`[thm-lsp] unhandled rejection: ${String(reason)}`));
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
(0, rpc_js_1.serveStdio)({ onMessage: (message) => server.handleMessage(message) });
