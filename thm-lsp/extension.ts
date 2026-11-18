import * as path from "path";
import {
  workspace,
  ExtensionContext,
  window,
  OutputChannel,
} from "vscode";
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
} from "vscode-languageclient/node";

let client: LanguageClient | undefined;

export function activate(context: ExtensionContext): void {
  const serverModule = context.asAbsolutePath(path.join("server", "out", "cli.js"));

  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.stdio },
    debug: { module: serverModule, transport: TransportKind.stdio },
  };

  const outputChannel: OutputChannel = window.createOutputChannel("THM Language Server");
  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ language: "thm", scheme: "file" }, { language: "thm", scheme: "untitled" }],
    outputChannel,
    synchronize: {
      configurationSection: "thm-lsp",
    },
  };

  client = new LanguageClient(
    "thm-lsp",
    "THM Language Server",
    serverOptions,
    clientOptions
  );

  context.subscriptions.push(outputChannel);
  client.start().catch((err) => outputChannel.appendLine(`Failed to start: ${String(err)}`));
}

export function deactivate(): Thenable<void> | undefined {
  if (client) {
    return client.stop();
  }
  return undefined;
}

// workspace is referenced to keep document selector lazily valid; not used directly.
void workspace;
