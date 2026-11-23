/**
 * errors/errors.ts
 * ---------------------------------------------------------------------------
 * Error class definitions for the THM language.
 *
 * Hierarchy:
 *   Error
 *    ├── CompileError        - failures during lexing/parsing/code generation
 *    │    └── SyntaxError    - malformed source text (carries token location)
 *    └── RuntimeError        - failures while the VM executes bytecode
 *         ├── ThmNameError, ThmTypeError, ThmValueError, ...
 *         └── ThmAttributeError (extends ThmNameError)
 *
 * Every runtime error mirrors a Python built-in exception so THM programs
 * can catch them with familiar names (TypeError, ValueError, ...).
 */

import type { Token } from "../lexer/tokenizer.js";

/** Symbol key under which a Traceback is stored on an error object. */
export const tracebackSymbol = Symbol("thm.traceback");

/** One traceback frame: where in the source a call was made. */
export interface TracebackFrame {
  filename: string;
  line: number;
  column: number;
  name: string;
  sourceLine?: string;
}

/** Traceback: an ordered list of frames (most recent call last). */
export class Traceback {
  readonly frames: TracebackFrame[];
  constructor(frames: TracebackFrame[]) {
    this.frames = frames;
  }
}

/** Store a traceback on an error object so it survives being rethrown. */
export function attachTraceback(error: unknown, traceback: Traceback): void {
  if (error !== null && typeof error === "object") {
    (error as Record<typeof tracebackSymbol, unknown>)[tracebackSymbol] = traceback;
  }
}

/** Retrieve a traceback previously attached with attachTraceback(). */
export function readTraceback(error: unknown): Traceback | undefined {
  if (error !== null && typeof error === "object") {
    return (error as Record<typeof tracebackSymbol, unknown>)[tracebackSymbol] as Traceback | undefined;
  }
  return undefined;
}

// -------- Compile-time errors --------

/** Base class for all failures detected before execution starts. */
export class CompileError extends Error {
  constructor(message: string, public readonly line?: number, public readonly column?: number) {
    super(line === undefined ? message : `${message} at ${line}:${column ?? 1}`);
    this.name = "CompileError";
  }
}

/** Raised by the lexer/parser when source text cannot be tokenized or parsed. */
export class SyntaxError extends CompileError {
  constructor(message: string, token?: Pick<Token, "line" | "column">) {
    super(message, token?.line, token?.column);
    this.name = "SyntaxError";
  }
}

// -------- Runtime errors --------

/** Base class for failures raised while the VM executes bytecode. */
export class RuntimeError extends Error {
  constructor(message: string, public readonly line?: number, public readonly column?: number) {
    super(line === undefined ? message : `${message} at ${line}:${column ?? 1}`);
    this.name = "RuntimeError";
  }
}

// THM runtime error types, named after Python's built-in exceptions.

/** Raised when a name is not found in any scope. */
export class ThmNameError extends RuntimeError {
  constructor(message: string) {
    super(message);
    this.name = "NameError";
  }
}

/** Raised when a module cannot be found or loaded. */
export class ThmImportError extends RuntimeError {
  constructor(message: string) {
    super(message);
    this.name = "ImportError";
  }
}

/** Raised when an argument or operand has the wrong type. */
export class ThmTypeError extends RuntimeError {
  constructor(message: string) {
    super(message);
    this.name = "TypeError";
  }
}

/** Raised when a value has the right type but is invalid. */
export class ThmValueError extends RuntimeError {
  constructor(message: string) {
    super(message);
    this.name = "ValueError";
  }
}

/** Raised when the recursion depth limit is exceeded. */
export class ThmRecursionError extends RuntimeError {
  constructor(message: string) {
    super(message);
    this.name = "RecursionError";
  }
}

/** Raised when a dict key is missing. */
export class ThmKeyError extends RuntimeError {
  constructor(message: string) {
    super(message);
    this.name = "KeyError";
  }
}

/** Raised when a sequence index is out of range. */
export class ThmIndexError extends RuntimeError {
  constructor(message: string) {
    super(message);
    this.name = "IndexError";
  }
}

/** Raised on division or modulo by zero. */
export class ThmZeroDivisionError extends RuntimeError {
  constructor(message: string) {
    super(message);
    this.name = "ZeroDivisionError";
  }
}

/** Raised when an `assert` statement fails. */
export class ThmAssertionError extends RuntimeError {
  constructor(message = "") {
    super(message);
    this.name = "AssertionError";
  }
}

/** Raised on a missing attribute; extends ThmNameError for compatibility. */
export class ThmAttributeError extends ThmNameError {
  constructor(message: string) {
    super(message);
    this.name = "AttributeError";
  }
}

/** Raised by exhausted iterators. */
export class ThmStopIteration extends RuntimeError {
  constructor(message = "") {
    super(message);
    this.name = "StopIteration";
  }
}

/** Raised when input() hits end-of-input. */
export class ThmEOFError extends RuntimeError {
  constructor(message = "EOF when reading a line") {
    super(message);
    this.name = "EOFError";
  }
}

/** Raised when an operating-system level operation fails. */
export class ThmOSError extends RuntimeError {
  constructor(message: string) {
    super(message);
    this.name = "OSError";
  }
}

/** Raised when a file or resource does not exist. */
export class NotFoundError extends RuntimeError {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}
