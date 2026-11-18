/**
 * Minimal JSON-RPC 2.0 transport for an stdio LSP server.
 * Byte-accurate Content-Length framing per the LSP base protocol.
 */

/** Callbacks invoked for each parsed incoming message. */
export interface MessageSink {
  onMessage(message: Record<string, unknown>): void;
}

export function sendMessage(output: NodeJS.WriteStream, message: Record<string, unknown>): void {
  const payload = JSON.stringify(message);
  output.write(`Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n${payload}`, "utf8");
}

/** Read framed JSON-RPC messages from stdin until EOF. */
export function serveStdio(sink: MessageSink): void {
  let buffer = Buffer.alloc(0);

  const tryExtract = (): void => {
    for (;;) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = buffer.slice(0, headerEnd).toString("utf8");
      const lengthText = /Content-Length:\s*(\d+)/i.exec(header)?.[1];
      if (lengthText === undefined) {
        buffer = buffer.slice(headerEnd + 4);
        continue;
      }
      const contentLength = Number(lengthText);
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
  });
  process.stdin.on("end", () => process.exit(0));
  process.stdin.on("close", () => process.exit(0));
  process.stdin.resume();
}
