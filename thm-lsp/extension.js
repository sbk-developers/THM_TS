"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const path = require("path");
const vscode_1 = require("vscode");
const node_1 = require("vscode-languageclient/node");
let client;
function activate(context) {
    const serverModule = context.asAbsolutePath(path.join("out", "cli.js"));
    const serverOptions = {
        run: { module: serverModule, transport: node_1.TransportKind.stdio },
        debug: { module: serverModule, transport: node_1.TransportKind.stdio },
    };
    const outputChannel = vscode_1.window.createOutputChannel("THM Language Server");
    const clientOptions = {
        documentSelector: [{ language: "thm", scheme: "file" }, { language: "thm", scheme: "untitled" }],
        outputChannel,
        synchronize: {
            configurationSection: "thm-lsp",
        },
    };
    client = new node_1.LanguageClient("thm-lsp", "THM Language Server", serverOptions, clientOptions);
    context.subscriptions.push(outputChannel);
    client.start().catch((err) => outputChannel.appendLine(`Failed to start: ${String(err)}`));
}
function deactivate() {
    if (client) {
        return client.stop();
    }
    return undefined;
}
// workspace is referenced to keep document selector lazily valid; not used directly.
void vscode_1.workspace;
