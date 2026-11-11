import type { Token } from "../lexer/tokenizer.js";

export const tracebackSymbol = Symbol("thm.traceback");

export interface TracebackFrame {
  filename: string;
  line: number;
  column: number;
  name: string;
  sourceLine?: string;
}

export class Traceback {
  readonly frames: TracebackFrame[];
  constructor(frames: TracebackFrame[]) {
    this.frames = frames;
  }
}

export function attachTraceback(error: unknown, traceback: Traceback): void {
  if (error !== null && typeof error === "object") {
    (error as Record<typeof tracebackSymbol, unknown>)[tracebackSymbol] = traceback;
  }
}

export function readTraceback(error: unknown): Traceback | undefined {
  if (error !== null && typeof error === "object") {
    return (error as Record<typeof tracebackSymbol, unknown>)[tracebackSymbol] as Traceback | undefined;
  }
  return undefined;
}

export class CompileError extends Error {
  constructor(message: string, public readonly line?: number, public readonly column?: number) {
    super(line === undefined ? message : `${message} at ${line}:${column ?? 1}`);
    this.name = "CompileError";
  }
}

export class SyntaxError extends CompileError {
  constructor(message: string, token?: Pick<Token, "line" | "column">) {
    super(message, token?.line, token?.column);
    this.name = "SyntaxError";
  }
}

export class RuntimeError extends Error {
  constructor(message: string, public readonly line?: number, public readonly column?: number) {
    super(line === undefined ? message : `${message} at ${line}:${column ?? 1}`);
    this.name = "RuntimeError";
  }
}

export class ThmNameError extends RuntimeError {
  constructor(message: string) {
    super(message);
    this.name = "NameError";
  }
}

export class ThmImportError extends RuntimeError {
  constructor(message: string) {
    super(message);
    this.name = "ImportError";
  }
}

export class ThmTypeError extends RuntimeError {
  constructor(message: string) {
    super(message);
    this.name = "TypeError";
  }
}

export class ThmValueError extends RuntimeError {
  constructor(message: string) {
    super(message);
    this.name = "ValueError";
  }
}

export class ThmRecursionError extends RuntimeError {
  constructor(message: string) {
    super(message);
    this.name = "RecursionError";
  }
}

export class ThmKeyError extends RuntimeError {
  constructor(message: string) {
    super(message);
    this.name = "KeyError";
  }
}

export class ThmIndexError extends RuntimeError {
  constructor(message: string) {
    super(message);
    this.name = "IndexError";
  }
}

export class ThmZeroDivisionError extends RuntimeError {
  constructor(message: string) {
    super(message);
    this.name = "ZeroDivisionError";
  }
}

export class ThmAssertionError extends RuntimeError {
  constructor(message = "") {
    super(message);
    this.name = "AssertionError";
  }
}

/** Raised for missing attributes; extends ThmNameError so existing callers keep working. */
export class ThmAttributeError extends ThmNameError {
  constructor(message: string) {
    super(message);
    this.name = "AttributeError";
  }
}

export class ThmStopIteration extends RuntimeError {
  constructor(message = "") {
    super(message);
    this.name = "StopIteration";
  }
}

export class ThmEOFError extends RuntimeError {
  constructor(message = "EOF when reading a line") {
    super(message);
    this.name = "EOFError";
  }
}

export class ThmOSError extends RuntimeError {
  constructor(message: string) {
    super(message);
    this.name = "OSError";
  }
}

export class NotFoundError extends RuntimeError{
  constructor(message:string){
    super(message)
    this.name = "NotFoundError"
  }
}
