/**
 * The THM language server: JSON-RPC method dispatch over the LSP surface.
 *
 * Supported capabilities:
 *   - textDocument/completion        (keywords, globals, types, modules, members, kwargs)
 *   - textDocument/hover
 *   - textDocument/definition        (go to definition, incl. into imported module files)
 *   - textDocument/references
 *   - textDocument/rename
 *   - textDocument/documentSymbol
 *   - workspace/symbol
 *   - textDocument/signatureHelp     (built-in + user signatures, **kwargs aware)
 *   - textDocument/diagnostic        (pull diagnostics)
 *   - didOpen/didChange/didClose/didSave lifecycle
 */
import { FeatureProvider } from "./features.js";
import { offsetToPosition } from "./positions.js";
import { Workspace, pathToUri, uriToPath } from "./workspace.js";

interface ServerOptions {
  send: (message: Record<string, unknown>) => void;
  log: (line: string) => void;
}

export class ThmLanguageServer {
  private readonly workspace = new Workspace();
  private readonly features: FeatureProvider;
  private readonly send: ServerOptions["send"];
  private readonly log: ServerOptions["log"];

  constructor(options: ServerOptions) {
    this.send = options.send;
    this.log = options.log;
    this.features = new FeatureProvider(this.workspace);
  }

  handleMessage(message: {
    id?: number | string;
    method?: string;
    params?: any;
  }): void {
    const { id, method, params } = message;
    if (method === undefined) return; // response to a server->client request

    if (id === undefined) {
      try {
        this.handleNotification(method, params);
      } catch (error) {
        this.log(`error in notification ${method}: ${error instanceof Error ? error.stack : String(error)}`);
      }
      return;
    }
    try {
      const result = this.handleRequest(method, params);
      this.send({ jsonrpc: "2.0", id, result });
    } catch (error) {
      this.log(`error handling ${method}: ${String(error)}`);
      this.send({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32603,
          message: String(error instanceof Error ? error.message : error),
        },
      });
    }
  }

  private handleNotification(method: string, params: any): void {
    switch (method) {
      case "initialize": {
        const rootUri: string | undefined = params?.rootUri;
        if (rootUri !== undefined) this.workspace.setRoot(rootUri);
        else if (params?.workspaceFolders?.[0]?.uri !== undefined)
          this.workspace.setRoot(params.workspaceFolders[0].uri);
        break;
      }
      case "initialized":
        break;
      case "textDocument/didOpen": {
        const { uri, text, version } = params.textDocument;
        this.workspace.open(uri, text, version ?? 0);
        this.publishDiagnostics(uri, text);
        break;
      }
      case "textDocument/didChange": {
        const { uri, version } = params.textDocument;
        let text: string | undefined;
        for (const change of params.contentChanges) {
          // Incremental change (range) support: apply the patch.
          if (change.range !== undefined) {
            text = this.applyIncremental(
              text ?? this.workspace.get(uri)?.text ?? "",
              change,
            );
          } else {
            text = change.text;
          }
        }
        if (text !== undefined) {
          this.workspace.update(uri, text, version ?? 0);
          this.publishDiagnostics(uri, text);
        }
        break;
      }
      case "textDocument/didClose":
        this.workspace.close(params.textDocument.uri);
        break;
      case "textDocument/didSave": {
        const text: string | undefined = params.text;
        const uri: string = params.textDocument.uri;
        if (text !== undefined) this.workspace.update(uri, text, 0);
        break;
      }
      case "$/cancelRequest":
        break;
      case "exit":
        process.exit(0);
        break;
      default:
        this.log(`unhandled notification ${method}`);
    }
  }

  private applyIncremental(
    text: string,
    change: {
      range: {
        start: { line: number; character: number };
        end: { line: number; character: number };
      };
      text: string;
    },
  ): string {
    const start = offsetToPosition(text, change.range.start.line, change.range.start.character).offset;
    const end = offsetToPosition(text, change.range.end.line, change.range.end.character).offset;
    return text.slice(0, start) + change.text + text.slice(end);
  }

  private publishDiagnostics(uri: string, text: string): void {
    const diagnostics = this.features.diagnose(uri).map((diagnostic) => ({
      range: {
        start: { line: diagnostic.line, character: diagnostic.character },
        end: { line: diagnostic.line, character: diagnostic.character + 1 },
      },
      severity: diagnostic.severity,
      message: diagnostic.message,
      source: "thm-lsp",
    }));
    this.send({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: { uri, diagnostics },
    });
    void text;
  }

  private handleRequest(method: string, params: any): unknown {
    const uri: string = params?.textDocument?.uri ?? "";
    const position = params?.position ?? { line: 0, character: 0 };
    switch (method) {
      case "initialize":
        return {
          capabilities: {
            textDocumentSync: { openClose: true, change: 1 }, // incremental
            hoverProvider: true,
            definitionProvider: true,
            referencesProvider: true,
            documentSymbolProvider: true,
            workspaceSymbolProvider: true,
            renameProvider: true,
            completionProvider: {
              triggerCharacters: [".", "="],
              resolveProvider: false,
            },
            signatureHelpProvider: { triggerCharacters: ["(", ","] },
            diagnosticProvider: {
              interFileDependencies: false,
              workspaceDiagnostics: false,
            },
          },
          serverInfo: { name: "thm-lsp", version: "0.1.0" },
        };
      case "shutdown":
        return null;
      case "textDocument/completion": {
        const items = this.features.completion(
          uri,
          position.line,
          position.character,
        );
        return { isIncomplete: false, items };
      }
      case "textDocument/hover": {
        const hover = this.features.hover(
          uri,
          position.line,
          position.character,
        );
        if (hover === null) return null;
        return {
          contents: {
            kind: "markdown",
            value: "```thm\n" + hover.contents + "\n```",
          },
        };
      }
      case "textDocument/definition": {
        const locations = this.features.definition(
          uri,
          position.line,
          position.character,
        );
        if (locations.length === 0) return null;
        return locations.map((location) => ({
          uri: location.uri,
          range: {
            start: { line: location.line, character: location.character },
            end: { line: location.line, character: location.character + 1 },
          },
        }));
      }
      case "textDocument/references": {
        const locations = this.features.references(
          uri,
          position.line,
          position.character,
          params?.context?.includeDeclaration ?? true,
        );
        return locations.map((location) => ({
          uri: location.uri,
          range: {
            start: { line: location.line, character: location.character },
            end: { line: location.line, character: location.character + 1 },
          },
        }));
      }
      case "textDocument/rename": {
        const result = this.features.rename(
          uri,
          position.line,
          position.character,
          params?.newName ?? "",
        );
        if (result === null) return null;
        return {
          changes: Object.fromEntries(
            Object.entries(result.changes).map(([editUri, edits]) => [
              editUri,
              edits.map((edit) => ({
                range: {
                  start: { line: edit.line, character: edit.character },
                  end: { line: edit.line, character: edit.character + 1 },
                },
                newText: params.newName,
              })),
            ]),
          ),
        };
      }
      case "textDocument/documentSymbol": {
        const symbols = this.features.documentSymbols(uri);
        return symbols.map((symbol) => ({
          name: symbol.name,
          kind: symbol.kind,
          detail: symbol.detail,
          range: {
            start: {
              line: symbol.range.line,
              character: symbol.range.character,
            },
            end: {
              line: symbol.range.line,
              character: symbol.range.character + 1,
            },
          },
          selectionRange: {
            start: {
              line: symbol.range.line,
              character: symbol.range.character,
            },
            end: {
              line: symbol.range.line,
              character: symbol.range.character + 1,
            },
          },
        }));
      }
      case "workspace/symbol": {
        const symbols = this.features.workspaceSymbols(params?.query ?? "");
        return symbols.map((symbol) => ({
          name: symbol.name,
          kind: symbol.kind,
          location: {
            uri: symbol.uri,
            range: {
              start: { line: symbol.line, character: symbol.character },
              end: { line: symbol.line, character: symbol.character + 1 },
            },
          },
        }));
      }
      case "textDocument/signatureHelp": {
        const help = this.features.signatureHelp(
          uri,
          position.line,
          position.character,
        );
        if (help.signature === null)
          return { signatures: [], activeSignature: 0, activeParameter: 0 };
        return {
          signatures: [
            {
              label: help.signature.label,
              parameters: help.signature.parameters,
              documentation: help.signature.documentation,
            },
          ],
          activeSignature: 0,
          activeParameter: help.activeParameter,
        };
      }
      case "textDocument/diagnostic": {
        const diagnostics = this.features.diagnose(uri).map((diagnostic) => ({
          range: {
            start: { line: diagnostic.line, character: diagnostic.character },
            end: { line: diagnostic.line, character: diagnostic.character + 1 },
          },
          severity: diagnostic.severity,
          message: diagnostic.message,
          source: "thm-lsp",
        }));
        return { kind: "full", items: diagnostics };
      }
      // Custom LSP extensions for extra THM feature access.
      case "thm/kwargSuggestions":
        return this.features.kwargSuggestions(
          uri,
          position.line,
          position.character,
        );
      default:
        this.log(`unhandled request ${method}`);
        throw new Error(`Unhandled request: ${method}`);
    }
  }
}

/** Internal helper: convert an LSP position into an offset in `text`. */
function lineColIndex(
  position: { line: number; character: number },
  text: string,
): string {
  void text;
  return `${position.line}:${position.character}`;
}

// Re-export for CLI wiring.
export { pathToUri, uriToPath };
