/**
 * Minimal JSON-RPC 2.0 transport for an stdio LSP server.
 * Byte-accurate Content-Length framing per the LSP base protocol.
 */

/** Callbacks invoked for each parsed incoming message. */
export interface MessageSink {
  onMessage(message: Record<string, unknown>): void;
}

/** Hard upper bound on a single framed message (16 MiB, far above any LSP need). */
const MAX_MESSAGE_LENGTH = 16 * 1024 * 1024;

/** Hard upper bound on accumulated header bytes; guards against runaway headers. */
const MAX_HEADER_LENGTH = 16 * 1024;

export function sendMessage(output: NodeJS.WriteStream, message: Record<string, unknown>): void {
  const payload = JSON.stringify(message);
  output.write(`Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n${payload}`, "utf8");
}

/** Read framed JSON-RPC messages from stdin until EOF. */
export function serveStdio(sink: MessageSink): void {
  let buffer = Buffer.alloc(0);

  const tryExtract = (): void => {
    for (; ;) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        // Refuse unbounded header accumulation.
        if (buffer.length > MAX_HEADER_LENGTH) {
          console.error("[thm-lsp] dropping oversized malformed header block");
          buffer = Buffer.alloc(0);
        }
        return;
      }
      const header = buffer.slice(0, headerEnd).toString("utf8");
      const lengthText = /Content-Length:\s*(\d+)/i.exec(header)?.[1];
      if (lengthText === undefined || !/^[^\r\n:]+:\s*[^\r\n]*(\r\n[^\r\n:]+:\s*[^\r\n]*)*$/.test(header)) {
        console.error("[thm-lsp] malformed header block; discarding it");
        buffer = buffer.slice(headerEnd + 4);
        continue;
      }
      const contentLength = Number(lengthText);
      if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
        console.error("[thm-lsp] invalid Content-Length; discarding message");
        buffer = buffer.slice(headerEnd + 4);
        continue;
      }
      if (contentLength > MAX_MESSAGE_LENGTH) {
        console.error(`[thm-lsp] message exceeds ${MAX_MESSAGE_LENGTH} bytes; discarding it`);
        // Cannot safely resynchronize past a declared-but-unread oversized body,
        // so abort the stream rather than desynchronize.
        process.exit(1);
      }
      const bodyStart = headerEnd + 4;
      if (buffer.length < bodyStart + contentLength) return;
      const body = buffer.slice(bodyStart, bodyStart + contentLength).toString("utf8");
      buffer = buffer.slice(bodyStart + contentLength);
      let parsed: Record<string, unknown> | undefined;
      try {
        parsed = JSON.parse(body);
      } catch (error) {
        console.error(`[thm-lsp] bad message: ${String(error)}`);
        continue;
      }
      try {
        if (parsed !== undefined) sink.onMessage(parsed);
      } catch (error) {
        console.error(`[thm-lsp] handler error: ${error instanceof Error ? error.stack : String(error)}`);
      }
    }
  };

  process.stdin.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    tryExtract();
    // If a malformed stream left us with no complete header, cap accumulation.
    if (buffer.indexOf("\r\n\r\n") < 0 && buffer.length > MAX_HEADER_LENGTH) {
      console.error("[thm-lsp] input exceeded header limit without a framed message; exiting");
      process.exit(1);
    }
  });
  process.stdin.on("end", () => process.exit(0));
  process.stdin.on("close", () => process.exit(0));
  process.stdin.resume();
}
