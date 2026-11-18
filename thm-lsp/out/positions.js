"use strict";
/** Line/character <-> offset conversion (LSP positions are UTF-16 code units). */
Object.defineProperty(exports, "__esModule", { value: true });
exports.LineIndex = void 0;
exports.offsetToPosition = offsetToPosition;
exports.positionAtOffset = positionAtOffset;
class LineIndex {
    text;
    starts = [0];
    constructor(text) {
        this.text = text;
        for (let i = 0; i < text.length; i++) {
            const code = text.charCodeAt(i);
            if (code === 10)
                this.starts.push(i + 1);
            else if (code === 13 && text.charCodeAt(i + 1) !== 10)
                this.starts.push(i + 1);
        }
    }
    get lineCount() {
        return this.starts.length;
    }
    lineStart(line) {
        return this.starts[Math.max(0, Math.min(line, this.starts.length - 1))];
    }
    lineEnd(line) {
        if (line >= this.starts.length - 1)
            return this.text.length;
        let end = this.starts[line + 1] - 1;
        if (end > 0 && this.text.charCodeAt(end - 1) === 13)
            end--;
        return end;
    }
    offsetAt(line, character) {
        if (line < 0)
            return 0;
        if (line >= this.starts.length)
            return this.text.length;
        return Math.min(this.lineStart(line) + Math.max(0, character), this.lineEnd(line));
    }
    positionAt(offset) {
        const clamped = Math.max(0, Math.min(offset, this.text.length));
        let lo = 0;
        let hi = this.starts.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (this.starts[mid] <= clamped)
                lo = mid;
            else
                hi = mid - 1;
        }
        return { line: lo, character: clamped - this.starts[lo] };
    }
    rangeOf(offset, length) {
        return { start: this.positionAt(offset), end: this.positionAt(offset + length) };
    }
}
exports.LineIndex = LineIndex;
/** Back-compat helper used by the original feature provider. */
function offsetToPosition(text, line, character) {
    const index = new LineIndex(text);
    const offset = index.offsetAt(line, character);
    return { offset, lineText: text.slice(index.lineStart(line), index.lineEnd(line)) };
}
function positionAtOffset(text, offset) {
    return new LineIndex(text).positionAt(offset);
}
