"use strict";
/**
 * Minimal JSON-RPC 2.0 transport for an stdio LSP server.
 * Byte-accurate Content-Length framing per the LSP base protocol.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendMessage = sendMessage;
exports.serveStdio = serveStdio;
function sendMessage(output, message) {
    const payload = JSON.stringify(message);
    output.write(`Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n${payload}`, "utf8");
}
/** Read framed JSON-RPC messages from stdin until EOF. */
function serveStdio(sink) {
    let buffer = Buffer.alloc(0);
    const tryExtract = () => {
        for (;;) {
            const headerEnd = buffer.indexOf("\r\n\r\n");
            if (headerEnd < 0)
                return;
            const header = buffer.slice(0, headerEnd).toString("utf8");
            const lengthText = /Content-Length:\s*(\d+)/i.exec(header)?.[1];
            if (lengthText === undefined) {
                buffer = buffer.slice(headerEnd + 4);
                continue;
            }
            const contentLength = Number(lengthText);
            const bodyStart = headerEnd + 4;
            if (buffer.length < bodyStart + contentLength)
                return;
            const body = buffer.slice(bodyStart, bodyStart + contentLength).toString("utf8");
            buffer = buffer.slice(bodyStart + contentLength);
            try {
                sink.onMessage(JSON.parse(body));
            }
            catch (error) {
                console.error(`[thm-lsp] bad message: ${String(error)}`);
            }
        }
    };
    process.stdin.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        tryExtract();
    });
    process.stdin.on("end", () => process.exit(0));
    process.stdin.resume();
}
