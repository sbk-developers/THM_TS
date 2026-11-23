/**
 * lexer/tokenizer.ts
 * ---------------------------------------------------------------------------
 * THM lexer (tokenizer).
 *
 * Scans source text character by character and produces a flat token stream
 * with line/column positions for every token. Handles:
 *   - operators/punctuation (longest match first)
 *   - numeric literals (decimal, hex 0x, binary 0b, octal 0o, floats, underscores)
 *   - string literals (single/double, triple-quoted, raw r"", f-strings, bytes b"")
 *   - comments (# to end of line) and explicit line continuations (backslash)
 *   - implicit line joining inside (), [] and {}
 *
 * Keywords are emitted as `identifier` tokens; the parser distinguishes them
 * by value so new keywords can be added without touching the lexer.
 */

import { SyntaxError } from "../errors/errors.js";

/** The kinds of token the lexer can produce. */
export type TokenKind =  "identifier" | "number" | "string" | "fstring" | "bytes" | "operator" | "newline" | "eof";

/** One token with its source location and length (for error reporting). */
export interface Token {
  kind: TokenKind;
  value: string;
  file: string;
  line: number;
  column: number;
  length: number;
}

/** Operator and punctuation strings, ordered longest-match-first so `**=`
 *  wins over `*`, `**` and `=`. */
const operators = [
  "**=", "//=", "<<=", ">>=", ":=",
  "==", "!=", "<=", ">=", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=",
  "**", "//", "<<", ">>", "->",
  "(", ")", "[", "]", "{", "}", ".", ",", ":", ";", "@",
  "+", "-", "*", "/", "%", "=", "<", ">", "!", "&", "|", "^", "~",
];

// Operators that allow a newline to continue the current statement.
const continuingOperators = new Set([
  ",", ":", ".", ":=", "=", "+", "-", "*", "/", "//", "%", "**", "<<", ">>",
  "==", "!=", "<", "<=", ">", ">=", "+=", "-=", "*=", "/=", "//=", "%=", "**=",
  "&", "|", "^", "&=", "|=", "^=", "<<=", ">>=", "->",
  "and", "or", "not", "is", "in",
]);

/** The lexer: converts source text into a token stream. */
export class Lexer {
  private offset = 0;
  private line = 1;
  private column = 1;
  private parenDepth = 0;
  private bracketDepth = 0;
  private readonly tokens: Token[] = [];

  constructor(
    private readonly source: string,
    private readonly file = "<stdin>",
  ) {
    // Skip UTF-8 BOM if present.
    if (source.startsWith("\uFEFF")) this.offset = 1;
  }

  /** Scan the entire source and return the complete token array. */
  tokenize(): Token[] {
    while (!this.atEnd()) {
      const char = this.peek();
      if (char === " " || char === "\t" || char === "\f") {
        this.advance();
      } else if (char === "\r" || char === "\n") {
        this.readNewline();
      } else if (char === "#") {
        this.skipComment();
      } else if (char === "\\") {
        this.readExplicitContinuation();
      } else if (this.stringPrefixLength() > 0) {
        this.readString(this.stringPrefixLength());
      } else if (this.isQuote(char)) {
        this.readString(0);
      } else if (this.isDigit(char) || (char === "." && this.isDigit(this.peek(1)))) {
        this.readNumber();
      } else if (this.isIdentifierStart(char)) {
        this.readIdentifier();
      } else {
        this.readOperatorOrPunctuation();
      }
    }

    this.tokens.push({
      kind: "eof",
      value: "",
      file: this.file,
      line: this.line,
      column: this.column,
      length: 0,
    });
    return this.tokens;
  }

  /** Handle a newline; emit a token unless inside brackets or after a
   *  continuing operator (implicit line joining). */
  private readNewline(): void {
    const start = this.position();
    const startOffset = this.offset;
    this.advanceNewline();
    const previous = this.tokens[this.tokens.length - 1];
    if (
      this.parenDepth > 0 ||
      this.bracketDepth > 0 ||
      (previous !== undefined && continuingOperators.has(previous.value))
    ) {
      return;
    }
    this.pushToken("newline", "\n", start, startOffset);
  }

  /** Handle an explicit line continuation (a backslash right before a newline). */
  private readExplicitContinuation(): void {
    const start = this.position();
    this.advance();
    if (this.peek() !== "\r" && this.peek() !== "\n") {
      throw new SyntaxError("A backslash is only valid before a newline", start);
    }
    this.advanceNewline();
    while (this.peek() === " " || this.peek() === "\t") this.advance();
  }

  /** Skip a `#` comment up to (not including) the newline. */
  private skipComment(): void {
    while (!this.atEnd() && this.peek() !== "\r" && this.peek() !== "\n") this.advance();
  }

  /** Read an identifier; keywords stay tagged "identifier" for the parser. */
  private readIdentifier(): void {
    const start = this.position();
    const startOffset = this.offset;
    let value = "";
    while (this.isIdentifierPart(this.peek())) value += this.advance();
    this.pushToken("identifier", value, start, startOffset);
  }

  /** Read a numeric literal: 0x/0b/0o integers, decimals, floats, exponents. */
  private readNumber(): void {
    const start = this.position();
    const startOffset = this.offset;
    let value = "";

    if (this.peek() === "0" && ["x", "X", "b", "B", "o", "O"].includes(this.peek(1))) {
      value += this.advance();
      const prefix = this.advance();
      value += prefix;
      const radix = prefix === "x" || prefix === "X" ? 16 : prefix === "b" || prefix === "B" ? 2 : 8;
      value += this.readDigitSequence((char) => {
        const digit = this.digitValue(char);
        return digit >= 0 && digit < radix;
      }, start);
      if (this.isIdentifierStart(this.peek())) {
        throw new SyntaxError("Invalid digit in base-prefixed integer", this.position());
      }
      this.pushToken("number", value, start, startOffset);
      return;
    }

    if (this.peek() === ".") {
      value += this.advance();
      value += this.readDigitSequence((char) => this.isDigit(char), start);
    } else {
      value += this.readDigitSequence((char) => this.isDigit(char), start);
      if (this.peek() === ".") {
        value += this.advance();
        if (this.isDigit(this.peek())) value += this.readDigitSequence((char) => this.isDigit(char), start);
      }
    }

    if (this.peek() === "e" || this.peek() === "E") {
      value += this.advance();
      if (this.peek() === "+" || this.peek() === "-") value += this.advance();
      if (!this.isDigit(this.peek())) throw new SyntaxError("Malformed numeric exponent", this.position());
      value += this.readDigitSequence((char) => this.isDigit(char), start);
    }
    if (this.isIdentifierStart(this.peek())) {
      throw new SyntaxError("Invalid character after numeric literal", this.position());
    }
    this.pushToken("number", value, start, startOffset);
  }

  /** Read digits of a literal, allowing single `_` separators between digits. */
  private readDigitSequence(valid: (char: string) => boolean, start: { line: number; column: number }): string {
    let value = "";
    let sawDigit = false;
    let previousUnderscore = false;
    while (valid(this.peek()) || this.peek() === "_") {
      const char = this.advance();
      if (char === "_") {
        if (!sawDigit || previousUnderscore) throw new SyntaxError("Misplaced underscore in numeric literal", start);
        previousUnderscore = true;
      } else {
        sawDigit = true;
        previousUnderscore = false;
      }
      value += char;
    }
    if (!sawDigit || previousUnderscore) throw new SyntaxError("Malformed numeric literal", start);
    return value;
  }

  /** Read a string literal. Supports prefixes (f/r/b and combos), triple
   *  quotes, escape sequences, and `{expr}` interpolation inside f-strings. */
  private readString(prefixLength: number): void {
    const start = this.position();
    const startOffset = this.offset;
    let prefix = "";
    for (let index = 0; index < prefixLength; index++) prefix += this.advance().toLowerCase();
    const formatted = prefix.includes("f");
    const raw = prefix.includes("r");
    const isBytes = prefix.includes("b");
    const quote = this.advance();
    const triple = this.peek() === quote && this.peek(1) === quote;
    if (triple) {
      this.advance();
      this.advance();
    }
    let value = "";
    let interpolationDepth = 0;
    let expressionQuote = "";
    let expressionEscape = false;

    while (!this.atEnd()) {
      if (interpolationDepth === 0 && this.atStringDelimiter(quote, triple)) {
        this.advance();
        if (triple) {
          this.advance();
          this.advance();
        }
        if (isBytes) {
          this.pushToken("bytes", value, start, startOffset);
        } else {
          this.pushToken(formatted ? "fstring" : "string", value, start, startOffset);
        }
        return;
      }

      const char = this.peek();
      if (interpolationDepth > 0) {
        if (expressionQuote !== "") {
          value += this.advanceStringCharacter();
          if (expressionEscape) expressionEscape = false;
          else if (char === "\\") expressionEscape = true;
          else if (char === expressionQuote) expressionQuote = "";
          continue;
        }
        if (char === "'" || char === '"') {
          expressionQuote = char;
          value += this.advance();
          continue;
        }
        if (char === "{") interpolationDepth++;
        else if (char === "}") interpolationDepth--;
        if (char === "\r" || char === "\n") {
          if (!triple) throw new SyntaxError("Newline in a single-line f-string", this.position());
          value += this.consumeStringNewline();
        } else {
          value += this.advance();
        }
        continue;
      }

      if (char === "\r" || char === "\n") {
        if (!triple) throw new SyntaxError("Newline in a single-line string literal", this.position());
        value += this.consumeStringNewline();
        continue;
      }
      if (char === "\\" && !raw) {
        value += this.readEscape();
        continue;
      }
      if (char === "\\" && raw && this.peek(1) === quote) {
        value += this.advance() + this.advance();
        continue;
      }
      if (formatted && char === "{" && this.peek(1) === "{") {
        value += this.advance() + this.advance();
        continue;
      }
      if (formatted && char === "}" && this.peek(1) === "}") {
        value += this.advance() + this.advance();
        continue;
      }
      if (formatted && char === "{") interpolationDepth = 1;
      else if (formatted && char === "}") throw new SyntaxError("Unmatched '}' in f-string", this.position());
      value += this.advance();
    }
    throw new SyntaxError("Unterminated string literal", start);
  }

  /** Read one escape sequence after a backslash (\n, \xHH, \uHHHH, ...). */
  private readEscape(): string {
    const start = this.position();
    this.advance();
    const char = this.advance();
    switch (char) {
      case "n": return "\n";
      case "r": return "\r";
      case "t": return "\t";
      case "0": return "\0";
      case "\\": return "\\";
      case "'": return "'";
      case '"': return '"';
      case "x": return this.readHexEscape(2, start);
      case "u": return this.readHexEscape(4, start);
      default:
        throw new SyntaxError(`Unsupported string escape \\${char}`, start);
    }
  }

  /** Read a hex escape of `digits` hex characters (\xHH = 2, \uHHHH = 4). */
  private readHexEscape(digits: number, start: { line: number; column: number }): string {
    let value = 0;
    for (let index = 0; index < digits; index++) {
      const digit = this.digitValue(this.peek());
      if (digit < 0 || digit >= 16) throw new SyntaxError("Malformed hexadecimal string escape", start);
      value = value * 16 + digit;
      this.advance();
    }
    return String.fromCharCode(value);
  }

  /** Match an operator/punctuation token; also tracks bracket depth so that
   *  newlines inside () and [] do not terminate the statement. `;` is
   *  normalized to a newline token (statement separator). */
  private readOperatorOrPunctuation(): void {
    const start = this.position();
    const startOffset = this.offset;
    for (const candidate of operators) {
      if (!this.source.startsWith(candidate, this.offset)) continue;
      for (let index = 0; index < candidate.length; index++) this.advance();
      if (candidate === "(") this.parenDepth++;
      if (candidate === ")") this.parenDepth--;
      if (candidate === "[") this.bracketDepth++;
      if (candidate === "]") this.bracketDepth--;
      if (this.parenDepth < 0 || this.bracketDepth < 0) {
        throw new SyntaxError(`Unexpected closing delimiter ${candidate}`, start);
      }
      this.pushToken(candidate === ";" ? "newline" : "operator", candidate === ";" ? "\n" : candidate, start, startOffset);
      return;
    }
    throw new SyntaxError(`Unexpected character ${JSON.stringify(this.peek())}`, start);
  }

  /** Consume a newline inside a multi-line string and return "\n". */
  private consumeStringNewline(): string {
    this.advanceNewline();
    return "\n";
  }

  /** Advance over one character inside an f-string interpolation block. */
  private advanceStringCharacter(): string {
    if (this.peek() === "\r" || this.peek() === "\n") return this.consumeStringNewline();
    return this.advance();
  }

  /** True when the current position starts the string's closing quote. */
  private atStringDelimiter(quote: string, triple: boolean): boolean {
    if (this.peek() !== quote) return false;
    return !triple || (this.peek(1) === quote && this.peek(2) === quote);
  }

  /** Detect a string prefix (f, r, b or two-letter combos like fr) at the
   *  current position; returns its length (0, 1 or 2). */
  private stringPrefixLength(): number {
    const first = this.peek().toLowerCase();
    if (first === "f" || first === "r" || first === "b") {
      if (this.isQuote(this.peek(1))) return 1;
      const second = this.peek(1).toLowerCase();
      if ((second === "f" || second === "r" || second === "b") && second !== first && this.isQuote(this.peek(2))) return 2;
    }
    return 0;
  }

  /** Advance past a newline sequence (CRLF or LF), updating line/column. */
  private advanceNewline(): void {
    if (this.peek() === "\r") {
      this.offset++;
      if (this.peek() === "\n") this.offset++;
    } else {
      this.offset++;
    }
    this.line++;
    this.column = 1;
  }

  /** Advance one character and return it. */
  private advance(): string {
    const char = this.source[this.offset] ?? "";
    this.offset++;
    this.column++;
    return char;
  }

  /** Record a token spanning from `start` to the current position. */
  private pushToken(
    kind: TokenKind,
    value: string,
    start: { line: number; column: number },
    startOffset: number,
  ): void {
    this.tokens.push({
      kind,
      value,
      file: this.file,
      line: start.line,
      column: start.column,
      length: this.offset - startOffset,
    });
  }

  /** Current line/column, used as the start of the next token. */
  private position(): { line: number; column: number } {
    return { line: this.line, column: this.column };
  }

  /** Look at a character `distance` positions ahead ("" if past the end). */
  private peek(distance = 0): string {
    return this.source[this.offset + distance] ?? "";
  }

  /** Character classification helpers used by the scanner. */
  private atEnd(): boolean {
    return this.offset >= this.source.length;
  }

  /** True for `'` or `"`. */
  private isQuote(char: string): boolean {
    return char === "'" || char === '"';
  }

  /** True for ASCII decimal digits. */
  private isDigit(char: string): boolean {
    return char >= "0" && char <= "9";
  }

  /** Numeric value of a hex digit, or -1 if not a hex digit. */
  private digitValue(char: string): number {
    if (this.isDigit(char)) return char.charCodeAt(0) - 48;
    if (char >= "a" && char <= "f") return char.charCodeAt(0) - 87;
    if (char >= "A" && char <= "F") return char.charCodeAt(0) - 55;
    return -1;
  }

  /** True if `char` may start an identifier (letter or underscore). */
  private isIdentifierStart(char: string): boolean {
    return (char >= "a" && char <= "z") || (char >= "A" && char <= "Z") || char === "_";
  }

  /** True if `char` may continue an identifier (identifier-start or digit). */
  private isIdentifierPart(char: string): boolean {
    return this.isIdentifierStart(char) || this.isDigit(char);
  }
}

// Tokenize a source string in one call.
export function tokenize(source: string, file = "<stdin>"): Token[] {
  return new Lexer(source, file).tokenize();
}
