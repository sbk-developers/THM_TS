/**
 * A small standalone THM lexer used by the LSP.
 *
 * It mirrors the real THM tokenizer's rules closely enough for editor work:
 * identifiers/keywords, numbers, all string prefix forms with escape handling,
 * operators, comments, line continuations, and span bookkeeping. Parse errors
 * are reported as tokens rather than throwing, so completion and hover keep
 * working inside half-typed code.
 */

export type TokenKind =
  | "identifier"
  | "keyword"
  | "number"
  | "string"
  | "operator"
  | "newline"
  | "indent"
  | "dedent"
  | "comment"
  | "eof"
  | "error";

export interface Token {
  kind: TokenKind;
  /** Raw source text of the token (for strings, includes quotes/prefix). */
  value: string;
  line: number;
  column: number;
  /** Character offset in the source string. */
  offset: number;
  length: number;
}

export const KEYWORDS: readonly string[] = [
  "and",
  "as",
  "assert",
  "break",
  "class",
  "continue",
  "def",
  "del",
  "elif",
  "else",
  "except",
  "finally",
  "for",
  "from",
  "global",
  "if",
  "import",
  "in",
  "is",
  "lambda",
  "nonlocal",
  "not",
  "or",
  "pass",
  "raise",
  "return",
  "try",
  "while",
];

const OPERATORS: readonly string[] = [
  "**=",
  "//=",
  "<<=",
  ">>=",
  "...",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "&=",
  "|=",
  "^=",
  "->",
  "==",
  "!=",
  "<=",
  ">=",
  "//",
  "**",
  "<<",
  ">>",
  "+",
  "-",
  "*",
  "/",
  "%",
  "=",
  "<",
  ">",
  "&",
  "|",
  "^",
  "~",
  "(",
  ")",
  "[",
  "]",
  "{",
  "}",
  ",",
  ":",
  ".",
  ";",
  "@",
];

const TWO_CHAR_QUOTE_PREFIXES = new Set(["rb", "br", "fr", "rf"]);
const ONE_CHAR_PREFIXES = new Set(["r", "b", "f"]);

/** True when the identifier is a reserved THM keyword. */
export function isKeyword(word: string): boolean {
  return KEYWORDS.includes(word);
}

/** Convert a 0-based line/column pair into a character offset. */
export function lineColumnToOffset(
  source: string,
  line: number,
  column: number,
): number {
  const lines = source.split(/\r\n|\n|\r/);
  let offset = 0;
  for (let index = 0; index < line && index < lines.length; index++) {
    offset += lines[index].length + 1;
  }
  return Math.min(offset + column, source.length);
}

/** Convert a character offset into a 0-based line/column pair. */
export function offsetToLineColumn(
  source: string,
  offset: number,
): { line: number; column: number } {
  const clamped = Math.max(0, Math.min(offset, source.length));
  let line = 0;
  let lineStart = 0;
  for (let index = 0; index < clamped; index++) {
    if (source.charCodeAt(index) === 10) {
      line++;
      lineStart = index + 1;
    }
  }
  return { line, column: clamped - lineStart };
}

interface LexState {
  source: string;
  pos: number;
  line: number;
  column: number;
  tokens: Token[];
  parenDepth: number;
  indentStack: number[];
}

function push(
  state: LexState,
  kind: TokenKind,
  startOffset: number,
  startLine: number,
  startColumn: number,
  endOffset?: number,
): void {
  const end = endOffset ?? state.pos;
  state.tokens.push({
    kind,
    value: state.source.slice(startOffset, end),
    line: startLine,
    column: startColumn,
    offset: startOffset,
    length: end - startOffset,
  });
}

function advance(state: LexState, count = 1): void {
  for (let index = 0; index < count; index++) {
    if (state.source[state.pos] === "\n") {
      state.line++;
      state.column = 0;
    } else {
      state.column++;
    }
    state.pos++;
  }
}

function tryIdentifierOrPrefixedString(state: LexState): boolean {
  const match = /^[A-Za-z_]\w*/.exec(state.source.slice(state.pos));
  if (match === null) return false;
  const word = match[0];
  // String prefixes: r"..." b"..." f"..." rb"..." br"..." fr"..." rf"..."
  const rest = state.source.slice(state.pos + word.length).slice(0, 3);
  const lower = word.toLowerCase();
  let prefixLength = 0;
  let quote = "";
  if (rest.startsWith('"""') || rest.startsWith("'''")) {
    if (ONE_CHAR_PREFIXES.has(lower)) prefixLength = 1;
    quote = rest.slice(0, 3);
  } else if (rest[0] === '"' || rest[0] === "'") {
    if (
      ONE_CHAR_PREFIXES.has(lower) ||
      TWO_CHAR_QUOTE_PREFIXES.has(lower.slice(0, 2))
    ) {
      prefixLength = lower.length;
    }
    quote = rest[0];
  }
  if (prefixLength > 0) {
    lexString(state, word.slice(0, prefixLength) + quote);
    return true;
  }
  const identStart = state.pos;
  const identLine = state.line;
  const identColumn = state.column;
  advance(state, word.length);
  if (KEYWORDS.includes(word))
    push(state, "keyword", identStart, identLine, identColumn, state.pos);
  else push(state, "identifier", identStart, identLine, identColumn, state.pos);
  return true;
}

/** Lex a string literal including the given prefix (e.g. `rb"`). */
function lexString(state: LexState, withPrefix: string): void {
  const startOffset = state.pos;
  const startLine = state.line;
  const startColumn = state.column;
  advance(state, withPrefix.length);
  const quote = state.source[state.pos] ?? '"';
  const triple =
    state.source.slice(state.pos, state.pos + 3) === quote.repeat(3);
  const closing = triple ? quote.repeat(3) : quote;
  advance(state, triple ? 3 : 1);
  while (state.pos < state.source.length) {
    const char = state.source[state.pos];
    if (char === "\\") {
      advance(state, 2);
      continue;
    }
    if (state.source.slice(state.pos, state.pos + closing.length) === closing) {
      advance(state, closing.length);
      push(state, "string", startOffset, startLine, startColumn);
      return;
    }
    if (char === "\n" && !triple) {
      // Unterminated single-line string; stop at newline.
      push(state, "error", startOffset, startLine, startColumn);
      return;
    }
    advance(state);
  }
  push(state, "error", startOffset, startLine, startColumn);
}

export function tokenize(source: string): Token[] {
  const state: LexState = {
    source,
    pos: 0,
    line: 0,
    column: 0,
    tokens: [],
    parenDepth: 0,
    indentStack: [0],
  };
  let atLineStart = true;
  while (state.pos < source.length) {
    const char = state.source[state.pos];
    if (char === " " || char === "\t" || char === "\r") {
      advance(state);
      continue;
    }
    if (char === "\n") {
      const wasOpen = state.parenDepth > 0;
      advance(state);
      if (!wasOpen)
        state.tokens.push({
          kind: "newline",
          value: "\n",
          line: state.line - 1,
          column: 0,
          offset: state.pos - 1,
          length: 1,
        });
      atLineStart = true;
      continue;
    }
    if (char === "#") {
      const start = state.pos;
      const startLine = state.line;
      const startColumn = state.column;
      while (state.pos < source.length && state.source[state.pos] !== "\n")
        advance(state);
      push(state, "comment", start, startLine, startColumn);
      continue;
    }
    if (char === "\\" && state.source[state.pos + 1] === "\n") {
      advance(state, 2);
      continue;
    }
    if (atLineStart) {
      atLineStart = false;
      // (Indent tracking is intentionally omitted; THM is brace-based.)
    }
    if (char === "(" || char === "[" || char === "{") state.parenDepth++;
    if (char === ")" || char === "]" || char === "}")
      state.parenDepth = Math.max(0, state.parenDepth - 1);
    if (char === '"' || char === "'") {
      lexString(state, "");
      continue;
    }
    if (tryIdentifierOrPrefixedString(state)) continue;
    const digitMatch =
      /^(0[xXbBoO][0-9a-fA-F_]+|\d[\d_]*(\.\d[\d_]*)?([eE][+-]?\d+)?)/.exec(
        state.source.slice(state.pos),
      );
    if (digitMatch !== null && /[0-9]/.test(char)) {
      const numStart = state.pos;
      const numLine = state.line;
      const numColumn = state.column;
      advance(state, digitMatch[0].length);
      push(state, "number", numStart, numLine, numColumn, state.pos);
      continue;
    }
    const operator = OPERATORS.find((candidate) =>
      state.source.startsWith(candidate, state.pos),
    );
    if (operator !== undefined) {
      const opStart = state.pos;
      const opLine = state.line;
      const opColumn = state.column;
      advance(state, operator.length);
      push(state, "operator", opStart, opLine, opColumn, state.pos);
      continue;
    }
    // Unknown character: emit an error token covering it.
    const errStart = state.pos;
    const errLine = state.line;
    const errColumn = state.column;
    advance(state);
    push(state, "error", errStart, errLine, errColumn, state.pos);
  }
  state.tokens.push({
    kind: "eof",
    value: "",
    line: state.line,
    column: state.column,
    offset: source.length,
    length: 0,
  });
  return state.tokens;
}
