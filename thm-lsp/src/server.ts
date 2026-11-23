/**
 * The THM language server: JSON-RPC dispatch over the LSP surface.
 *
 * Capabilities:
 *   lifecycle      initialize / initialized / shutdown / exit, multi-root workspaces,
 *                  incremental sync, file watching, config changes
 *   diagnostics    push (debounced, versioned) + pull; syntax, names, imports, calls
 *   navigation     definition, references, documentHighlight, documentSymbol (hierarchical),
 *                  workspace/symbol, documentLink, foldingRange, selectionRange
 *   editing        completion (scope/inference aware), signatureHelp, rename (+prepare),
 *                  codeAction (quick fixes, organize imports), inlayHint
 *   presentation   hover (markdown + docstrings), semanticTokens (full/range)
 */
import { COMPLETION_KIND, FeatureProvider } from "./features.js";
import { LineIndex } from "./positions.js";
import {
  LspError,
  SEMANTIC_TOKEN_MODIFIERS,
  SEMANTIC_TOKEN_TYPES,
  SemanticProvider,
  type Diagnostic,
} from "./semantic.js";
import { Workspace, pathToUri, uriToPath } from "./workspace.js";

interface ServerOptions {
  send: (message: Record<string, unknown>) => void;
  log: (line: string) => void;
}

interface Incoming {
  id?: number | string;
  method?: string;
  params?: any;
  result?: unknown;
  error?: unknown;
}

export const SERVER_VERSION = "0.4.0";

const ERR = {
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InternalError: -32603,
  ServerNotInitialized: -32002,
} as const;

class MethodNotFound extends Error {}

export class ThmLanguageServer {
  private readonly workspace = new Workspace();
  private readonly features: FeatureProvider;
  private readonly semantic: SemanticProvider;
  private readonly send: ServerOptions["send"];
  private readonly log: ServerOptions["log"];

  private initialized = false;
  private shuttingDown = false;
  private clientCaps: any = {};
  private nextRequestId = 1;
  private currentFolders: string[] = [];
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private globalTimer: NodeJS.Timeout | undefined;
  private readonly published = new Set<string>();

  constructor(options: ServerOptions) {
    this.send = options.send;
    this.log = options.log;
    this.features = new FeatureProvider(this.workspace);
    this.semantic = new SemanticProvider(this.workspace);
  }

  // ------------------------------------------------------------------ routing

  handleMessage(message: Incoming): void {
    const { id, method, params } = message;
    if (method === undefined) return; // response to one of our requests

    if (id === undefined) {
      try {
        this.handleNotification(method, params);
      } catch (error) {
        this.log(`error in notification ${method}: ${error instanceof Error ? error.stack : String(error)}`);
      }
      return;
    }

    if (!this.initialized && method !== "initialize") {
      return this.fail(id, ERR.ServerNotInitialized, "Server not initialized");
    }
    if (this.shuttingDown && method !== "shutdown") {
      return this.fail(id, ERR.InvalidRequest, "Server is shutting down");
    }
    try {
      const result = this.handleRequest(method, params);
      this.send({ jsonrpc: "2.0", id, result: result === undefined ? null : result });
    } catch (error) {
      if (error instanceof LspError) return this.fail(id, error.code, error.message);
      if (error instanceof MethodNotFound) return this.fail(id, ERR.MethodNotFound, error.message);
      this.log(`error handling ${method}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      this.fail(id, ERR.InternalError, String(error instanceof Error ? error.message : error));
    }
  }

  private fail(id: number | string, code: number, message: string): void {
    this.send({ jsonrpc: "2.0", id, error: { code, message } });
  }

  // ------------------------------------------------------------ notifications

  private handleNotification(method: string, params: any): void {
    switch (method) {
      case "initialized":
        this.registerWatchers();
        this.scheduleAll();
        return;
      case "exit":
        process.exit(this.shuttingDown ? 0 : 1);
        return;
      case "textDocument/didOpen": {
        const { uri, text, version } = params.textDocument;
        this.workspace.open(uri, text, version ?? 0);
        this.publishNow(uri);
        this.scheduleAll(uri);
        return;
      }
      case "textDocument/didChange": {
        const { uri, version } = params.textDocument;
        const current = this.workspace.get(uri);
        let text = current?.text ?? "";
        for (const change of params.contentChanges ?? []) {
          if (change.range !== undefined) {
            const index = new LineIndex(text);
            const start = index.offsetAt(change.range.start.line, change.range.start.character);
            const end = index.offsetAt(change.range.end.line, change.range.end.character);
            text = text.slice(0, start) + change.text + text.slice(end);
          } else {
            text = change.text;
          }
        }
        this.workspace.update(uri, text, version ?? (current?.version ?? 0) + 1);
        this.schedule(uri, 120);
        this.scheduleAll(uri);
        return;
      }
      case "textDocument/didSave": {
        const uri: string = params.textDocument.uri;
        if (typeof params.text === "string")
          this.workspace.update(uri, params.text, this.workspace.get(uri)?.version ?? 0);
        this.workspace.invalidateFiles();
        this.publishNow(uri);
        this.scheduleAll(uri);
        return;
      }
      case "textDocument/didClose": {
        const uri: string = params.textDocument.uri;
        this.workspace.close(uri);
        const timer = this.timers.get(uri);
        if (timer !== undefined) clearTimeout(timer);
        this.timers.delete(uri);
        this.clearDiagnostics(uri);
        return;
      }
      case "workspace/didChangeWatchedFiles":
        this.workspace.invalidateFiles();
        this.scheduleAll();
        return;
      case "workspace/didChangeWorkspaceFolders": {
        const removed = new Set((params?.event?.removed ?? []).map((f: { uri: string }) => f.uri));
        const added = (params?.event?.added ?? []).map((f: { uri: string }) => f.uri);
        this.currentFolders = [...this.currentFolders.filter((uri) => !removed.has(uri)), ...added];
        this.workspace.setRoots(this.currentFolders);
        this.scheduleAll();
        return;
      }
      case "workspace/didChangeConfiguration":
      case "$/setTrace":
      case "$/cancelRequest":
      case "$/progress":
        return;
      default:
        if (!method.startsWith("$/")) this.log(`unhandled notification ${method}`);
    }
  }

  private registerWatchers(): void {
    const dynamic = this.clientCaps?.workspace?.didChangeWatchedFiles?.dynamicRegistration === true;
    if (!dynamic) return;
    this.send({
      jsonrpc: "2.0",
      id: `reg-${this.nextRequestId++}`,
      method: "client/registerCapability",
      params: {
        registrations: [
          {
            id: "thm-watch",
            method: "workspace/didChangeWatchedFiles",
            registerOptions: { watchers: [{ globPattern: "**/*.thm" }] },
          },
        ],
      },
    });
  }

  // -------------------------------------------------------------- diagnostics

  private schedule(uri: string, delay: number): void {
    const existing = this.timers.get(uri);
    if (existing !== undefined) clearTimeout(existing);
    this.timers.set(
      uri,
      setTimeout(() => {
        this.timers.delete(uri);
        this.publishNow(uri);
      }, delay),
    );
  }

  /** Re-diagnose the other open documents (imports may have changed). */
  private scheduleAll(except?: string): void {
    if (this.globalTimer !== undefined) clearTimeout(this.globalTimer);
    this.globalTimer = setTimeout(() => {
      this.globalTimer = undefined;
      let count = 0;
      for (const uri of this.workspace.documents.keys()) {
        if (uri === except || count++ > 30) continue;
        this.publishNow(uri);
      }
    }, 400);
  }

  private publishNow(uri: string): void {
    const document = this.workspace.get(uri);
    if (document === undefined) return;
    let diagnostics: Diagnostic[] = [];
    try {
      diagnostics = this.semantic.diagnostics(uri);
    } catch (error) {
      this.log(`diagnostics failed for ${uri}: ${error instanceof Error ? error.stack : String(error)}`);
    }
    this.published.add(uri);
    this.send({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: { uri, version: document.version, diagnostics },
    });
  }

  private clearDiagnostics(uri: string): void {
    if (!this.published.delete(uri)) return;
    this.send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, diagnostics: [] } });
  }

  // ----------------------------------------------------------------- requests

  private handleRequest(method: string, params: any): unknown {
    const uri: string = params?.textDocument?.uri ?? "";
    const position = params?.position ?? { line: 0, character: 0 };

    switch (method) {
      case "initialize": {
        this.clientCaps = params?.capabilities ?? {};
        const folders: string[] = [];
        for (const folder of params?.workspaceFolders ?? [])
          if (typeof folder?.uri === "string") folders.push(folder.uri);
        if (folders.length === 0 && typeof params?.rootUri === "string") folders.push(params.rootUri);
        if (folders.length === 0 && typeof params?.rootPath === "string") folders.push(pathToUri(params.rootPath));
        this.currentFolders = folders;
        this.workspace.setRoots(folders);
        this.initialized = true;
        return {
          capabilities: {
            textDocumentSync: { openClose: true, change: 2, save: { includeText: false } },
            hoverProvider: true,
            definitionProvider: true,
            declarationProvider: true,
            typeDefinitionProvider: true,
            referencesProvider: true,
            documentHighlightProvider: true,
            documentSymbolProvider: true,
            workspaceSymbolProvider: true,
            renameProvider: { prepareProvider: true },
            foldingRangeProvider: true,
            selectionRangeProvider: true,
            documentLinkProvider: { resolveProvider: false },
            inlayHintProvider: { resolveProvider: false },
            completionProvider: { triggerCharacters: [".", "=", " "], resolveProvider: false },
            signatureHelpProvider: { triggerCharacters: ["(", ","], retriggerCharacters: [","] },
            codeActionProvider: { codeActionKinds: ["quickfix", "source.organizeImports", "refactor", "refactor.extract", "refactor.inline", "refactor.rewrite"] },
            semanticTokensProvider: {
              legend: {
                tokenTypes: [...SEMANTIC_TOKEN_TYPES],
                tokenModifiers: [...SEMANTIC_TOKEN_MODIFIERS],
              },
              full: true,
              range: true,
            },
            diagnosticProvider: {
              identifier: "thm",
              interFileDependencies: true,
              workspaceDiagnostics: false,
            },
            workspace: {
              workspaceFolders: { supported: true, changeNotifications: true },
            },
          },
          serverInfo: { name: "thm-lsp", version: SERVER_VERSION },
        };
      }
      case "shutdown":
        this.shuttingDown = true;
        for (const timer of this.timers.values()) clearTimeout(timer);
        this.timers.clear();
        if (this.globalTimer !== undefined) clearTimeout(this.globalTimer);
        return null;

      case "textDocument/completion":
        return this.completion(uri, position);
      case "completionItem/resolve":
        return params;
      case "textDocument/hover":
        return this.hover(uri, position);
      case "textDocument/definition":
      case "textDocument/declaration":
      case "textDocument/typeDefinition": {
        const locations = this.semantic.definition(uri, position);
        return locations.length === 0 ? null : locations;
      }
      case "textDocument/references":
        return this.semantic.references(uri, position, params?.context?.includeDeclaration ?? true);
      case "textDocument/documentHighlight":
        return this.semantic.documentHighlights(uri, position);
      case "textDocument/prepareRename":
        return this.semantic.prepareRename(uri, position);
      case "textDocument/rename":
        return this.semantic.rename(uri, position, params?.newName ?? "");
      case "textDocument/documentSymbol":
        return this.semantic.documentSymbols(uri);
      case "workspace/symbol":
        return this.semantic.workspaceSymbols(params?.query ?? "");
      case "textDocument/foldingRange":
        return this.semantic.foldingRanges(uri);
      case "textDocument/selectionRange":
        return this.semantic.selectionRanges(uri, params?.positions ?? []);
      case "textDocument/documentLink":
        return this.semantic.documentLinks(uri);
      case "textDocument/inlayHint":
        return this.semantic.inlayHints(uri, params.range);
      case "textDocument/semanticTokens/full":
        return this.semantic.semanticTokens(uri);
      case "textDocument/semanticTokens/range":
        return this.semantic.semanticTokens(uri, params.range);
      case "textDocument/codeAction":
        return this.semantic.codeActions(uri, params.range, params?.context?.diagnostics ?? []);
      case "textDocument/signatureHelp":
        return this.signatureHelp(uri, position);
      case "textDocument/diagnostic":
        return { kind: "full", items: this.semantic.diagnostics(uri) };
      case "workspace/diagnostic":
        return { items: [] };
      case "thm/kwargSuggestions":
        return this.features.kwargSuggestions(uri, position.line, position.character);
      default:
        throw new MethodNotFound(`Method not found: ${method}`);
    }
  }

  // ------------------------------------------------------------------- hover

  private hover(uri: string, position: { line: number; character: number }): unknown {
    const semantic = this.semantic.hover(uri, position);
    if (semantic !== null) return { contents: { kind: "markdown", value: semantic.contents }, range: semantic.range };
    const builtin = this.features.hover(uri, position.line, position.character);
    if (builtin === null) return null;
    const document = this.workspace.get(uri);
    const text = builtin.contents.replace(/^thm\n/, "");
    let range: unknown;
    if (document !== undefined) {
      const offset = document.lines.offsetAt(position.line, position.character);
      let start = offset;
      let end = offset;
      while (start > 0 && /\w/.test(document.text[start - 1])) start--;
      while (end < document.text.length && /\w/.test(document.text[end])) end++;
      range = document.lines.rangeOf(start, end - start);
    }
    return {
      contents: { kind: "markdown", value: "```thm\n" + text + "\n```" },
      ...(range !== undefined ? { range } : {}),
    };
  }

  // ------------------------------------------------------------ signature help

  private signatureHelp(uri: string, position: { line: number; character: number }): unknown {
    const help = this.features.signatureHelp(uri, position.line, position.character);
    if (help.signature === null) return null;
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

  // -------------------------------------------------------------- completion

  private completion(uri: string, position: { line: number; character: number }): unknown {
    const document = this.workspace.get(uri);
    if (document === undefined) return { isIncomplete: false, items: [] };
    const offset = document.lines.offsetAt(position.line, position.character);
    const empty = { isIncomplete: false, items: [] };

    // No completions inside comments or (non-f) strings.
    for (const comment of document.binding.comments) {
      if (offset > comment.offset && offset <= comment.offset + comment.length) return empty;
    }
    for (const token of document.binding.tokens) {
      if (token.kind !== "string") continue;
      if (/^[rRbB]*[fF]/.test(token.value)) continue;
      const quote = /^[A-Za-z]*("""|'''|"|')/.exec(token.value)?.[0].length ?? 1;
      if (offset >= token.offset + quote && offset < token.offset + token.length) return empty;
    }

    const before = document.text.slice(document.lines.lineStart(position.line), offset);
    const memberMatch = /([A-Za-z_]\w*)\s*\.\s*(\w*)$/.exec(before);
    const isImportLine = /^\s*(import|from)\b/.test(before);

    if (memberMatch !== null && !isImportLine) {
      const members = this.semantic.membersOf(uri, position, memberMatch[1]);
      if (members !== undefined) {
        const items: Array<Record<string, unknown>> = members
          .filter((member) => member.name !== "__init__")
          .map((member) => ({
            label: member.name,
            kind:
              member.kind === "method" || member.kind === "function"
                ? COMPLETION_KIND.Method
                : member.kind === "class"
                  ? COMPLETION_KIND.Class
                  : member.kind === "property"
                    ? COMPLETION_KIND.Property
                    : COMPLETION_KIND.Variable,
            detail: member.detail,
            documentation: member.doc !== undefined ? { kind: "markdown", value: member.doc } : undefined,
            sortText: `0_${member.name}`,
          }));
        return { isIncomplete: false, items };
      }
    }

    const items = this.features.completion(uri, position.line, position.character);
    if (memberMatch !== null || isImportLine) return { isIncomplete: false, items };

    // Replace the name-based local items with scope-aware ones.
    const completionByName = new Map(items.map((item) => [item.label, item]));
    const kept: Array<Record<string, unknown>> = items.filter((item) => !item.sortText?.startsWith("0_")) as never;
    for (const sym of this.semantic.visibleSymbols(uri, position)) {
      const richer = completionByName.get(sym.name);
      if (sym.kind === "exception") continue;
      kept.push({
        label: sym.name,
        kind:
          sym.kind === "function"
            ? COMPLETION_KIND.Function
            : sym.kind === "method"
              ? COMPLETION_KIND.Method
              : sym.kind === "class"
                ? COMPLETION_KIND.Class
                : sym.kind === "import"
                  ? COMPLETION_KIND.Module
                  : sym.kind === "property"
                    ? COMPLETION_KIND.Property
                    : COMPLETION_KIND.Variable,
        detail: sym.detail ?? sym.annotation ?? sym.kind,
        documentation: sym.doc,
        sortText: `0_${sym.name}`,
        insertText: richer?.insertText ?? sym.name,
        insertTextFormat: richer?.insertTextFormat ?? 1,
        filterText: richer?.filterText ?? sym.name,
        commitCharacters: richer?.commitCharacters,
      });
    }
    // Workspace-wide auto-import suggestions (functions/classes/variables).
    const word = /[A-Za-z_]\w*$/.exec(before)?.[0] ?? "";
    if (word.length >= 2 && !isImportLine) {
      const importPosition = this.semantic.autoImportPosition(uri);
      for (const candidate of this.semantic.autoImportCompletions(word, uri)) {
        if (completionByName.has(candidate.name)) continue;
        kept.push({
          label: candidate.name,
          kind: candidate.kind === "class" ? COMPLETION_KIND.Class : candidate.kind === "function" ? COMPLETION_KIND.Function : COMPLETION_KIND.Variable,
          detail: `${candidate.detail ?? candidate.kind} · auto import from ${candidate.module}`,
          sortText: `2_${candidate.name}`,
          filterText: candidate.name,
          additionalTextEdits: [{ range: { start: importPosition, end: importPosition }, newText: `from ${candidate.module} import ${candidate.name}\n` }],
        });
      }
    }
    return { isIncomplete: false, items: kept };
  }
}

export { pathToUri, uriToPath };
