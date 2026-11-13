/** Line/character <-> offset conversion shared by feature providers. */

/** Convert an LSP line/character position (UTF-16 units) to a string offset. */
export function offsetToPosition(
  text: string,
  line: number,
  character: number,
): { offset: number; lineText: string } {
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
export function positionAtOffset(
  text: string,
  offset: number,
): { line: number; character: number } {
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
