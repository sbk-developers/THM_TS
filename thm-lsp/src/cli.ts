#!/usr/bin/env node
/**
 * thm-lsp command line entry point.
 *
 *   thm-lsp --stdio          run the language server over stdio (default)
 *   thm-lsp --version        print the version
 */
import { serveStdio, sendMessage } from "./rpc.js";
import type { JsonRpcMessage } from "./protocol.js";
import { SERVER_VERSION, ThmLanguageServer } from "./server.js";

const args = process.argv.slice(2);

if (args.includes("--version") || args.includes("-v")) {
  process.stdout.write(`thm-lsp ${SERVER_VERSION}\n`);
  process.exit(0);
}
if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write("Usage: thm-lsp [--stdio]\nTHM language server (LSP over stdio).\n");
  process.exit(0);
}

const server = new ThmLanguageServer({
  send: (message) => sendMessage(process.stdout, { jsonrpc: "2.0", ...message } as JsonRpcMessage),
  log: (line) => console.error(`[thm-lsp] ${line}`),
});

// A bug in one request must never take the whole server down.
process.on("uncaughtException", (error) => console.error(`[thm-lsp] uncaught: ${error.stack ?? error}`));
process.on("unhandledRejection", (reason) => console.error(`[thm-lsp] unhandled rejection: ${String(reason)}`));
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

serveStdio({ onMessage: (message) => server.handleMessage(message as never) });
