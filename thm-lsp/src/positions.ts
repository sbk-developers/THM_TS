/** Line/character <-> offset conversion (LSP positions are UTF-16 code units). */

export class LineIndex {
  private readonly starts: number[] = [0];

  constructor(readonly text: string) {
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code === 10) this.starts.push(i + 1);
      else if (code === 13 && text.charCodeAt(i + 1) !== 10) this.starts.push(i + 1);
    }
  }

  get lineCount(): number {
    return this.starts.length;
  }

  lineStart(line: number): number {
    return this.starts[Math.max(0, Math.min(line, this.starts.length - 1))];
  }

  lineEnd(line: number): number {
    if (line >= this.starts.length - 1) return this.text.length;
    let end = this.starts[line + 1] - 1;
    if (end > 0 && this.text.charCodeAt(end - 1) === 13) end--;
    return end;
  }

  offsetAt(line: number, character: number): number {
    if (line < 0) return 0;
    if (line >= this.starts.length) return this.text.length;
    return Math.min(this.lineStart(line) + Math.max(0, character), this.lineEnd(line));
  }

  positionAt(offset: number): { line: number; character: number } {
    const clamped = Math.max(0, Math.min(offset, this.text.length));
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid] <= clamped) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo, character: clamped - this.starts[lo] };
  }

  rangeOf(offset: number, length: number): LspRange {
    return { start: this.positionAt(offset), end: this.positionAt(offset + length) };
  }
}

export interface LspPosition {
  line: number;
  character: number;
}
export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

/** Back-compat helper used by the original feature provider. */
export function offsetToPosition(
  text: string,
  line: number,
  character: number,
): { offset: number; lineText: string } {
  const index = new LineIndex(text);
  const offset = index.offsetAt(line, character);
  return { offset, lineText: text.slice(index.lineStart(line), index.lineEnd(line)) };
}

export function positionAtOffset(text: string, offset: number): LspPosition {
  return new LineIndex(text).positionAt(offset);
}
