"use strict";
/** Line/character <-> offset conversion shared by feature providers. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.offsetToPosition = offsetToPosition;
exports.positionAtOffset = positionAtOffset;
/** Convert an LSP line/character position (UTF-16 units) to a string offset. */
function offsetToPosition(text, line, character) {
    const lines = text.split("\n");
    let offset = 0;
    for (let index = 0; index < Math.min(line, lines.length); index++) {
        offset += lines[index].length + 1;
    }
    return {
        offset: Math.min(offset + Math.max(0, character), text.length),
        lineText: lines[line] ?? "",
    };
}
/** Convert a string offset to an LSP line/character position. */
function positionAtOffset(text, offset) {
    const clamped = Math.max(0, Math.min(offset, text.length));
    let line = 0;
    let lineStart = 0;
    for (let index = 0; index < clamped; index++) {
        if (text.charCodeAt(index) === 10) {
            line++;
            lineStart = index + 1;
        }
    }
    return { line, character: clamped - lineStart };
}
