#!/usr/bin/env node
/**
 * thm-lsp command line entry point.
 *
 *   thm-lsp --stdio          run the language server over stdio (default)
 *   thm-lsp --version        print the version
 */
import { serveStdio, sendMessage } from "./rpc.js";
import type { JsonRpcMessage } from "./protocol.js";
import { ThmLanguageServer } from "./server.js";

const args = process.argv.slice(2);

if (args.includes("--version") || args.includes("-v")) {
  process.stdout.write("thm-lsp 0.1.0\n");
  process.exit(0);
}

const server = new ThmLanguageServer({
  send: (message) =>
    sendMessage(process.stdout, { jsonrpc: "2.0", ...message } as JsonRpcMessage),
  log: (line) => console.error(`[thm-lsp] ${line}`),
});

process.on("SIGINT", () => process.exit(0));
process.stdin.on("data", () => {}); // keep the pipe flowing immediately
serveStdio({ onMessage: (message) => server.handleMessage(message) });
void server;
