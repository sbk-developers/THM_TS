import type { Chunk, Instruction } from "../compiler/bytecode/bytecode.js";
import { compile } from "../compiler.js";
import { parse } from "../parser/parser.js";
import os from "node:os";
import {
  ThmImportError,
  RuntimeError,
  ThmAttributeError,
  ThmEOFError,
  ThmIndexError,
  ThmOSError,
  ThmStopIteration,
  ThmKeyError,
  ThmNameError,
  ThmRecursionError,
  ThmTypeError,
  ThmValueError,
  ThmZeroDivisionError,
  attachTraceback,
  readTraceback,
  Traceback,
  type TracebackFrame,
} from "../errors/errors.js";
import { ManagedHeap, ManagedObject } from "./memory.js";
import { ModuleResolver } from "../loader/resolver.js";
import type { Platform } from "../platform/platform.js";
import { getBuiltinGlobals, getBuiltinModule } from "../builtins/index.js";
import {
  Environment,
  ExceptionValue,
  CoroutineValue,
  makeDict,
  makeClass,
  makeCoroutine,
  makeDescriptor,
  makeException,
  makeGenerator,
  makeInstance,
  makeSuper,
  makeFunction,
  makeIterator,
  makeList,
  makeNative,
  makeNone,
  ModuleValue,
  makeRange,
  makeSet,
  makeTuple,
  makeType,
  makeBytes,
  managedReferences,
  type DictEntry,
  type DictValue,
  type ClassValue,
  type InstanceValue,
  type SuperValue,
  type FunctionValue,
  type FunctionParameterSpec,
  type IteratorState,
  type IteratorValue,
  type GeneratorValue,
  type ListValue,
  type NativeValue,
  type RangeValue,
  type SetValue,
  type TupleValue,
  type TypeValue,
  type BytesValue,
  type Value,
} from "../runtime/values.js";

const libdir = os.platform() === "win32" ? "C:\\Program Files\\THM\\Lib\\" : "/usr/local/lib/thm/lib/";

interface Frame {
  chunk: Chunk;
  instructionPointer: number;
  stackBase: number;
  environment: Environment;
  module?: ModuleValue;
  capture?: { complete: boolean; value: Value | null; environment?: Environment };
  ownerClass?: ClassValue;
  callerInstructionIndex?: number;
  currentException?: ExceptionValue;
  generator?: GeneratorValue;
}

interface Comparison {
  result: boolean;
}

/** Tracks exceptions routed to a handler outside a callback's own frame. */
interface CallbackBoundary {
  depth: number;
  exception?: ExceptionValue;
}

interface CallArgumentSpec {
  kind: "positional" | "keyword" | "star" | "keywordStar";
  name?: string;
}

interface FunctionCreationMetadata {
  parameters: FunctionParameterSpec[];
  defaults: number;
  isAsync: boolean;
  isGenerator: boolean;
}

class ThmRaisedException extends Error {
  constructor(readonly value: ExceptionValue) {
    super(value.message);
    this.name = value.exceptionType;
  }
}

type ObjectValue = Exclude<Value, null | boolean | bigint | number | string>;

function isKind<K extends ObjectValue["kind"]>(
  value: Value,
  kind: K,
): value is Extract<ObjectValue, { kind: K }> {
  return typeof value === "object" && value !== null && value.kind === kind;
}

/** Built-in exception hierarchy: each name maps to its parent (null for the root). */
const EXCEPTION_PARENTS: Record<string, string | null> = {
  BaseException: null,
  Exception: "BaseException",
  ArithmeticError: "Exception",
  ZeroDivisionError: "ArithmeticError",
  OverflowError: "ArithmeticError",
  AssertionError: "Exception",
  AttributeError: "Exception",
  EOFError: "Exception",
  ImportError: "Exception",
  LookupError: "Exception",
  IndexError: "LookupError",
  KeyError: "LookupError",
  NameError: "Exception",
  OSError: "Exception",
  RuntimeError: "Exception",
  NotImplementedError: "RuntimeError",
  RecursionError: "RuntimeError",
  StopIteration: "Exception",
  TypeError: "Exception",
  ValueError: "Exception",
};

export class VM {
  readonly heap = new ManagedHeap();
  private readonly rootMetaclass = makeType(this.heap, "type");
  private readonly stack: Value[] = [];
  private readonly frames: Frame[] = [];
  private readonly temporaryRoots: Value[] = [];
  private readonly callbackBoundaries: CallbackBoundary[] = [];
  private readonly modules = new Map<string, ModuleValue>();
  private readonly moduleResolver: ModuleResolver;
  private builtins: Environment | null = null;
  private globals: Environment | null = null;
  private moduleResult: Value;

  constructor(
    readonly platform: Platform,
    readonly recursionLimit = 1000,
    moduleSearchPaths: string[] = [],
  ) {
    this.moduleResult = makeNone(this.heap);
    this.moduleResolver = new ModuleResolver(platform, moduleSearchPaths);
    if (!Number.isInteger(recursionLimit) || recursionLimit < 1) {
      throw new ThmValueError("recursion limit must be a positive integer");
    }
  }

  private typeCall(args: Value[]): Value {
    if (args.length === 1) return this.getType(args[0]!);
    if (args.length === 3) return this.typeNew([this.rootMetaclass, ...args]);
    throw new ThmTypeError("type() expects one or three arguments");
  }

  run(chunk: Chunk): Value {
    this.stack.length = 0;
    this.frames.length = 0;
    if (this.globals === null) {
      this.builtins = Environment.create(this.heap, null, true);
      this.globals = Environment.create(this.heap, this.builtins, true);
      this.installBuiltins();
    }
    this.frames.push({
      chunk,
      instructionPointer: 0,
      stackBase: this.stack.length,
      environment: this.globals,
    });
    this.executeUntil(0);
    return this.moduleResult;
  }

  invokeCallback(
    callback: Value,
    args: Value[],
    ownerClass?: ClassValue,
    keywords: ReadonlyMap<string, Value> = new Map(),
  ): Value {
    if (isKind(callback, "native")) {
      this.temporaryRoots.push(callback, ...args);
      this.rootKeywords(keywords);
      try {
        return this.callNative(callback, args, keywords);
      } finally {
        this.temporaryRoots.length = this.temporaryRoots.length - args.length - keywords.size - 1;
      }
    }
    if (!isKind(callback, "function")) throw new ThmTypeError("callback must be callable");
    const depth = this.frames.length;
    const stackBase = this.stack.length;
    const boundary: CallbackBoundary = { depth };
    const capture = depth === 0 ? { complete: false, value: makeNone(this.heap) } : undefined;
    this.callbackBoundaries.push(boundary);
    try {
      this.pushFunctionFrame(callback, args, keywords, capture, ownerClass);
      this.executeUntil(depth);

      // An exception handler in the caller can remove the callback frame from
      // the VM stack. Re-throw the original exception at the callback callsite
      // so the caller's executeInstruction dispatches it exactly once there.
      // Without this hand-off, the callback appears to have returned without a
      // value and the original exception is replaced by a RuntimeError.
      if (boundary.exception !== undefined) {
        throw new ThmRaisedException(boundary.exception);
      }
      if (capture?.complete) return capture.value;
      if (this.frames.length === depth && this.stack.length === stackBase + 1) return this.pop();
      throw new RuntimeError("Function call did not complete");
    } finally {
      const last = this.callbackBoundaries.pop();
      if (last !== boundary) {
        // Keep the boundary stack consistent even if a nested callback failed.
        const index = this.callbackBoundaries.lastIndexOf(boundary);
        if (index >= 0) this.callbackBoundaries.splice(index, 1);
      }
    }
  }

  collectGarbage(): number {
    return this.heap.collect(this.roots());
  }

  private executeUntil(frameDepth: number): void {
    while (this.frames.length > frameDepth) this.executeInstruction();
  }

  private executeInstruction(): void {
    const frame = this.frames[this.frames.length - 1];
    if (frame === undefined) return;
    const instructionIndex = frame.instructionPointer;
    const instruction = frame.chunk.code[frame.instructionPointer++];
    if (instruction === undefined) throw new RuntimeError(`Instruction pointer escaped ${frame.chunk.name}`);
    try {
      this.execute(frame, instruction);
    } catch (error) {
      this.dispatchException(error, frame, instructionIndex);
    }
  }

  private dispatchException(error: unknown, initialFrame: Frame, initialIndex: number): void {
      const exception = this.toExceptionValue(error);
      this.temporaryRoots.push(exception);
      let traceback: Traceback | undefined;
      try {
        traceback = new Traceback(this.captureTraceback(initialIndex));
        let frameIndex = this.frames.indexOf(initialFrame);
        let instructionIndex = initialIndex;
        while (frameIndex >= 0) {
          const frame = this.frames[frameIndex]!;
          const matching = frame.chunk.exceptions
            .filter((entry) => instructionIndex >= entry.start && instructionIndex < entry.end)
            .sort((left, right) => (left.end - left.start) - (right.end - right.start))[0];
          if (matching !== undefined) {
            attachTraceback(exception, traceback);
            // If the handler lives outside one or more active callback calls,
            // remember the exception for the corresponding invokeCallback().
            // That call must unwind back into the caller's instruction handler
            // rather than treating the already-removed callback frame as a
            // successful return.
            for (let boundaryIndex = this.callbackBoundaries.length - 1; boundaryIndex >= 0; boundaryIndex--) {
              const boundary = this.callbackBoundaries[boundaryIndex]!;
              if (frameIndex < boundary.depth) {
                boundary.exception = exception;
                break;
              }
            }

            this.frames.length = frameIndex + 1;
            this.stack.length = frame.stackBase + Math.max(0, matching.stackDepth - 1);
            this.stack.push(exception);
            frame.currentException = exception;
            frame.instructionPointer = matching.handler;
            return;
          }

          const callerIndex = frame.callerInstructionIndex;
          this.frames.length = frameIndex;
          this.stack.length = frame.stackBase;
          frameIndex--;
          if (frameIndex < 0) break;
          instructionIndex = callerIndex ?? this.frames[frameIndex]!.instructionPointer - 1;
        }
      } finally {
        this.temporaryRoots.pop();
      }

      if (error instanceof Error) {
        const finalTraceback = readTraceback(exception) ?? traceback;
        if (finalTraceback !== undefined) attachTraceback(error, finalTraceback);
        throw error;
      }
      const raised = new ThmRaisedException(exception);
      const finalTraceback = readTraceback(exception) ?? traceback;
      if (finalTraceback !== undefined) attachTraceback(raised, finalTraceback);
      throw raised;
    }

  private captureTraceback(initialIndex: number): TracebackFrame[] {
    const frames: TracebackFrame[] = [];
    const sourceCache = new Map<string, string[] | undefined>();
    let frameIndex = this.frames.length - 1;
    let instructionIndex = initialIndex;
    while (frameIndex >= 0) {
      const frame = this.frames[frameIndex]!;
      const instruction = frame.chunk.code[instructionIndex]!;
      const cached = sourceCache.get(frame.chunk.sourceFile);
      let lines: string[] | undefined;
      if (cached === undefined) {
        lines = this.readSourceLines(frame.chunk.sourceFile);
        sourceCache.set(frame.chunk.sourceFile, lines);
      } else {
        lines = cached;
      }
      frames.push({
        filename: frame.chunk.sourceFile,
        line: instruction.line,
        column: instruction.column,
        name: frame.chunk.name,
        sourceLine: this.sourceLineAt(lines, instruction.line),
      });
      const callerIndex = frame.callerInstructionIndex;
      frameIndex--;
      if (frameIndex < 0) break;
      instructionIndex = callerIndex ?? this.frames[frameIndex]!.instructionPointer - 1;
    }
    return frames;
  }

  private readSourceLines(path: string): string[] | undefined {
    try {
      return this.platform.readFile(path).split("\n");
    } catch {
      return undefined;
    }
  }

  private sourceLineAt(lines: string[] | undefined, line: number): string | undefined {
    if (lines === undefined || !Number.isInteger(line) || line < 1 || line > lines.length) return undefined;
    return lines[line - 1];
  }

  private toExceptionValue(error: unknown): ExceptionValue {
    if (error instanceof ThmRaisedException) return error.value;
    if (error instanceof ExceptionValue) return error;
    if (error instanceof Error) {
      const name = Object.prototype.hasOwnProperty.call(EXCEPTION_PARENTS, error.name) ? error.name : "RuntimeError";
      return makeException(this.heap, name, error.message);
    }
    return makeException(this.heap, "RuntimeError", String(error));
  }

  private exceptionMatches(exception: ExceptionValue, type: Value): boolean {
    if (!isKind(type, "type") || !this.isExceptionType(type.name)) {
      throw new ThmTypeError("except clause must name an exception type");
    }
    let current: string | null = exception.exceptionType;
    while (current !== null) {
      if (current === type.name) return true;
      current = EXCEPTION_PARENTS[current] ?? null;
    }
    return false;
  }

  private isExceptionType(name: string): boolean {
    return Object.prototype.hasOwnProperty.call(EXCEPTION_PARENTS, name);
  }

  private execute(frame: Frame, instruction: Instruction): void {
    switch (instruction.op) {
      case "CONST":
        this.stack.push(this.fromConstant(frame.chunk.constants[instruction.a!]!));
        return;
      case "LOAD":
        this.stack.push(this.load(frame.environment, frame.chunk.names[instruction.a!]!, instruction.text ?? "closure"));
        return;
      case "STORE":
        this.store(frame.environment, frame.chunk.names[instruction.a!]!, instruction.text ?? "local", this.pop());
        return;
      case "POP":
        this.pop();
        return;
      case "DUP":
        this.stack.push(this.peek());
        return;
      case "DUP2": {
        const second = this.peek();
        const first = this.peek(1);
        this.stack.push(first, second);
        return;
      }
      case "DEL_ATTR": {
        this.deleteAttribute(this.pop(), frame.chunk.names[instruction.a!]!);
        return;
      }
      case "SWAP": {
        const top = this.pop();
        const below = this.pop();
        this.stack.push(top, below);
        return;
      }
      case "ROT3": {
        const third = this.pop();
        const second = this.pop();
        const first = this.pop();
        this.stack.push(second, third, first);
        return;
      }
      case "UNARY":
        this.stack.push(this.unary(instruction.text ?? "", this.pop()));
        return;
      case "BINARY": {
        const right = this.pop();
        const left = this.pop();
        this.stack.push(this.binary(instruction.text ?? "", left, right));
        return;
      }
      case "COMPARE": {
        const right = this.pop();
        const left = this.pop();
        this.stack.push(this.compare(instruction.text ?? "", left, right));
        return;
      }
      case "COMPARE_JUMP": {
        const right = this.pop();
        const left = this.pop();
        if (this.compare(instruction.text ?? "", left, right)) this.stack.push(right);
        else {
          this.stack.push(false);
          frame.instructionPointer = instruction.a!;
        }
        return;
      }
      case "COMPARE_CHAIN": {
        const operands = this.popMany(instruction.a! + 1);
        const operators = (instruction.text ?? "").split("\n");
        let result = true;
        for (let index = 0; index < operators.length; index++) {
          if (!this.compare(operators[index] ?? "", operands[index]!, operands[index + 1]!)) {
            result = false;
            break;
          }
        }
        this.stack.push(result);
        return;
      }
      case "BUILD_LIST":
        this.stack.push(makeList(this.heap, this.popMany(instruction.a!)));
        return;
      case "BUILD_TUPLE":
        this.stack.push(makeTuple(this.heap, this.popMany(instruction.a!)));
        return;
      case "BUILD_SET": {
        const set = makeSet(this.heap);
        for (const value of this.popMany(instruction.a!)) this.setAdd(set, value);
        this.stack.push(set);
        return;
      }
      case "BUILD_DICT": {
        const values = this.popMany(instruction.a! * 2);
        const dictionary = makeDict(this.heap);
        for (let index = 0; index < values.length; index += 2) {
          this.dictSet(dictionary, values[index]!, values[index + 1]!);
        }
        this.stack.push(dictionary);
        return;
      }
      case "LIST_APPEND": {
        const value = this.pop();
        const list = this.pop();
        if (!isKind(list, "list")) throw new ThmTypeError("list comprehension target is not a list");
        list.items.push(value);
        this.stack.push(list);
        return;
      }
      case "SET_ADD": {
        const value = this.pop();
        const set = this.pop();
        if (!isKind(set, "set")) throw new ThmTypeError("set comprehension target is not a set");
        this.setAdd(set, value);
        this.stack.push(set);
        return;
      }
      case "DICT_SET": {
        const value = this.pop();
        const key = this.pop();
        const dictionary = this.pop();
        if (!isKind(dictionary, "dict")) throw new ThmTypeError("dict comprehension target is not a dictionary");
        this.dictSet(dictionary, key, value);
        this.stack.push(dictionary);
        return;
      }
      case "BUILD_STRING": {
        const parts = this.popMany(instruction.a!);
        this.stack.push(parts.map((part) => this.stringify(part, false)).join(""));
        return;
      }
      case "UNPACK_SEQUENCE": {
        const values = this.unpack(this.pop(), instruction.a!);
        for (let index = values.length - 1; index >= 0; index--) this.stack.push(values[index]!);
        return;
      }
      case "GET_ATTR": {
        const receiver = this.pop();
        this.stack.push(this.getAttribute(receiver, frame.chunk.names[instruction.a!]!));
        return;
      }
      case "IMPORT": {
        const imported = this.importModule(instruction.text ?? "", frame.module);
        const result = instruction.a === 0 && imported.name.includes(".")
          ? this.modules.get(imported.name.split(".")[0]!) ?? imported
          : imported;
        this.stack.push(result);
        return;
      }
      case "EXC_MATCH": {
        const type = this.pop();
        const exception = this.pop();
        if (!isKind(exception, "exception")) throw new RuntimeError("Invalid exception handler stack");
        this.stack.push(this.exceptionMatches(exception, type));
        return;
      }
      case "RAISE": {
        if (instruction.a === 0) {
          if (frame.currentException === undefined) {
            throw new ThmTypeError("no active exception to reraise");
          }
          throw new ThmRaisedException(frame.currentException);
        }
        const value = this.pop();
        if (!isKind(value, "exception")) throw new ThmTypeError("exceptions must derive from BaseException");
        throw new ThmRaisedException(value);
      }
      case "SET_ATTR": {
        const value = this.pop();
        const receiver = this.pop();
        this.setAttribute(receiver, frame.chunk.names[instruction.a!]!, value);
        return;
      }
      case "GET_ITEM": {
        const key = this.pop();
        const receiver = this.pop();
        this.stack.push(this.getItem(receiver, key));
        return;
      }
      case "SET_ITEM": {
        const value = this.pop();
        const key = this.pop();
        const receiver = this.pop();
        this.setItem(receiver, key, value);
        return;
      }
      case "DEL_NAME":
        this.deleteName(frame.environment, frame.chunk.names[instruction.a!]!, instruction.text ?? "local");
        return;
      case "DEL_ITEM": {
        const key = this.pop();
        const receiver = this.pop();
        this.deleteItem(receiver, key);
        return;
      }
      case "DEL_SLICE": {
        const step = this.pop();
        const stop = this.pop();
        const start = this.pop();
        const receiver = this.pop();
        this.deleteSlice(receiver, start, stop, step);
        return;
      }
      case "SET_SLICE": {
        const step = this.pop();
        const stop = this.pop();
        const start = this.pop();
        const receiver = this.pop();
        const value = this.pop();
        this.setSlice(receiver, start, stop, step, value);
        return;
      }
      case "GET_SLICE": {
        const step = this.pop();
        const stop = this.pop();
        const start = this.pop();
        const receiver = this.pop();
        this.stack.push(this.getSlice(receiver, start, stop, step));
        return;
      }
      case "JUMP":
        frame.instructionPointer = instruction.a!;
        return;
      case "JUMP_IF_FALSE":
        if (!this.truthy(this.pop())) frame.instructionPointer = instruction.a!;
        return;
      case "JUMP_IF_TRUE":
        if (this.truthy(this.pop())) frame.instructionPointer = instruction.a!;
        return;
      case "ITER":
        this.stack.push(this.toIterator(this.pop()));
        return;
      case "YIELD": {
        // Suspend the generator frame: pop it, hand the yielded value back to
        // the resuming iterator, and keep the environment alive on the
        // generator object for the next resume.
        const generatorFrame = this.frames.pop()!;
        const value = this.pop();
        const generator = generatorFrame.generator;
        if (generator === undefined) {
          throw new RuntimeError("YIELD outside a generator frame");
        }
        if (this.stack.length < generatorFrame.stackBase) {
          throw new RuntimeError("Generator yielded with an unbalanced operand stack");
        }
        this.stack.length = generatorFrame.stackBase;
        generator.frame = generatorFrame;
        generator.pendingValue = value;
        return;
      }
      case "ITER_NEXT": {
        const iterator = this.peek();
        if (!isKind(iterator, "iterator")) throw new ThmTypeError("invalid iterator on VM stack");
        const result = this.next(iterator);
        if (result.done) {
          this.pop();
          frame.instructionPointer = instruction.a!;
        } else {
          this.stack.push(result.value);
        }
        return;
      }
      case "MAKE_FUNCTION": {
        const nested = frame.chunk.nested[instruction.a!];
        if (nested === undefined) throw new RuntimeError("Invalid nested function index");
        const metadata = parseFunctionCreationMetadata(instruction.text, nested.parameters);
        const defaults = this.popMany(metadata.defaults);
        this.stack.push(makeFunction(
          this.heap,
          nested.name,
          nested,
          frame.environment,
          metadata.parameters,
          defaults,
          metadata.isAsync,
          metadata.isGenerator,
        ));
        return;
      }
      case "MAKE_CLASS": {
        const nested = frame.chunk.nested[instruction.a!];
        if (nested === undefined) throw new RuntimeError("Invalid nested class body");
        const baseValue = this.pop();
        let metaclassValue = this.pop();
        if (!isKind(baseValue, "tuple")) throw new RuntimeError("Invalid class base tuple");
        const bases: ClassValue[] = [];
        let isMetaclass = false;
        for (const base of baseValue.items) {
          if ((isKind(base, "type") && base.name === "type") || (isKind(base, "native") && base.name === "type")) {
            if (bases.length > 0 || baseValue.items.length > 1) {
              throw new ThmTypeError("type cannot be combined with other class bases");
            }
            isMetaclass = true;
            continue;
          }
          if (!isKind(base, "class")) throw new ThmTypeError("class bases must be classes");
          if (bases.includes(base)) throw new ThmTypeError("duplicate base class");
          bases.push(base);
        }
        if (isKind(metaclassValue, "native") && metaclassValue.name === "type") {
          metaclassValue = this.rootMetaclass;
        }
        isMetaclass ||= bases.some((base) => base.isMetaclass);
        if (
          !isKind(metaclassValue, "none") &&
          !isKind(metaclassValue, "class") &&
          !(isKind(metaclassValue, "type") && metaclassValue.name === "type")
        ) {
          throw new ThmTypeError("metaclass must be a subclass of type");
        }
        if (isKind(metaclassValue, "class") && !metaclassValue.isMetaclass) {
          throw new ThmTypeError("metaclass must be a subclass of type");
        }
        const metaclassCandidates: Array<ClassValue | TypeValue> = bases.map((base) =>
          base.metaclass ?? this.rootMetaclass,
        );
        if (!isKind(metaclassValue, "none")) {
          metaclassCandidates.push(
            isKind(metaclassValue, "class") ? metaclassValue : this.rootMetaclass,
          );
        } else if (metaclassCandidates.length === 0) {
          metaclassCandidates.push(this.rootMetaclass);
        }
        let classMetaclass = metaclassCandidates[0]!;
        for (const candidate of metaclassCandidates.slice(1)) {
          if (this.isMetaclassSubclass(candidate, classMetaclass)) classMetaclass = candidate;
          else if (!this.isMetaclassSubclass(classMetaclass, candidate)) {
            throw new ThmTypeError("metaclass conflict: the metaclass of a derived class must be a subclass of the metaclasses of all its bases");
          }
        }
        if (this.frames.length >= this.recursionLimit) {
          throw new ThmRecursionError(`maximum recursion depth exceeded (${this.recursionLimit})`);
        }
        const environment = Environment.create(this.heap, frame.environment, false);
        for (const name of nested.localNames) environment.declare(name);
        const classStackBase = this.stack.length;
        this.frames.push({
          chunk: nested, instructionPointer: 0, stackBase: this.stack.length, environment,
          module: this.moduleForEnvironment(frame.environment),
          callerInstructionIndex: frame.instructionPointer - 1,
        });
        const depth = this.frames.length - 1;
        this.executeUntil(depth);
        if (this.stack.length !== classStackBase + 1) {
          throw new RuntimeError(`Class body ${instruction.text ?? nested.name} did not complete`);
        }
        this.pop();
        let klass: Value;
        try {
          klass = this.createClass(
            instruction.text ?? nested.name,
            environment,
            bases,
            classMetaclass,
            isMetaclass,
            nested.genericParameters,
          );
        } catch (error) {
          if (error instanceof Error && error.message.includes("method resolution order")) {
            throw new ThmTypeError(`Cannot create a consistent method resolution order (MRO) for '${instruction.text ?? nested.name}'`);
          }
          throw error;
        }
        this.stack.push(klass);
        return;
      }
      case "CALL": {
        const values = this.popMany(instruction.a!);
        const callee = this.pop();
        const { args, keywords } = this.expandCallArguments(
          values,
          parseCallArgumentSpecs(instruction.text, values.length),
        );
        if (isKind(callee, "function")) {
          if (callee.isGenerator) {
            this.stack.push(makeGenerator(this.heap, callee.name, callee, [...args], new Map(keywords)));
            return;
          }
          this.callFunctionValue(callee, args, keywords);
          return;
        }
        if (isKind(callee, "native")) {
          this.temporaryRoots.push(callee, ...args);
          this.rootKeywords(keywords);
          try {
            this.stack.push(this.callNative(callee, args, keywords));
          } finally {
            this.temporaryRoots.length = this.temporaryRoots.length - args.length - keywords.size - 1;
          }
          return;
        }
        if (isKind(callee, "class")) {
          this.temporaryRoots.push(callee, ...args);
          this.rootKeywords(keywords);
          try { this.stack.push(this.callClass(callee, args, keywords)); }
          finally { this.temporaryRoots.length = this.temporaryRoots.length - args.length - keywords.size - 1; }
          return;
        }
        if (isKind(callee, "type")) {
          this.temporaryRoots.push(callee, ...args);
          this.rootKeywords(keywords);
          try {
            if (keywords.size > 0 && callee.name !== "dict") {
              throw new ThmTypeError(`${callee.name}() does not accept keyword arguments`);
            }
            this.stack.push(this.callType(callee, args, keywords));
          } finally {
            this.temporaryRoots.length = this.temporaryRoots.length - args.length - keywords.size - 1;
          }
          return;
        }
        throw new ThmTypeError(`${this.typeName(callee)} object is not callable`);
      }
      case "AWAIT": {
        const value = this.pop();
        if (isKind(value, "coroutine")) {
          this.stack.push(this.runCoroutine(value));
          return;
        }
        this.stack.push(value);
        return;
      }
      case "RETURN":
        this.returnFromFrame(this.pop());
        return;
      case "HALT":
        if (this.stack.length !== frame.stackBase) throw new RuntimeError("HALT with an unbalanced operand stack");
        this.frames.pop();
        return;
    }
  }

  private pushFunctionFrame(
    fn: FunctionValue,
    args: Value[],
    keywords: ReadonlyMap<string, Value> = new Map(),
    capture?: { complete: boolean; value: Value | null; environment?: Environment },
    ownerClass?: ClassValue,
  ): void {
    const environment = this.bindFunction(fn, args, keywords);
    this.frames.push({
      chunk: fn.chunk,
      instructionPointer: 0,
      stackBase: this.stack.length,
      environment,
      module: this.moduleForEnvironment(environment),
      capture,
      ownerClass,
      callerInstructionIndex: this.frames.length > 0
        ? this.frames[this.frames.length - 1]!.instructionPointer - 1
        : undefined,
    });
  }

  private bindFunction(
    fn: FunctionValue,
    args: Value[],
    keywords: ReadonlyMap<string, Value> = new Map(),
  ): Environment {
    if (fn.closure === null) throw new RuntimeError(`Function ${fn.name} has been released`);
    if (this.frames.length >= this.recursionLimit) {
      throw new ThmRecursionError(`maximum recursion depth exceeded (${this.recursionLimit})`);
    }
    const environment = Environment.create(this.heap, fn.closure, false);
    for (const name of fn.chunk.localNames) environment.declare(name);
    const positional = fn.parameterSpecs.filter((parameter) => parameter.kind === "positional");
    const vararg = fn.parameterSpecs.find((parameter) => parameter.kind === "vararg");
    const kwarg = fn.parameterSpecs.find((parameter) => parameter.kind === "kwarg");
    const assigned = new Map<string, Value>();
    for (let index = 0; index < args.length; index++) {
      const parameter = positional[index];
      if (parameter === undefined) {
        if (vararg === undefined) {
          throw new ThmTypeError(`${fn.name}() takes ${positional.length} positional arguments but ${args.length} were given`);
        }
        break;
      }
      assigned.set(parameter.name, args[index]!);
    }
    const extras = args.slice(positional.length);
    const extraKeywords = new Map<string, Value>();
    for (const [name, value] of keywords) {
      const parameter = fn.parameterSpecs.find((item) => item.name === name);
      if (parameter === undefined) {
        if (kwarg === undefined) throw new ThmTypeError(`${fn.name}() got an unexpected keyword argument '${name}'`);
        extraKeywords.set(name, value);
      } else {
        if (parameter.kind === "vararg" || parameter.kind === "kwarg") {
          throw new ThmTypeError(`${fn.name}() got an unexpected keyword argument '${name}'`);
        }
        if (assigned.has(name)) throw new ThmTypeError(`${fn.name}() got multiple values for argument '${name}'`);
        assigned.set(name, value);
      }
    }
    let defaultIndex = 0;
    for (const parameter of fn.parameterSpecs) {
      if (parameter.kind === "vararg") {
        environment.set(parameter.name, makeTuple(this.heap, extras));
      } else if (parameter.kind === "kwarg") {
        const dictionary = makeDict(this.heap);
        for (const [name, value] of extraKeywords) this.dictSet(dictionary, name, value);
        environment.set(parameter.name, dictionary);
      } else {
        let value = assigned.get(parameter.name);
        if (value === undefined && !assigned.has(parameter.name)) {
          if (parameter.hasDefault) value = fn.defaults[defaultIndex];
          if (value === undefined && !parameter.hasDefault) {
            throw new ThmTypeError(`${fn.name}() missing required argument '${parameter.name}'`);
          }
        }
        if (parameter.hasDefault) defaultIndex++;
        if (value !== undefined || assigned.has(parameter.name)) environment.set(parameter.name, value!);
      }
    }
    return environment;
  }

  private callFunctionValue(
    fn: FunctionValue,
    args: Value[],
    keywords: ReadonlyMap<string, Value> = new Map(),
  ): void {
    if (fn.isAsync) {
      this.stack.push(makeCoroutine(this.heap, fn.name, fn, [...args], new Map(keywords)));
      return;
    }
    this.pushFunctionFrame(fn, args, keywords);
  }

  private runCoroutine(coroutine: CoroutineValue): Value {
    if (coroutine.done) {
      if (coroutine.error !== undefined) throw coroutine.error;
      if (coroutine.result === null) throw new RuntimeError("Coroutine completed without result");
      return coroutine.result;
    }
    if (coroutine.started) {
      throw new RuntimeError(`coroutine ${coroutine.name}() was already awaited`);
    }
    coroutine.started = true;
    try {
      const result = this.invokeCallback(coroutine.fn, [...coroutine.args], undefined, coroutine.keywords);
      coroutine.result = result;
      coroutine.done = true;
      coroutine.args.length = 0;
      return result;
    } catch (error) {
      coroutine.error = error;
      coroutine.done = true;
      coroutine.args.length = 0;
      throw error;
    }
  }

  /** Current module search paths as a THM list (cwd, configured extras, lib). */
  moduleSearchPaths(): Value {
    const cwd = this.platform.cwd();
    return makeList(this.heap, [
      cwd,
      cwd + "/lib",
      libdir
    ]);
  }

  private moduleForEnvironment(environment: Environment): ModuleValue | undefined {
    let current: Environment | null = environment;
    while (current !== null) {
      if (current.module !== null) return current.module;
      current = current.parent;
    }
    return undefined;
  }

  private returnFromFrame(value: Value): void {
    const frame = this.frames.pop();
    if (frame === undefined) throw new RuntimeError("RETURN without a frame");
    if (frame.generator !== undefined) {
      // Generator completing after its last yield: mark it exhausted instead
      // of returning to a caller frame.
      frame.generator.done = true;
      frame.generator.frame = null;
      return;
    }
    if (this.stack.length !== frame.stackBase) {
      throw new RuntimeError(`Stack was not restored when returning from ${frame.chunk.name}`);
    }
    if (frame.capture !== undefined) {
      frame.capture.environment = frame.environment;
      frame.capture.value = value;
      frame.capture.complete = true;
    } else if (this.frames.length > 0) {
      this.stack.push(value);
    } else {
      this.moduleResult = value;
    }
  }

  private installBuiltins(): void {
    const globals = this.builtins!;
    const typeNames = [...Object.keys(EXCEPTION_PARENTS), "bool", "dict", "float", "int", "list", "range", "set", "str", "tuple"];
    for (const name of typeNames) globals.set(name, makeType(this.heap, name));

    this.addBuiltin("write", (vm: VM, _receiver: Value | undefined, args: Value[]): Value => {
      vm.platform.stdout(`${args.map((value: Value) => vm.stringify(value, false)).join(" ")}\n`);
      return makeNone(vm.heap);
    });
    this.addBuiltin("print", (vm, receiver, args) => {
      const write = vm.readGlobal("write");
      if (!isKind(write, "native")) throw new RuntimeError("write builtin was replaced with a non-native value");
      return vm.callNative(write, args);
    });
    this.addBuiltin("len", (vm, _receiver, args) => {
      vm.requireArgCount("len", args, 1);
      const value = args[0]!;
      if (typeof value === "string") return value.length;
      if (isKind(value, "list") || isKind(value, "tuple")) return value.items.length;
      if (isKind(value, "dict")) return value.entries.length;
      if (isKind(value, "set")) return value.items.length;
      if (isKind(value, "range")) return value.length;
      throw new ThmTypeError(`object of type '${vm.typeName(value)}' has no len()`);
    });
    this.addBuiltin("isinstance", (vm, _receiver, args) => {
      vm.requireArgCount("isinstance", args, 2);
      const type = args[1]!;
      if (isKind(type, "class")) {
        const value = args[0]!;
        if (isKind(value, "class")) {
          const metaclass = value.metaclass;
          if (metaclass !== null && metaclass.kind === "class") {
            return vm.isSubclass(metaclass, type);
          }
        }
        if (!isKind(value, "instance")) return false;
        return vm.isSubclass(value.klass, type);
      }
      if (isKind(type, "native") && type.name === "type") {
        return isKind(args[0]!, "class");
      }
      if (!isKind(type, "type")) throw new ThmTypeError("isinstance() arg 2 must be a type");
      if (isKind(args[0]!, "class") && type.name === "type") return true;
      return vm.isInstance(args[0]!, type.name);
    });
    this.addBuiltin("issubclass", (vm, _receiver, args) => {
      vm.requireArgCount("issubclass", args, 2);
      if (isKind(args[0]!, "class") && isKind(args[1]!, "type") && args[1]!.name === "type") {
        return args[0]!.isMetaclass;
      }
      if (isKind(args[0]!, "class") && isKind(args[1]!, "native") && args[1]!.name === "type") {
        return args[0]!.isMetaclass;
      }
      if (!isKind(args[0]!, "class") || !isKind(args[1]!, "class")) {
        throw new ThmTypeError("issubclass() arguments must be classes");
      }
      return vm.isSubclass(args[0] as ClassValue, args[1] as ClassValue);
    });
    this.addBuiltin("super", (vm, _receiver, args) => {
      if (args.length !== 0) throw new ThmTypeError("super() currently expects no arguments");
      const frame = vm.frames[vm.frames.length - 1];
      if (frame?.ownerClass === undefined) throw new ThmTypeError("super(): no enclosing class method");
      const firstParameter = frame.chunk.parameters[0];
      const cell = firstParameter === undefined ? undefined : frame.environment.cells.get(firstParameter);
      if (cell === undefined || !cell.bound || cell.value === null || (!isKind(cell.value, "instance") && !isKind(cell.value, "class"))) {
        throw new ThmTypeError("super(): first method argument must be an instance or class");
      }
      const runtimeClass = isKind(cell.value, "instance") ? cell.value.klass : cell.value;
      const ownerIndex = runtimeClass.mro.indexOf(frame.ownerClass);
      const nextClass = runtimeClass.mro[ownerIndex + 1];
      if (nextClass === undefined) throw new ThmTypeError("super(): no next class in method resolution order");
      return makeSuper(vm.heap, cell.value, nextClass);
    });
    this.addBuiltin("staticmethod", (vm, _receiver, args) => {
      vm.requireArgCount("staticmethod", args, 1);
      return makeDescriptor(vm.heap, "staticmethod", args[0]!);
    });
    this.addBuiltin("classmethod", (vm, _receiver, args) => {
      vm.requireArgCount("classmethod", args, 1);
      return makeDescriptor(vm.heap, "classmethod", args[0]!);
    });
    this.addBuiltin("property", (vm, _receiver, args) => {
      if (args.length < 1 || args.length > 3) {
        throw new ThmTypeError("property() expects one to three arguments");
      }
      return makeDescriptor(vm.heap, "property", args[0]!, args[1] ?? makeNone(vm.heap), args[2] ?? makeNone(vm.heap));
    });
    this.addBuiltin("type", (vm, _receiver, args) => vm.typeCall(args));
    this.addBuiltin("gc_collect", (vm, _receiver, args) => {
      vm.requireArgCount("gc_collect", args, 0);
      return vm.collectGarbage();
    });
    this.addBuiltin("enumerate", (vm, _receiver, args) => {
      if (args.length < 1 || args.length > 2) throw new ThmTypeError("enumerate() expects one or two arguments");
      const start = args.length === 2 ? vm.integer(args[1]!, "enumerate start") : 0;
      return makeIterator(vm.heap, { kind: "enumerate", source: vm.toIterator(args[0]!), index: start });
    });
    this.addBuiltin("zip", (vm, _receiver, args) =>
      makeIterator(vm.heap, { kind: "zip", sources: args.map((value) => vm.toIterator(value)) }),
    );
    this.addBuiltin("map", (vm, _receiver, args) => {
      if (args.length < 2) throw new ThmTypeError("map() expects a function and at least one iterable");
      return makeIterator(vm.heap, {
        kind: "map",
        callback: args[0]!,
        sources: args.slice(1).map((value) => vm.toIterator(value)),
      });
    });
    this.addBuiltin("filter", (vm, _receiver, args) => {
      vm.requireArgCount("filter", args, 2);
      return makeIterator(vm.heap, {
        kind: "filter",
        callback: args[0],
        source: vm.toIterator(args[1]!),
      });
    });
    this.addBuiltin("reversed", (vm, _receiver, args) => {
      vm.requireArgCount("reversed", args, 1);
      const value = args[0]!;
      if (isKind(value, "list") || isKind(value, "tuple")) {
        return makeIterator(vm.heap, { kind: "reverse-sequence", source: value, index: value.items.length - 1 });
      }
      if (typeof value === "string") {
        return makeIterator(vm.heap, { kind: "reverse-string", source: value, index: value.length - 1 });
      }
      throw new ThmTypeError(`'${vm.typeName(value)}' object is not reversible`);
    });
    this.addBuiltin("min", (vm, _receiver, args, keywords) => vm.minMax("min", args, keywords), true);
    this.addBuiltin("max", (vm, _receiver, args, keywords) => vm.minMax("max", args, keywords), true);
    this.addBuiltin("sorted", (vm, _receiver, args, keywords) => {
      vm.requireArgCount("sorted", args, 1);
      const { key, reverse } = vm.sortKeywords("sorted", keywords);
      const items = [...vm.iterateAll(args[0]!)];
      vm.sortValues(items, key, reverse);
      return makeList(vm.heap, items);
    }, true);
    this.addBuiltin("abs", (vm, _receiver, args) => {
      vm.requireArgCount("abs", args, 1);
      const value = args[0]!;
      if (typeof value === "bigint") return value < BigInt(0) ? -value : value;
      if (typeof value === "boolean") return BigInt(value ? 1 : 0);
      return Math.abs(vm.number(value, "abs"));
    });
    this.addBuiltin("sum", (vm, _receiver, args) => {
      if (args.length < 1 || args.length > 2) throw new ThmTypeError("sum() expects one or two arguments");
      let total: Value = args.length === 2 ? args[1]! : BigInt(0);
      for (const item of vm.iterateAll(args[0]!)) {
        if (typeof item === "string" || typeof total === "string") {
          throw new ThmTypeError("sum() can't sum strings [use ''.join(seq) instead]");
        }
        total = vm.binary("+", total, item);
      }
      return total;
    });
    this.addBuiltin("any", (vm, _receiver, args) => {
      vm.requireArgCount("any", args, 1);
      return vm.iterateAll(args[0]!).some((item) => vm.truthy(item));
    });
    this.addBuiltin("all", (vm, _receiver, args) => {
      vm.requireArgCount("all", args, 1);
      return vm.iterateAll(args[0]!).every((item) => vm.truthy(item));
    });
    this.addBuiltin("round", (vm, _receiver, args) => {
      if (args.length < 1 || args.length > 2) throw new ThmTypeError("round() expects one or two arguments");
      const value = args[0]!;
      const digits = args.length === 2 && args[1] !== null ? vm.integer(args[1]!, "round() ndigits") : null;
      const roundHalfEven = (x: number): number => {
        const floor = Math.floor(x);
        const diff = x - floor;
        if (diff < 0.5) return floor;
        if (diff > 0.5) return floor + 1;
        return floor % 2 === 0 ? floor : floor + 1;
      };
      if (typeof value === "bigint" || typeof value === "boolean") {
        const integer = vm.exactInteger(value, "round()");
        if (digits === null || digits >= 0) return integer;
        const factor = BigInt(10) ** BigInt(-digits);
        const rounded = BigInt(roundHalfEven(Number(integer) / Number(factor)));
        return rounded * factor;
      }
      const number = vm.number(value, "round");
      if (digits === null) {
        if (!Number.isFinite(number)) throw new ThmValueError("cannot round a non-finite number");
        return BigInt(roundHalfEven(number));
      }
      const factor = 10 ** digits;
      const scaled = Number((number * factor).toPrecision(15));
      return roundHalfEven(scaled) / factor;
    });
    this.addBuiltin("repr", (vm, _receiver, args) => {
      vm.requireArgCount("repr", args, 1);
      return vm.stringify(args[0]!, true);
    });
    this.addBuiltin("chr", (vm, _receiver, args) => {
      vm.requireArgCount("chr", args, 1);
      const code = vm.integer(args[0]!, "chr() argument");
      if (code < 0 || code > 0x10ffff) throw new ThmValueError("chr() arg not in range(0x110000)");
      return String.fromCodePoint(code);
    });
    this.addBuiltin("ord", (vm, _receiver, args) => {
      vm.requireArgCount("ord", args, 1);
      const value = args[0]!;
      if (typeof value !== "string" || Array.from(value).length !== 1) {
        throw new ThmTypeError("ord() expected a character");
      }
      return BigInt(value.codePointAt(0)!);
    });
    this.addBuiltin("divmod", (vm, _receiver, args) => {
      vm.requireArgCount("divmod", args, 2);
      return makeTuple(vm.heap, [
        vm.binary("//", args[0]!, args[1]!),
        vm.binary("%", args[0]!, args[1]!),
      ]);
    });
    this.addBuiltin("pow", (vm, _receiver, args) => {
      vm.requireArgCount("pow", args, 2);
      return vm.binary("**", args[0]!, args[1]!);
    });
    const radix = (name: string, base: number, prefix: string): void => {
      this.addBuiltin(name, (vm, _receiver, args) => {
        vm.requireArgCount(name, args, 1);
        const value = vm.exactInteger(args[0]!, `${name}() argument`);
        return (value < BigInt(0) ? "-" : "") + prefix + (value < BigInt(0) ? -value : value).toString(base);
      });
    };
    radix("hex", 16, "0x");
    radix("bin", 2, "0b");
    radix("oct", 8, "0o");
    this.addBuiltin("callable", (vm, _receiver, args) => {
      vm.requireArgCount("callable", args, 1);
      const value = args[0]!;
      return isKind(value, "function") || isKind(value, "native") || isKind(value, "class") ||
        isKind(value, "type") || (isKind(value, "instance") && vm.lookupClassMemberWithOwner(value.klass, "__call__") !== undefined);
    });
    this.addBuiltin("iter", (vm, _receiver, args) => {
      vm.requireArgCount("iter", args, 1);
      return vm.toIterator(args[0]!);
    });
    this.addBuiltin("next", (vm, _receiver, args) => {
      if (args.length < 1 || args.length > 2) throw new ThmTypeError("next() expects one or two arguments");
      const iterator = args[0]!;
      if (!isKind(iterator, "iterator")) throw new ThmTypeError(`'${vm.typeName(iterator)}' object is not an iterator`);
      const result = vm.next(iterator);
      if (!result.done) return result.value;
      if (args.length === 2) return args[1]!;
      throw new ThmStopIteration();
    });
    this.addBuiltin("input", (vm, _receiver, args) => {
      if (args.length > 1) throw new ThmTypeError("input() expects zero or one argument");
      if (args.length === 1) vm.platform.stdout(vm.stringify(args[0]!, false));
      if (vm.platform.readLine === undefined) throw new ThmOSError("input() is not available on this platform");
      const line = vm.platform.readLine();
      if (line === null) throw new ThmEOFError();
      return line;
    });
    this.addBuiltin("hasattr", (vm, _receiver, args) => {
      vm.requireArgCount("hasattr", args, 2);
      if (typeof args[1] !== "string") throw new ThmTypeError("hasattr(): attribute name must be a string");
      try {
        vm.getAttribute(args[0]!, args[1]);
        return true;
      } catch (error) {
        if (error instanceof ThmAttributeError || error instanceof ThmKeyError) return false;
        throw error;
      }
    });
    this.addBuiltin("getattr", (vm: VM, _receiver: Value | undefined, args: Value[]): Value => {
      if (args.length < 2 || args.length > 3) throw new ThmTypeError("getattr() expects two or three arguments");
      if (typeof args[1] !== "string") throw new ThmTypeError("getattr(): attribute name must be a string");
      try {
        return vm.getAttribute(args[0]!, args[1]);
      } catch (error) {
        if (args.length === 3 && (error instanceof ThmAttributeError || error instanceof ThmKeyError)) return args[2]!;
        throw error;
      }
    });
    this.addBuiltin("setattr", (vm: VM, _receiver: Value | undefined, args: Value[]): Value => {
      vm.requireArgCount("setattr", args, 3);
      if (typeof args[1] !== "string") throw new ThmTypeError("setattr(): attribute name must be a string");
      vm.setAttribute(args[0]!, args[1], args[2]!);
      return makeNone(vm.heap);
    });

    const registered = getBuiltinGlobals();
    for (const [name, callback] of Object.entries(registered.functions)) {
      this.installRegisteredGlobal(name, makeNative(this.heap, name, callback));
    }
    for (const [name, value] of Object.entries(registered.values)) {
      this.installRegisteredGlobal(name, value);
    }
  }

  private installRegisteredGlobal(name: string, value: Value | null): void {
    const builtins = this.builtins!;
    if (builtins.cells.has(name)) {
      throw new RuntimeError(`Built-in global '${name}' conflicts with an existing built-in`);
    }
    builtins.set(name, value === null ? makeNone(this.heap) : value);
  }

  private importModule(requestedName: string, importer?: ModuleValue): ModuleValue {
    const name = this.moduleResolver.resolveName(requestedName, importer?.packageName ?? "");
    const existing = this.modules.get(name);
    if (existing !== undefined) return existing;

    const parentName = name.includes(".") ? name.slice(0, name.lastIndexOf(".")) : "";
    const parent = parentName === "" ? undefined : this.importModule(parentName, importer);
    if (parent !== undefined && !parent.isPackage) {
      throw new ThmImportError(`'${parentName}' is not a package`);
    }

    const resolved = this.moduleResolver.resolveFile(name);
    if (resolved === undefined) {
      const builtin = getBuiltinModule(name);
      if (builtin === undefined || parent !== undefined) {
        throw new ThmImportError(`No module named '${name}'`);
      }
      const environment = Environment.create(this.heap, this.builtins, true);
      environment.set("__name__", name);
      const module = this.heap.allocate(
        (heapId) => new ModuleValue(heapId, name, environment, false, ""),
      );
      environment.module = module;
      this.modules.set(name, module);
      for (const [memberName, callback] of Object.entries(builtin.functions)) {
        environment.set(memberName, makeNative(this.heap, `${name}.${memberName}`, callback));
      }
      for (const [memberName, value] of Object.entries(builtin.values)) environment.set(memberName, value);
      return module;
    }

    const packageName = resolved.isPackage
      ? name
      : parentName;
    const environment = Environment.create(this.heap, this.builtins, true);
    environment.set("__name__", name);
    environment.set("__file__", resolved.path);
    const module = this.heap.allocate(
      (heapId) => new ModuleValue(heapId, name, environment, resolved.isPackage, packageName),
    );
    environment.module = module;
    this.modules.set(name, module);
    if (parent !== undefined) parent.environment.set(name.slice(parentName.length + 1), module);

    try {
      const source = this.platform.readFile(resolved.path);
      const chunk = compile(parse(source), resolved.path);
      const depth = this.frames.length;
      this.frames.push({
        chunk,
        instructionPointer: 0,
        stackBase: this.stack.length,
        environment,
        module,
      });
      this.executeUntil(depth);
    } catch (error) {
      this.modules.delete(name);
      if (parent !== undefined) parent.environment.cells.delete(name.slice(parentName.length + 1));
      throw error;
    }
    return module;
  }

  private addBuiltin(name: string, callback: NativeValue["callback"], acceptsKeywords = false): void {
    this.builtins!.set(name, makeNative(this.heap, name, callback, [], acceptsKeywords));
  }

  private readGlobal(name: string): Value {
    return this.load(this.globals!, name, "global");
  }

  private callNative(
    native: NativeValue,
    args: Value[],
    keywords: ReadonlyMap<string, Value> = new Map(),
  ): Value {
    if (keywords.size > 0 && !native.acceptsKeywords) {
      const first = keywords.keys().next().value as string | undefined;
      throw new ThmTypeError(`${native.name}() does not accept keyword arguments${first === undefined ? "" : ` ('${first}')`}`);
    }
    return native.callback(this, undefined, args, keywords);
  }

  private expandCallArguments(
    values: Value[],
    specs: CallArgumentSpec[],
  ): { args: Value[]; keywords: Map<string, Value> } {
    const args: Value[] = [];
    const keywords = new Map<string, Value>();
    for (let index = 0; index < specs.length; index++) {
      const spec = specs[index]!;
      const value = values[index]!;
      if (spec.kind === "positional") {
        args.push(value);
      } else if (spec.kind === "keyword") {
        if (spec.name === undefined) throw new RuntimeError("Keyword call argument has no name");
        if (keywords.has(spec.name)) throw new ThmTypeError(`got multiple values for keyword '${spec.name}'`);
        keywords.set(spec.name, value);
      } else if (spec.kind === "star") {
        args.push(...this.iterateAll(value));
      } else {
        if (!isKind(value, "dict")) throw new ThmTypeError("argument after ** must be a mapping");
        for (const entry of value.entries) {
          if (typeof entry.key !== "string") throw new ThmTypeError("keywords must be strings");
          if (keywords.has(entry.key)) throw new ThmTypeError(`got multiple values for keyword '${entry.key}'`);
          keywords.set(entry.key, entry.value);
        }
      }
    }
    return { args, keywords };
  }

  private rootKeywords(keywords: ReadonlyMap<string, Value>): void {
    for (const [, value] of keywords) this.temporaryRoots.push(value);
  }

  private callType(type: TypeValue, args: Value[], keywords: ReadonlyMap<string, Value> = new Map()): Value {
    if (this.isExceptionType(type.name)) {
      if (args.length > 1) throw new ThmTypeError(`${type.name}() expects zero or one argument`);
      return makeException(this.heap, type.name, args.length === 0 ? "" : this.stringify(args[0]!, false));
    }
    switch (type.name) {
      case "str":
        if (args.length > 1) throw new ThmTypeError("str() expects zero or one argument");
        return args.length === 0 ? "" : this.stringify(args[0]!, false);
      case "bool":
        if (args.length > 1) throw new ThmTypeError("bool() expects zero or one argument");
        return args.length === 0 ? false : this.truthy(args[0]!);
      case "int": {
        if (args.length > 2) throw new ThmTypeError("int() expects at most two arguments");
        if (args.length === 0) return BigInt(0);
        const source = args[0]!;
        if (args.length === 2) {
          if (typeof source !== "string") throw new ThmTypeError("int() can't convert non-string with explicit base");
          const base = this.integer(args[1]!, "int() base");
          if (base !== 0 && (base < 2 || base > 36)) throw new ThmValueError("int() base must be >= 2 and <= 36, or 0");
          return this.parseInteger(source, base);
        }
        if (typeof source === "bigint") return source;
        if (typeof source === "string") return this.parseInteger(source, 10);
        const number = this.number(source, "int");
        if (!Number.isFinite(number)) throw new ThmValueError(`cannot convert ${number} to integer`);
        return BigInt(Math.trunc(number));
      }
      case "float":
        if (args.length > 1) throw new ThmTypeError("float() expects zero or one argument");
        if (args.length === 1 && typeof args[0] === "string") return this.parseFloat(args[0]);
        return args.length === 0 ? 0 : this.number(args[0]!, "float");
      case "list":
      case "tuple":
      case "set": {
        if (args.length > 1) throw new ThmTypeError(`${type.name}() expects zero or one argument`);
        const items = args.length === 0 ? [] : this.iterateAll(args[0]!);
        if (type.name === "list") return makeList(this.heap, items);
        if (type.name === "tuple") return makeTuple(this.heap, items);
        const set = makeSet(this.heap);
        for (const item of items) this.setAdd(set, item);
        return set;
      }

      case "dict": {
        if (args.length > 1) throw new ThmTypeError("dict() expects zero or one positional argument");
        const result = makeDict(this.heap);
        if (args.length === 1) this.dictUpdateFrom(result, args[0]!);
        for (const [key, value] of keywords) this.dictSet(result, key, value);
        return result;
      }
      case "range": {
        if (args.length < 1 || args.length > 3) throw new ThmTypeError("range() expects one to three arguments");
        const start = args.length === 1 ? 0 : this.integer(args[0]!, "range argument");
        const stop = args.length === 1 ? this.integer(args[0]!, "range argument") : this.integer(args[1]!, "range argument");
        const step = args.length === 3 ? this.integer(args[2]!, "range step") : 1;
        if (step === 0) throw new ThmValueError("range() arg 3 must not be zero");
        return makeRange(this.heap, start, stop, step);
      }
      default:
        throw new ThmTypeError(`cannot construct ${type.name}`);
    }
  }

  private load(environment: Environment, name: string, mode: string): Value {
    if (mode === "global") return this.findBound(this.globalEnvironment(environment), name);
    if (mode === "local") return this.findCell(environment, name, true);
    if (mode === "nonlocal") return this.findEnclosing(environment.parent, name, true);
    let current = environment.parent;
    while (current !== null) {
      const cell = current.cells.get(name);
      if (cell !== undefined) {
        if (!cell.bound || cell.value === null) throw new ThmNameError(`cannot access '${name}' before assignment`);
        return cell.value;
      }
      current = current.parent;
    }
    throw new ThmNameError(`name '${name}' is not defined`);
  }

  private store(environment: Environment, name: string, mode: string, value: Value): void {
    if (mode === "global") {
      this.globalEnvironment(environment).set(name, value);
      return;
    }
    if (mode === "nonlocal") {
      const target = this.findEnclosingEnvironment(environment.parent, name);
      target.set(name, value);
      return;
    }
    environment.set(name, value);
  }

  private findBound(environment: Environment, name: string): Value {
    let current: Environment | null = environment;
    while (current !== null) {
      const cell = current.cells.get(name);
      if (cell !== undefined && cell.bound && cell.value !== null) return cell.value;
      current = current.parent;
    }
    throw new ThmNameError(`name '${name}' is not defined`);
  }

  private findCell(environment: Environment, name: string, allowUnbound: boolean): Value {
    const cell = environment.cells.get(name);
    if (cell === undefined || !cell.bound || cell.value === null) {
      if (allowUnbound && cell !== undefined) throw new ThmNameError(`cannot access '${name}' before assignment`);
      throw new ThmNameError(`name '${name}' is not defined`);
    }
    return cell.value;
  }

  private findEnclosing(environment: Environment | null, name: string, _allowUnbound: boolean): Value {
    const target = this.findEnclosingEnvironment(environment, name);
    return this.findCell(target, name, true);
  }

  private findEnclosingEnvironment(environment: Environment | null, name: string): Environment {
    let current = environment;
    while (current !== null && !current.isGlobal) {
      if (current.cells.has(name)) return current;
      current = current.parent;
    }
    throw new ThmNameError(`no binding for nonlocal '${name}' found`);
  }

  private globalEnvironment(environment: Environment): Environment {
    let current = environment;
    while (current.parent !== null && !current.isGlobal) current = current.parent;
    return current;
  }

  private unary(operator: string, value: Value): Value {
    const magic = operator === "+" ? "__pos__" : operator === "-" ? "__neg__" : operator === "~" ? "__invert__" : undefined;
    if (magic !== undefined && isKind(value, "instance")) {
      const method = this.lookupClassMemberWithOwner(value.klass, magic);
      if (method !== undefined) return this.invokeCallback(method.value, [value], method.owner);
    }
    if (operator === "not") return !this.truthy(value);
    if (operator === "+" && typeof value === "bigint") return value;
    if (operator === "+" && typeof value === "boolean") return value ? BigInt(1) : BigInt(0);
    if (operator === "+") return this.number(value, "unary +");
    if (operator === "-" && typeof value === "boolean") return value ? BigInt(-1) : BigInt(0);
    if (operator === "-") return typeof value === "bigint" ? -value : -this.number(value, "unary -");
    if (operator === "~") {
      const integer = this.exactInteger(value, "unary ~");
      return typeof value === "number" ? Number(~integer) : ~integer;
    }
    throw new ThmTypeError(`unsupported unary operator ${operator}`);
  }

  private binary(operator: string, left: Value, right: Value): Value {
    const magicNames: Record<string, [string, string]> = {
      "+": ["__add__", "__radd__"], "-": ["__sub__", "__rsub__"],
      "*": ["__mul__", "__rmul__"], "/": ["__truediv__", "__rtruediv__"],
      "//": ["__floordiv__", "__rfloordiv__"], "%": ["__mod__", "__rmod__"],
      "**": ["__pow__", "__rpow__"], "&": ["__and__", "__rand__"],
      "|": ["__or__", "__ror__"], "^": ["__xor__", "__rxor__"],
      "<<": ["__lshift__", "__rlshift__"], ">>": ["__rshift__", "__rrshift__"],
    };
    const magic = magicNames[operator];
    if (magic !== undefined) {
      if (isKind(left, "instance")) {
        const method = this.lookupClassMemberWithOwner(left.klass, magic[0]);
        if (method !== undefined) return this.invokeCallback(method.value, [left, right], method.owner);
      }
      if (isKind(right, "instance")) {
        const method = this.lookupClassMemberWithOwner(right.klass, magic[1]);
        if (method !== undefined) return this.invokeCallback(method.value, [right, left], method.owner);
      }
    }
    if (isKind(left, "set") && isKind(right, "set") && ["|", "&", "-", "^"].includes(operator)) {
      const result = makeSet(this.heap);
      const inRight = (item: Value): boolean => this.setHas(right, item);
      const inLeft = (item: Value): boolean => this.setHas(left, item);
      if (operator === "|") {
        for (const item of [...left.items, ...right.items]) this.setAdd(result, item);
      } else if (operator === "&") {
        for (const item of left.items) if (inRight(item)) this.setAdd(result, item);
      } else if (operator === "-") {
        for (const item of left.items) if (!inRight(item)) this.setAdd(result, item);
      } else {
        for (const item of left.items) if (!inRight(item)) this.setAdd(result, item);
        for (const item of right.items) if (!inLeft(item)) this.setAdd(result, item);
      }
      return result;
    }
    if (operator === "+") {
      if (typeof left === "string" && typeof right === "string") return (left as string) + (right as string);
      if ((isKind(left, "list") || isKind(left, "tuple")) && isKind(right, left.kind)) {
        return isKind(left, "list")
          ? makeList(this.heap, [...left.items, ...(right as ListValue).items])
          : makeTuple(this.heap, [...left.items, ...(right as TupleValue).items]);
      }
      if (this.isIntegral(left) && this.isIntegral(right)) {
        return this.exactInteger(left, "+") + this.exactInteger(right, "+");
      }
      return this.number(left, "+") + this.number(right, "+");
    }
    if (operator === "*") {
      const sequence = isKind(left, "list") || isKind(left, "tuple") ? left : isKind(right, "list") || isKind(right, "tuple") ? right : undefined;
      const countValue = sequence === left ? right : left;
      if (sequence !== undefined && this.isIntegral(countValue)) {
        const count = Math.max(0, this.integer(countValue, "sequence repeat count"));
        const items: Value[] = [];
        for (let index = 0; index < count; index++) items.push(...sequence.items);
        return isKind(sequence, "list") ? makeList(this.heap, items) : makeTuple(this.heap, items);
      }
      if (typeof left === "string" && (typeof right === "number" || typeof right === "bigint")) return left.repeat(Math.max(0, Math.trunc(Number(right))));
      if (typeof right === "string" && (typeof left === "number" || typeof left === "bigint")) return right.repeat(Math.max(0, Math.trunc(Number(left))));
      if (this.isIntegral(left) && this.isIntegral(right)) {
        return this.exactInteger(left, "*") * this.exactInteger(right, "*");
      }
      return this.number(left, "*") * this.number(right, "*");
    }
    if (this.isIntegral(left) && this.isIntegral(right)) {
      const a = this.exactInteger(left, operator);
      const b = this.exactInteger(right, operator);
      switch (operator) {
        case "-":
          return a - b;
        case "//":
          if (b === BigInt(0)) throw new ThmZeroDivisionError("integer division or modulo by zero");
          return this.floorDivide(a, b);
        case "%":
          if (b === BigInt(0)) throw new ThmZeroDivisionError("integer division or modulo by zero");
          return a - this.floorDivide(a, b) * b;
        case "**":
          if (a === BigInt(0) && b < BigInt(0)) throw new ThmZeroDivisionError("zero cannot be raised to a negative power");
          if (b < BigInt(0)) return Number(a) ** Number(b);
          if (b > BigInt(100000)) throw new ThmValueError("integer exponent is too large");
          return a ** b;
        case "&":
          return a & b;
        case "|":
          return a | b;
        case "^":
          return a ^ b;
        case "<<":
        case ">>":
          if (b < BigInt(0)) throw new ThmValueError("negative shift count");
          if (b > BigInt(100000)) throw new ThmValueError("shift count is too large");
          return operator === "<<" ? a << b : a >> b;
      }
    }
    const a = this.number(left, operator);
    const b = this.number(right, operator);
    switch (operator) {
      case "-":
        return a - b;
      case "/":
        if (b === 0) throw new ThmZeroDivisionError("division by zero");
        return a / b;
      case "//":
        if (b === 0) throw new ThmZeroDivisionError("integer division or modulo by zero");
        return Math.floor(a / b);
      case "%":
        if (b === 0) throw new ThmZeroDivisionError("integer division or modulo by zero");
        return a - Math.floor(a / b) * b;
      case "**":
        if (a === 0 && b < 0) throw new ThmZeroDivisionError("zero cannot be raised to a negative power");
        return a ** b;
      case "&":
        return Number(this.exactInteger(left, "&") & this.exactInteger(right, "&"));
      case "|":
        return Number(this.exactInteger(left, "|") | this.exactInteger(right, "|"));
      case "^":
        return Number(this.exactInteger(left, "^") ^ this.exactInteger(right, "^"));
      case "<<":
        return Number(this.exactInteger(left, "<<") << this.exactInteger(right, "<<"));
      case ">>":
        return Number(this.exactInteger(left, ">>") >> this.exactInteger(right, ">>"));
      default:
        throw new ThmTypeError(`unsupported binary operator ${operator}`);
    }
  }

  private compare(operator: string, left: Value, right: Value): boolean {
    const comparisonMagic: Record<string, string> = {
      "==": "__eq__", "!=": "__ne__", "<": "__lt__", "<=": "__le__", ">": "__gt__", ">=": "__ge__",
    };
    const magic = comparisonMagic[operator];
    if (magic !== undefined && isKind(left, "instance")) {
      const method = this.lookupClassMemberWithOwner(left.klass, magic);
      if (method !== undefined) return this.truthy(this.invokeCallback(method.value, [left, right], method.owner));
    }
    if (operator === "==" || operator === "!=") {
      const equal = this.equalValues(left, right);
      return operator === "==" ? equal : !equal;
    }
    if (operator === "is" || operator === "is not") {
      const same = left === right;
      return operator === "is" ? same : !same;
    }
    if (operator === "in" || operator === "not in") {
      const found = this.contains(right, left);
      return operator === "in" ? found : !found;
    }
    const order = this.compareOrder(left, right);
    switch (operator) {
      case "<":
        return order < 0;
      case "<=":
        return order <= 0;
      case ">":
        return order > 0;
      case ">=":
        return order >= 0;
      default:
        throw new ThmTypeError(`unsupported comparison ${operator}`);
    }
  }

  private compareOrder(left: Value, right: Value): number {
    if (this.isNumeric(left) && this.isNumeric(right)) {
      if (typeof left === "bigint" && typeof right === "number") return left < right ? -1 : left > right ? 1 : 0;
      if (typeof left === "number" && typeof right === "bigint") return left < right ? -1 : left > right ? 1 : 0;
      if (this.isIntegral(left) && this.isIntegral(right)) {
        const a = this.exactInteger(left, "comparison");
        const b = this.exactInteger(right, "comparison");
        return a < b ? -1 : a > b ? 1 : 0;
      }
      const a = this.number(left, "comparison");
      const b = this.number(right, "comparison");
      return a < b ? -1 : a > b ? 1 : 0;
    }
    if (typeof left === "string" && typeof right === "string") return left < right ? -1 : left > right ? 1 : 0;
    if ((isKind(left, "list") || isKind(left, "tuple")) && isKind(right, left.kind)) {
      const a = left.items;
      const b = right.items;
      for (let index = 0; index < Math.min(a.length, b.length); index++) {
        if (this.equalValues(a[index]!, b[index]!)) continue;
        return this.compareOrder(a[index]!, b[index]!);
      }
      return a.length < b.length ? -1 : a.length > b.length ? 1 : 0;
    }
    throw new ThmTypeError(`'${this.typeName(left)}' and '${this.typeName(right)}' are not orderable`);
  }

  private equalValues(left: Value, right: Value): boolean {
    if (this.isNumeric(left) && this.isNumeric(right)) {
      if (this.isIntegral(left) && this.isIntegral(right)) {
        return this.exactInteger(left, "comparison") === this.exactInteger(right, "comparison");
      }
      if ((typeof left === "bigint" || typeof right === "bigint") &&
        (typeof left === "number" || typeof right === "number")) {
        const integer = typeof left === "bigint" ? left : right as bigint;
        const floating = typeof left === "number" ? left : right as number;
        return Number.isInteger(floating) && BigInt(floating) === integer;
      }
      return this.number(left, "comparison") === this.number(right, "comparison");
    }
    if (isKind(left, "none") && isKind(right, "none")) return true;
    const pending: Array<[Value, Value]> = [[left, right]];
    const visited: Array<[object, object]> = [];
    while (pending.length > 0) {
      const pair = pending.pop();
      if (pair === undefined) break;
      const [a, b] = pair;
      if (this.isNumeric(a) && this.isNumeric(b)) {
        if (this.number(a, "comparison") !== this.number(b, "comparison")) return false;
        continue;
      }
      if (a === b) continue;
      if (
        typeof a !== "object" ||
        typeof b !== "object" ||
        a.kind !== b.kind
      ) return false;
      if (visited.some(([x, y]) => x === a && y === b)) continue;
      visited.push([a, b]);
      if (isKind(a, "list") || isKind(a, "tuple")) {
        if (!isKind(b, a.kind) || a.items.length !== b.items.length) return false;
        for (let index = 0; index < a.items.length; index++) pending.push([a.items[index]!, b.items[index]!]);
      } else if (isKind(a, "dict")) {
        if (!isKind(b, "dict") || a.entries.length !== b.entries.length) return false;
        for (const entry of a.entries) {
          const other = this.dictFind(b, entry.key);
          if (other === undefined) return false;
          pending.push([entry.value, other.value]);
        }
      } else if (isKind(a, "set")) {
        if (!isKind(b, "set") || a.items.length !== b.items.length) return false;
        for (const item of a.items) if (!this.setHas(b, item)) return false;
      } else if (isKind(a, "type")) {
        if (!isKind(b, "type") || a.name !== b.name) return false;
      } else {
        return false;
      }
    }
    return true;
  }

  private contains(container: Value, item: Value): boolean {
    if (typeof container === "string") {
      if (typeof item !== "string") throw new ThmTypeError("'in <string>' requires string as left operand");
      return container.includes(item);
    }
    if (isKind(container, "dict")) return this.dictFind(container, item) !== undefined;
    if (isKind(container, "set")) return this.setHas(container, item);
    const iterator = this.toIterator(container);
    while (true) {
      const next = this.next(iterator);
      if (next.done) return false;
      if (this.equalValues(next.value, item)) return true;
    }
  }

  private truthy(value: Value): boolean {
    if (isKind(value, "none") || value === false) return false;
    if (value === true) return true;
    if (typeof value === "number") return value !== 0 && !Number.isNaN(value);
    if (typeof value === "bigint") return value !== BigInt(0);
    if (typeof value === "string") return value.length > 0;
    if (isKind(value, "list") || isKind(value, "tuple")) return value.items.length > 0;
    if (isKind(value, "dict")) return value.entries.length > 0;
    if (isKind(value, "set")) return value.items.length > 0;
    if (isKind(value, "range")) return value.length > 0;
    return true;
  }

  private number(value: Value, operation: string): number {
    if (typeof value === "number") return value;
    if (typeof value === "bigint") return Number(value);
    if (typeof value === "boolean") return value ? 1 : 0;
    throw new ThmTypeError(`unsupported operand type for ${operation}: '${this.typeName(value)}'`);
  }

  private integer(value: Value, operation: string): number {
    const integer = this.exactInteger(value, operation);
    const number = Number(integer);
    if (!Number.isSafeInteger(number)) throw new ThmValueError(`${operation} is outside the supported index range`);
    return number;
  }

  private exactInteger(value: Value, operation: string): bigint {
    if (typeof value === "bigint") return value;
    if (typeof value === "boolean") return value ? BigInt(1) : BigInt(0);
    if (typeof value === "number" && Number.isInteger(value)) return BigInt(String(value));
    throw new ThmTypeError(`${operation} must be an integer`);
  }

  private isIntegral(value: Value): value is bigint | boolean {
    return typeof value === "bigint" || typeof value === "boolean";
  }

  private isNumeric(value: Value): value is bigint | number | boolean {
    return typeof value === "bigint" || typeof value === "number" || typeof value === "boolean";
  }

  private floorDivide(left: bigint, right: bigint): bigint {
    const quotient = left / right;
    const remainder = left % right;
    return remainder !== BigInt(0) && ((left < BigInt(0)) !== (right < BigInt(0)))
      ? quotient - BigInt(1)
      : quotient;
  }

  private getItem(receiver: Value, key: Value): Value {
    if (isKind(receiver, "function") && receiver.genericParameters.length > 0) return receiver;
    if (isKind(receiver, "class") && receiver.genericParameters.length > 0) return receiver;
    if (isKind(receiver, "dict")) {
      const entry = this.dictFind(receiver, key);
      if (entry === undefined) throw new ThmKeyError(this.stringify(key, true));
      return entry.value;
    }
    if (isKind(receiver, "list") || isKind(receiver, "tuple")) {
      const index = this.normalizeIndex(this.integer(key, "sequence index"), receiver.items.length);
      return receiver.items[index]!;
    }
    if (typeof receiver === "string") {
      const index = this.normalizeIndex(this.integer(key, "string index"), receiver.length);
      return receiver[index]!;
    }
    throw new ThmTypeError(`'${this.typeName(receiver)}' object is not subscriptable`);
  }

  private setItem(receiver: Value, key: Value, value: Value): void {
    if (isKind(receiver, "dict")) {
      this.dictSet(receiver, key, value);
      return;
    }
    if (isKind(receiver, "list")) {
      const index = this.normalizeIndex(this.integer(key, "list index"), receiver.items.length);
      receiver.items[index] = value;
      return;
    }
    throw new ThmTypeError(`'${this.typeName(receiver)}' object does not support item assignment`);
  }

  private deleteName(environment: Environment, name: string, mode: string): void {
    let target: Environment;
    if (mode === "global") target = this.globalEnvironment(environment);
    else if (mode === "nonlocal") target = this.findEnclosingEnvironment(environment.parent, name);
    else target = environment;
    const cell = target.cells.get(name);
    if (cell === undefined || !cell.bound) throw new ThmNameError(`name '${name}' is not defined`);
    cell.bound = false;
    cell.value = null;
  }

  private deleteItem(receiver: Value, key: Value): void {
    if (isKind(receiver, "dict")) {
      const index = this.dictFindIndex(receiver, key);
      if (index < 0) throw new ThmKeyError(this.stringify(key, true));
      receiver.entries.splice(index, 1);
      return;
    }
    if (isKind(receiver, "list")) {
      const index = this.normalizeIndex(this.integer(key, "list index"), receiver.items.length);
      receiver.items.splice(index, 1);
      return;
    }
    throw new ThmTypeError(`'${this.typeName(receiver)}' object doesn't support item deletion`);
  }

  private deleteSlice(receiver: Value, start: Value, stop: Value, stepValue: Value): void {
    if (!isKind(receiver, "list")) {
      throw new ThmTypeError(`'${this.typeName(receiver)}' object doesn't support slice deletion`);
    }
    const step = this.isNone(stepValue) ? 1 : this.integer(stepValue, "slice step");
    if (step === 0) throw new ThmValueError("slice step cannot be zero");
    const doomed = new Set(this.sliceIndices(receiver.items.length, start, stop, step));
    receiver.items = receiver.items.filter((_, index) => !doomed.has(index));
  }

  private setSlice(receiver: Value, start: Value, stop: Value, stepValue: Value, value: Value): void {
    if (!isKind(receiver, "list")) {
      throw new ThmTypeError(`'${this.typeName(receiver)}' object does not support slice assignment`);
    }
    const step = this.isNone(stepValue) ? 1 : this.integer(stepValue, "slice step");
    if (step === 0) throw new ThmValueError("slice step cannot be zero");
    const replacement = [...this.iterateAll(value)];
    const length = receiver.items.length;
    if (step === 1) {
      const from = this.isNone(start) ? 0 : this.normalizeSliceBound(this.integer(start, "slice index"), length, 0, length);
      let to = this.isNone(stop) ? length : this.normalizeSliceBound(this.integer(stop, "slice index"), length, 0, length);
      if (to < from) to = from;
      receiver.items.splice(from, to - from, ...replacement);
      return;
    }
    const indices = this.sliceIndices(length, start, stop, step);
    if (indices.length !== replacement.length) {
      throw new ThmValueError(
        `attempt to assign sequence of size ${replacement.length} to extended slice of size ${indices.length}`,
      );
    }
    indices.forEach((index, position) => {
      receiver.items[index] = replacement[position]!;
    });
  }

  private getSlice(receiver: Value, start: Value, stop: Value, stepValue: Value): Value {
    const step = this.isNone(stepValue) ? 1 : this.integer(stepValue, "slice step");
    if (step === 0) throw new ThmValueError("slice step cannot be zero");
    if (isKind(receiver, "list") || isKind(receiver, "tuple")) {
      const indices = this.sliceIndices(receiver.items.length, start, stop, step);
      const items = indices.map((index) => receiver.items[index]!);
      return isKind(receiver, "list") ? makeList(this.heap, items) : makeTuple(this.heap, items);
    }
    if (typeof receiver === "string") {
      const indices = this.sliceIndices(receiver.length, start, stop, step);
      return indices.map((index) => receiver[index]!).join("");
    }
    throw new ThmTypeError(`'${this.typeName(receiver)}' object is not sliceable`);
  }

  private isNone(value: Value): boolean {
    return value === null || isKind(value, "none");
  }

  private sliceIndices(length: number, startValue: Value, stopValue: Value, step: number): number[] {
    const result: number[] = [];
    let start: number;
    let stop: number;
    if (step > 0) {
      start = this.isNone(startValue) ? 0 : this.normalizeSliceBound(this.integer(startValue, "slice index"), length, 0, length);
      stop = this.isNone(stopValue) ? length : this.normalizeSliceBound(this.integer(stopValue, "slice index"), length, 0, length);
      for (let index = start; index < stop; index += step) result.push(index);
    } else {
      start = this.isNone(startValue)
        ? length - 1
        : this.normalizeSliceBound(this.integer(startValue, "slice index"), length, -1, length - 1);
      stop = this.isNone(stopValue)
        ? -1
        : this.normalizeSliceBound(this.integer(stopValue, "slice index"), length, -1, length - 1);
      for (let index = start; index > stop; index += step) result.push(index);
    }
    return result;
  }

  private normalizeSliceBound(value: number, length: number, min: number, max: number): number {
    const adjusted = value < 0 ? value + length : value;
    return Math.max(min, Math.min(max, adjusted));
  }

  private normalizeIndex(index: number, length: number): number {
    const adjusted = index < 0 ? index + length : index;
    if (adjusted < 0 || adjusted >= length) throw new ThmIndexError("sequence index out of range");
    return adjusted;
  }

  private getAttribute(receiver: Value, name: string): Value {
    if (isKind(receiver, "module")) {
      const cell = receiver.environment.cells.get(name);
      if (cell !== undefined && cell.bound && cell.value !== null) return cell.value;
      if (receiver.isPackage) {
        const childName = `${receiver.name}.${name}`;
        if (this.moduleResolver.resolveFile(childName) !== undefined) return this.importModule(childName, receiver);
      }
      throw new ThmAttributeError(`module '${receiver.name}' has no attribute '${name}'`);
    }
    if (isKind(receiver, "instance")) {
      if (name === "__class__") return receiver.klass;
      const found = this.lookupClassMemberWithOwner(receiver.klass, name);
      if (found !== undefined && this.isDataDescriptor(found.value)) {
        return this.getDescriptorValue(found.value, receiver, receiver.klass, found.owner);
      }
      if (receiver.fields.has(name)) return receiver.fields.get(name)!;
      if (found === undefined) throw new ThmAttributeError(`'${receiver.klass.name}' object has no attribute '${name}'`);
      const descriptorValue = this.getDescriptorValue(found.value, receiver, receiver.klass, found.owner);
      if (descriptorValue !== found.value) return descriptorValue;
      if (isKind(found.value, "function")) {
        const instance = receiver;
        const fn = found.value;
        const owner = found.owner;
        return makeNative(this.heap, `${owner.name}.${name}`, (vm, _boundReceiver, args, keywords) =>
          vm.invokeCallback(fn, [instance, ...args], owner, keywords), [instance, fn, owner], true);
      }
      return found.value;
    }
    if (isKind(receiver, "super")) {
      if (receiver.instance === null || receiver.startClass === null) throw new RuntimeError("Released super proxy");
      const found = this.lookupClassMemberWithOwner(receiver.startClass, name);
      if (found === undefined) throw new ThmAttributeError(`super object has no attribute '${name}'`);
      const ownerClass = isKind(receiver.instance, "instance") ? receiver.instance.klass : receiver.instance;
      const descriptorValue = this.getDescriptorValue(found.value, receiver.instance, ownerClass, found.owner);
      if (descriptorValue !== found.value) return descriptorValue;
      if (isKind(found.value, "function")) {
        const instance = receiver.instance;
        const fn = found.value;
        const owner = found.owner;
        return makeNative(this.heap, `super.${name}`, (vm, _boundReceiver, args, keywords) =>
          vm.invokeCallback(fn, [instance, ...args], owner, keywords), [instance, fn, owner], true);
      }
      return found.value;
    }
    if (isKind(receiver, "class")) {
      if (name === "__name__") return receiver.name;
      const metaclass = receiver.metaclass;
      let metaMember: { value: Value; owner: ClassValue } | undefined;
      if (metaclass !== null && metaclass.kind === "class") {
        metaMember = this.lookupClassMemberWithOwner(metaclass, name);
      }
      if (metaMember !== undefined && metaclass !== null && metaclass.kind === "class" && this.isDataDescriptor(metaMember.value)) {
        return this.getDescriptorValue(metaMember.value, receiver, metaclass!, metaMember.owner);
      }
      const member = this.lookupClassMemberWithOwner(receiver, name);
      if (member !== undefined) return this.getDescriptorValue(member.value, null, receiver, member.owner);
      if (metaMember !== undefined && metaclass !== null && metaclass.kind === "class") {
        const value = metaMember.value;
        if (isKind(value, "function")) {
          return makeNative(this.heap, `${receiver.name}.${name}`, (vm, _boundReceiver, args, keywords) =>
            vm.invokeCallback(value, [receiver, ...args], metaMember.owner, keywords), [receiver, value, metaMember.owner], true);
        }
        return this.getDescriptorValue(value, receiver, metaclass!, metaMember.owner);
      }
      throw new ThmAttributeError(`type object '${receiver.name}' has no attribute '${name}'`);
    }
if (isKind(receiver, "descriptor")) {
      if (receiver.descriptorKind === "property" && (name === "setter" || name === "deleter" || name === "getter")) {
        return makeNative(this.heap, `property.${name}`, (_vm, _boundReceiver, args) => {
          this.requireArgCount(`property.${name}`, args, 1);
          const setter = receiver.setter!;
          const deleter = receiver.deleter!;
          const value = receiver.value!;
          const replacement = name === "setter"
            ? makeDescriptor(this.heap, "property", value, args[0]!, deleter)
            : name === "deleter"
            ? makeDescriptor(this.heap, "property", value, setter, args[0]!)
            : makeDescriptor(this.heap, "property", args[0]!, setter, deleter);
          return replacement;
        }, [receiver]);
      }
      if (name === "__func__" && receiver.descriptorKind !== "property") return receiver.value!;
    }
    if (isKind(receiver, "native") && receiver.name === "type" && name === "__new__") {
      return makeNative(this.heap, "type.__new__", (vm, _boundReceiver, args) => vm.typeNew(args));
    }
    if (typeof receiver === "string") {
      const method = this.stringMethod(receiver, name);
      if (method !== undefined) return method;
    }
    if (isKind(receiver, "dict")) {
      const method = this.dictionaryMethod(receiver, name);
      if (method !== undefined) return method;
      const entry = this.dictFind(receiver, name);
      if (entry !== undefined) return entry.value;
      throw new ThmKeyError(name);
    }
    if (isKind(receiver, "list")) {
      const method = this.listMethod(receiver, name);
      if (method !== undefined) return method;
    }
    if (isKind(receiver, "set")) {
      const method = this.setMethod(receiver, name);
      if (method !== undefined) return method;
    }
    throw new ThmAttributeError(`'${this.typeName(receiver)}' object has no attribute '${name}'`);
  }

  private setAttribute(receiver: Value, name: string, value: Value): void {
    if (isKind(receiver, "instance")) {
      const found = this.lookupClassMemberWithOwner(receiver.klass, name);
      if (found !== undefined && this.isDataDescriptor(found.value)) {
        this.setDescriptorValue(found.value, receiver, value);
        return;
      }
      receiver.fields.set(name, value);
      return;
    }
    if (isKind(receiver, "class")) {
      const metaclass = receiver.metaclass;
      if (metaclass !== null && metaclass.kind === "class") {
        const found = this.lookupClassMemberWithOwner(metaclass, name);
        if (found !== undefined && this.isDataDescriptor(found.value)) {
          this.setDescriptorValue(found.value, receiver, value);
          return;
        }
      }
      receiver.environment.set(name, value);
      return;
    }
    if (isKind(receiver, "dict")) { this.dictSet(receiver, name, value); return; }
    throw new ThmTypeError(`'${this.typeName(receiver)}' object has no writable attribute '${name}'`);
  }

  private deleteAttribute(receiver: Value, name: string): void {
    if (isKind(receiver, "instance")) {
      const found = this.lookupClassMemberWithOwner(receiver.klass, name);
      if (found !== undefined && this.isDataDescriptor(found.value)) {
        this.deleteDescriptorValue(found.value, receiver);
        return;
      }
      if (!receiver.fields.delete(name)) {
        throw new ThmAttributeError(`'${receiver.klass.name}' object has no attribute '${name}'`);
      }
      return;
    }
    if (isKind(receiver, "class")) {
      const metaclass = receiver.metaclass;
      if (metaclass !== null && metaclass.kind === "class") {
        const found = this.lookupClassMemberWithOwner(metaclass, name);
        if (found !== undefined && this.isDataDescriptor(found.value)) {
          this.deleteDescriptorValue(found.value, receiver);
          return;
        }
      }
      if (!receiver.environment.cells.delete(name)) {
        throw new ThmAttributeError(`type object '${receiver.name}' has no attribute '${name}'`);
      }
      return;
    }
    throw new ThmTypeError(`'${this.typeName(receiver)}' object does not support attribute deletion`);
  }

  private isDataDescriptor(value: Value): boolean {
    if (isKind(value, "descriptor")) return value.descriptorKind === "property";
    return isKind(value, "instance") &&
      (this.lookupClassMemberWithOwner(value.klass, "__set__") !== undefined ||
        this.lookupClassMemberWithOwner(value.klass, "__delete__") !== undefined);
  }

  private getDescriptorValue(
    value: Value,
    instance: InstanceValue | ClassValue | null,
    owner: ClassValue,
    definingClass: ClassValue = owner,
  ): Value {
    if (isKind(value, "descriptor")) {
      if (value.descriptorKind === "staticmethod") return value.value!;
      if (value.descriptorKind === "classmethod") {
        return makeNative(this.heap, `${owner.name}.classmethod`, (vm, _receiver, args, keywords) =>
          vm.invokeCallback(value.value!, [owner, ...args], definingClass, keywords), [value, owner, definingClass], true);
      }
      if (instance === null) return value;
      if (value.value === null || isKind(value.value, "none")) throw new ThmTypeError(`unreadable property on '${owner.name}'`);
      return this.invokeCallback(value.value!, [instance as Value], definingClass);
    }
    if (isKind(value, "instance")) {
      const getMethod = this.lookupClassMemberWithOwner(value.klass, "__get__");
      if (getMethod !== undefined) return this.invokeDescriptorMethod(value, getMethod, [instance === null ? makeNone(this.heap) : instance, owner]);
    }
    return value;
  }

  private setDescriptorValue(value: Value, instance: InstanceValue | ClassValue, assigned: Value): void {
    if (isKind(value, "descriptor") && value.descriptorKind === "property") {
      if (value.setter === null || isKind(value.setter, "none")) throw new ThmTypeError("property has no setter");
      this.invokeCallback(value.setter, [instance, assigned]);
      return;
    }
    if (isKind(value, "instance")) {
      const setMethod = this.lookupClassMemberWithOwner(value.klass, "__set__");
      if (setMethod !== undefined) {
        this.invokeDescriptorMethod(value, setMethod, [instance, assigned]);
        return;
      }
    }
    throw new ThmTypeError("descriptor has no setter");
  }

  private deleteDescriptorValue(value: Value, instance: InstanceValue | ClassValue): void {
    if (isKind(value, "descriptor") && value.descriptorKind === "property") {
      if (value.deleter === null || isKind(value.deleter, "none")) throw new ThmTypeError("property has no deleter");
      this.invokeCallback(value.deleter, [instance]);
      return;
    }
    if (isKind(value, "instance")) {
      const deleteMethod = this.lookupClassMemberWithOwner(value.klass, "__delete__");
      if (deleteMethod !== undefined) {
        this.invokeDescriptorMethod(value, deleteMethod, [instance]);
        return;
      }
    }
    throw new ThmTypeError("descriptor has no deleter");
  }

  private invokeDescriptorMethod(
    descriptor: InstanceValue,
    method: { value: Value; owner: ClassValue },
    args: Value[],
  ): Value {
    return this.invokeCallback(method.value, [descriptor, ...args], method.owner);
  }

  private lookupClassMember(klass: ClassValue, name: string): Value | undefined {
    return this.lookupClassMemberWithOwner(klass, name)?.value;
  }

  private lookupClassMemberWithOwner(klass: ClassValue, name: string): { value: Value; owner: ClassValue } | undefined {
    for (const owner of klass.mro) {
      const cell = owner.environment.cells.get(name);
      if (cell?.bound && cell.value !== null) return { value: cell.value, owner };
    }
    return undefined;
  }

  private instantiateClass(
    klass: ClassValue,
    args: Value[],
    keywords: ReadonlyMap<string, Value> = new Map(),
  ): InstanceValue {
    const instance = makeInstance(this.heap, klass);
    const initializer = this.lookupClassMemberWithOwner(klass, "__init__");
    if (initializer === undefined) {
      if (args.length !== 0 || keywords.size !== 0) throw new ThmTypeError(`${klass.name}() takes no arguments`);
      return instance;
    }
    if (!isKind(initializer.value, "function")) throw new ThmTypeError(`${klass.name}.__init__ must be a function`);
    const result = this.invokeCallback(initializer.value, [instance, ...args], initializer.owner, keywords);
    if (!isKind(result, "none")) throw new ThmTypeError(`__init__() should return None, not '${this.typeName(result)}'`);
    return instance;
  }

  private callClass(
    klass: ClassValue,
    args: Value[],
    keywords: ReadonlyMap<string, Value> = new Map(),
  ): Value {
    const metaclass = klass.metaclass;
    if (metaclass !== null && metaclass.kind === "class") {
      const callMethod = this.lookupClassMemberWithOwner(metaclass, "__call__");
      if (callMethod !== undefined) {
        const callback = isKind(callMethod.value, "descriptor") ? callMethod.value.value! : callMethod.value;
        return this.invokeCallback(callback, [klass, ...args], callMethod.owner, keywords);
      }
    }
    return this.instantiateClass(klass, args, keywords);
  }

  private createClass(
    name: string,
    bodyEnvironment: Environment,
    bases: ClassValue[],
    metaclass: ClassValue | TypeValue,
    isMetaclass: boolean,
    genericParameters: string[],
  ): Value {
    const namespace = makeDict(this.heap);
    for (const [memberName, cell] of bodyEnvironment.cells) {
      if (cell.bound && cell.value !== null) this.dictSet(namespace, memberName, cell.value);
    }
    if (!isKind(metaclass, "class")) {
      return makeClass(this.heap, name, bodyEnvironment, bases, metaclass, isMetaclass, genericParameters);
    }

    const newMethod = this.lookupClassMemberWithOwner(metaclass, "__new__");
    let created: Value;
    if (newMethod === undefined) {
      created = makeClass(this.heap, name, bodyEnvironment, bases, metaclass, isMetaclass, genericParameters);
    } else {
      const callback = isKind(newMethod.value, "descriptor") ? newMethod.value.value! : newMethod.value;
      if (!isKind(callback, "function") && !isKind(callback, "native")) {
        throw new ThmTypeError("metaclass __new__ must be callable");
      }
      created = this.invokeCallback(
        callback,
        [metaclass, name, makeTuple(this.heap, bases), namespace],
        newMethod.owner,
      );
    }
    if (isKind(created, "class")) {
      const initMethod = this.lookupClassMemberWithOwner(metaclass, "__init__");
      if (initMethod !== undefined) {
        const callback = isKind(initMethod.value, "descriptor") ? initMethod.value.value! : initMethod.value;
        if (!isKind(callback, "function") && !isKind(callback, "native")) {
          throw new ThmTypeError("metaclass __init__ must be callable");
        }
        const result = this.invokeCallback(
          callback,
          [created, name, makeTuple(this.heap, bases), namespace],
          initMethod.owner,
        );
        if (!isKind(result, "none")) throw new ThmTypeError("metaclass __init__() should return None");
      }
    }
    return created;
  }

  private typeNew(args: Value[]): Value {
    this.requireArgCount("type.__new__", args, 4);
    const [metaclass, rawName, rawBases, namespace] = args;
    if (
      (!isKind(metaclass!, "type") || metaclass!.name !== "type") &&
      (!isKind(metaclass!, "class") || !metaclass!.isMetaclass)
    ) {
      throw new ThmTypeError("type.__new__() argument 1 must be a metaclass");
    }
    if (typeof rawName !== "string") throw new ThmTypeError("type.__new__() name must be a string");
    if (!isKind(rawBases!, "tuple") || !isKind(namespace!, "dict")) {
      throw new ThmTypeError("type.__new__() bases and namespace must be a tuple and dict");
    }
    const bases: ClassValue[] = [];
    let isMetaclass = false;
    for (const base of rawBases!.items) {
      if ((isKind(base, "type") && base.name === "type") || (isKind(base, "native") && base.name === "type")) {
        isMetaclass = true;
      } else if (isKind(base, "class")) {
        bases.push(base);
        isMetaclass ||= base.isMetaclass;
      } else {
        throw new ThmTypeError("type.__new__() bases must be classes");
      }
    }
    const environment = Environment.create(this.heap, this.builtins, false);
    for (const entry of namespace!.entries) {
      if (typeof entry.key !== "string") throw new ThmTypeError("type.__new__() namespace keys must be strings");
      environment.set(entry.key, entry.value);
    }
    return makeClass(this.heap, rawName, environment, bases, metaclass!, isMetaclass);
  }

  private stringMethod(receiver: string, name: string): NativeValue | undefined {
    const method = (callback: (args: Value[]) => Value): NativeValue =>
      makeNative(this.heap, `str.${name}`, (_vm, _receiver, args) => callback(args), [receiver]);
    const text = (value: Value | undefined, label: string): string => {
      if (typeof value !== "string") {
        const typeStr = value === undefined ? "undefined" : this.typeName(value);
        throw new ThmTypeError(`str.${name}() ${label} must be a string, not '${typeStr}'`);
      }
      return value;
    };
    const maxArgs = (args: Value[], low: number, high: number): void => {
      if (args.length < low || args.length > high) {
        throw new ThmTypeError(
          `str.${name}() expects ${low === high ? `exactly ${low}` : `${low} to ${high}`} argument(s)`,
        );
      }
    };
    const WHITESPACE = " \t\n\r\v\f\u001c\u001d\u001e\u001f\u0085\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000";
    const isSpace = (char: string): boolean => WHITESPACE.includes(char);
    const stripWith = (value: string, chars: string | null, left: boolean, right: boolean): string => {
      const strip = (char: string): boolean => (chars === null ? isSpace(char) : chars.includes(char));
      const characters = Array.from(value);
      let start = 0;
      let end = characters.length;
      if (left) while (start < end && strip(characters[start]!)) start++;
      if (right) while (end > start && strip(characters[end - 1]!)) end--;
      return characters.slice(start, end).join("");
    };
    const resolveRange = (args: Value[], from: number): { start: number; end: number } => {
      const length = receiver.length;
      let start = args.length > from && args[from] !== null ? this.integer(args[from]!, `str.${name}() start`) : 0;
      let end = args.length > from + 1 && args[from + 1] !== null ? this.integer(args[from + 1]!, `str.${name}() end`) : length;
      if (start < 0) start = Math.max(length + start, 0);
      if (end < 0) end = Math.max(length + end, 0);
      return { start, end: Math.min(end, length) };
    };
    const allChars = (predicate: (char: string) => boolean): boolean =>
      receiver.length > 0 && Array.from(receiver).every(predicate);
    const isUpperChar = (char: string): boolean => char !== char.toLowerCase() && char === char.toUpperCase();
    const isLowerChar = (char: string): boolean => char !== char.toUpperCase() && char === char.toLowerCase();
    const isCased = (char: string): boolean => char.toLowerCase() !== char.toUpperCase();
    const isDigitChar = (char: string): boolean => /^\p{Nd}$/u.test(char);
    const isAlphaChar = (char: string): boolean => /^\p{L}$/u.test(char);
    const isNumericChar = (char: string): boolean => /^\p{N}$/u.test(char);

    switch (name) {
      case "upper":
      case "lower":
      case "casefold":
      case "capitalize":
      case "title":
      case "swapcase":
        return method((args) => {
          this.requireArgCount(name, args, 0);
          if (name === "upper") return receiver.toUpperCase();
          if (name === "lower" || name === "casefold") return receiver.toLowerCase();
          if (name === "capitalize") {
            const chars = Array.from(receiver);
            return chars.length === 0 ? "" : chars[0]!.toUpperCase() + chars.slice(1).join("").toLowerCase();
          }
          if (name === "swapcase") {
            return Array.from(receiver)
              .map((char) => (isUpperChar(char) ? char.toLowerCase() : isLowerChar(char) ? char.toUpperCase() : char))
              .join("");
          }
          let result = "";
          let previousCased = false;
          for (const char of Array.from(receiver)) {
            if (isCased(char)) {
              result += previousCased ? char.toLowerCase() : char.toUpperCase();
              previousCased = true;
            } else {
              result += char;
              previousCased = false;
            }
          }
          return result;
        });
      case "strip":
      case "lstrip":
      case "rstrip":
        return method((args) => {
          maxArgs(args, 0, 1);
          const chars = args.length === 0 || args[0] === null ? null : text(args[0], "argument");
          return stripWith(receiver, chars, name !== "rstrip", name !== "lstrip");
        });
      case "split":
      case "rsplit":
        return method((args) => {
          maxArgs(args, 0, 2);
          const separator = args.length === 0 || args[0] === null ? null : text(args[0], "separator");
          const limit = args.length === 2 ? this.integer(args[1]!, "str.split() maxsplit") : -1;
          if (separator === "") throw new ThmValueError("empty separator");
          let parts: string[];
          if (separator === null) {
            const words: string[] = [];
            let current = "";
            for (const char of Array.from(receiver)) {
              if (isSpace(char)) {
                if (current !== "") words.push(current);
                current = "";
              } else current += char;
            }
            if (current !== "") words.push(current);
            if (limit < 0 || words.length <= limit + 1) parts = words;
            else if (name === "split") {
              // Re-split manually to keep the remainder intact.
              parts = [];
              let rest = stripWith(receiver, null, true, false);
              while (parts.length < limit && rest.length > 0) {
                let end = 0;
                const chars = Array.from(rest);
                while (end < chars.length && !isSpace(chars[end]!)) end++;
                parts.push(chars.slice(0, end).join(""));
                rest = stripWith(chars.slice(end).join(""), null, true, false);
              }
              if (rest.length > 0) parts.push(rest);
            } else {
              parts = [];
              let rest = stripWith(receiver, null, false, true);
              while (parts.length < limit && rest.length > 0) {
                const chars = Array.from(rest);
                let start = chars.length;
                while (start > 0 && !isSpace(chars[start - 1]!)) start--;
                parts.unshift(chars.slice(start).join(""));
                rest = stripWith(chars.slice(0, start).join(""), null, false, true);
              }
              if (rest.length > 0) parts.unshift(rest);
            }
          } else if (limit < 0) {
            parts = receiver.split(separator);
          } else if (name === "split") {
            parts = [];
            let rest = receiver;
            while (parts.length < limit) {
              const index = rest.indexOf(separator);
              if (index < 0) break;
              parts.push(rest.slice(0, index));
              rest = rest.slice(index + separator.length);
            }
            parts.push(rest);
          } else {
            parts = [];
            let rest = receiver;
            while (parts.length < limit) {
              const index = rest.lastIndexOf(separator);
              if (index < 0) break;
              parts.unshift(rest.slice(index + separator.length));
              rest = rest.slice(0, index);
            }
            parts.unshift(rest);
          }
          return makeList(this.heap, parts);
        });
      case "splitlines":
        return method((args) => {
          maxArgs(args, 0, 1);
          const keepEnds = args.length === 1 && this.truthy(args[0]!);
          const lines: string[] = [];
          const pattern = /\r\n|[\n\r\v\f\u001c\u001d\u001e\u0085\u2028\u2029]/g;
          let last = 0;
          let match: RegExpExecArray | null;
          while ((match = pattern.exec(receiver)) !== null) {
            lines.push(receiver.slice(last, keepEnds ? match.index + match[0].length : match.index));
            last = match.index + match[0].length;
          }
          if (last < receiver.length) lines.push(receiver.slice(last));
          return makeList(this.heap, lines);
        });
      case "join":
        return method((args) => {
          this.requireArgCount(name, args, 1);
          const pieces = this.iterateAll(args[0]!);
          const strings = pieces.map((piece, index) => {
            if (typeof piece !== "string") {
              throw new ThmTypeError(`sequence item ${index}: expected str instance, ${this.typeName(piece)} found`);
            }
            return piece;
          });
          return strings.join(receiver);
        });
      case "replace":
        return method((args) => {
          maxArgs(args, 2, 3);
          const oldText = text(args[0], "old");
          const newText = text(args[1], "new");
          const count = args.length === 3 ? this.integer(args[2]!, "str.replace() count") : -1;
          if (count < 0) {
            if (oldText === "") return Array.from(receiver).reduce((out, char) => out + newText + char, "") + newText;
            return receiver.split(oldText).join(newText);
          }
          let result = "";
          let rest = receiver;
          let done = 0;
          if (oldText === "") {
            const chars = Array.from(receiver);
            for (let i = 0; i <= chars.length; i++) {
              if (done < count) { result += newText; done++; }
              if (i < chars.length) result += chars[i];
            }
            return result;
          }
          while (done < count) {
            const index = rest.indexOf(oldText);
            if (index < 0) break;
            result += rest.slice(0, index) + newText;
            rest = rest.slice(index + oldText.length);
            done++;
          }
          return result + rest;
        });
      case "find":
      case "rfind":
      case "index":
      case "rindex":
        return method((args) => {
          maxArgs(args, 1, 3);
          const needle = text(args[0], "argument");
          const { start, end } = resolveRange(args, 1);
          const slice = receiver.slice(start, end);
          const found = name === "find" || name === "index" ? slice.indexOf(needle) : slice.lastIndexOf(needle);
          if (found < 0) {
            if (name === "index" || name === "rindex") throw new ThmValueError("substring not found");
            return -1;
          }
          return found + start;
        });
      case "count":
        return method((args) => {
          maxArgs(args, 1, 3);
          const needle = text(args[0], "argument");
          const { start, end } = resolveRange(args, 1);
          const slice = receiver.slice(start, end);
          if (needle === "") return slice.length + 1;
          return slice.split(needle).length - 1;
        });
      case "startswith":
      case "endswith":
        return method((args) => {
          maxArgs(args, 1, 3);
          const { start, end } = resolveRange(args, 1);
          const slice = receiver.slice(start, end);
          const candidates = isKind(args[0]!, "tuple") ? args[0]!.items : [args[0]!];
          return candidates.some((candidate) => {
            const value = text(candidate, "prefix/suffix");
            return name === "startswith" ? slice.startsWith(value) : slice.endsWith(value);
          });
        });
      case "removeprefix":
      case "removesuffix":
        return method((args) => {
          this.requireArgCount(name, args, 1);
          const value = text(args[0], "argument");
          if (name === "removeprefix") return value !== "" && receiver.startsWith(value) ? receiver.slice(value.length) : receiver;
          return value !== "" && receiver.endsWith(value) ? receiver.slice(0, receiver.length - value.length) : receiver;
        });
      case "isdigit":
      case "isdecimal":
        return method((args) => { this.requireArgCount(name, args, 0); return allChars(isDigitChar); });
      case "isnumeric":
        return method((args) => { this.requireArgCount(name, args, 0); return allChars(isNumericChar); });
      case "isalpha":
        return method((args) => { this.requireArgCount(name, args, 0); return allChars(isAlphaChar); });
      case "isalnum":
        return method((args) => { this.requireArgCount(name, args, 0); return allChars((c) => isAlphaChar(c) || isNumericChar(c)); });
      case "isspace":
        return method((args) => { this.requireArgCount(name, args, 0); return allChars(isSpace); });
      case "isupper":
        return method((args) => {
          this.requireArgCount(name, args, 0);
          const chars = Array.from(receiver);
          return chars.some(isCased) && !chars.some(isLowerChar);
        });
      case "islower":
        return method((args) => {
          this.requireArgCount(name, args, 0);
          const chars = Array.from(receiver);
          return chars.some(isCased) && !chars.some(isUpperChar);
        });
      case "isidentifier":
        return method((args) => { this.requireArgCount(name, args, 0); return /^[\p{L}_][\p{L}\p{N}_]*$/u.test(receiver); });
      case "isprintable":
        return method((args) => { this.requireArgCount(name, args, 0); return !/[\p{C}\p{Zl}\p{Zp}]/u.test(receiver); });
      case "istitle":
        return method((args) => {
          this.requireArgCount(name, args, 0);
          let previousCased = false;
          let seenCased = false;
          for (const char of Array.from(receiver)) {
            if (isUpperChar(char)) { if (previousCased) return false; previousCased = true; seenCased = true; }
            else if (isLowerChar(char)) { if (!previousCased) return false; previousCased = true; seenCased = true; }
            else previousCased = false;
          }
          return seenCased;
        });
      case "zfill":
        return method((args) => {
          this.requireArgCount(name, args, 1);
          const width = this.integer(args[0]!, "str.zfill() width");
          const length = Array.from(receiver).length;
          if (width <= length) return receiver;
          const sign = receiver.startsWith("+") || receiver.startsWith("-") ? receiver[0]! : "";
          return sign + "0".repeat(width - length) + receiver.slice(sign.length);
        });
      case "center":
      case "ljust":
      case "rjust":
        return method((args) => {
          maxArgs(args, 1, 2);
          const width = this.integer(args[0]!, `str.${name}() width`);
          const fill = args.length === 2 ? text(args[1], "fill character") : " ";
          if (Array.from(fill).length !== 1) throw new ThmTypeError(`str.${name}() fill character must be exactly one character`);
          const padding = width - Array.from(receiver).length;
          if (padding <= 0) return receiver;
          if (name === "ljust") return receiver + fill.repeat(padding);
          if (name === "rjust") return fill.repeat(padding) + receiver;
          const left = Math.floor(padding / 2) + (padding % 2 === 1 && width % 2 === 1 ? 1 : 0);
          return fill.repeat(left) + receiver + fill.repeat(padding - left);
        });
      case "partition":
      case "rpartition":
        return method((args) => {
          this.requireArgCount(name, args, 1);
          const separator = text(args[0], "separator");
          if (separator === "") throw new ThmValueError("empty separator");
          const index = name === "partition" ? receiver.indexOf(separator) : receiver.lastIndexOf(separator);
          if (index < 0) {
            return makeTuple(this.heap, name === "partition" ? [receiver, "", ""] : ["", "", receiver]);
          }
          return makeTuple(this.heap, [receiver.slice(0, index), separator, receiver.slice(index + separator.length)]);
        });
      case "expandtabs":
        return method((args) => {
          maxArgs(args, 0, 1);
          const size = args.length === 1 ? this.integer(args[0]!, "str.expandtabs() tabsize") : 8;
          let column = 0;
          let result = "";
          for (const char of Array.from(receiver)) {
            if (char === "\t") {
              const spaces = size > 0 ? size - (column % size) : 0;
              result += " ".repeat(spaces);
              column += spaces;
            } else {
              result += char;
              column = char === "\n" || char === "\r" ? 0 : column + 1;
            }
          }
          return result;
        });
      case "format":
        return method((args) => {
          let next = 0;
          return receiver.replace(/\{\{|\}\}|\{(\d*)\}/g, (match, index: string | undefined) => {
            if (match === "{{") return "{";
            if (match === "}}") return "}";
            const position = index === undefined || index === "" ? next++ : Number(index);
            if (position >= args.length) throw new ThmIndexError("Replacement index out of range for str.format()");
            return this.stringify(args[position]!, false);
          });
        });
      default:
        return undefined;
    }
  }

  private dictionaryMethod(receiver: DictValue, name: string): NativeValue | undefined {
    const method = (callback: (args: Value[]) => Value): NativeValue =>
      makeNative(this.heap, `dict.${name}`, (_vm: VM, _receiver: Value | undefined, args: Value[]): Value => callback(args), [receiver]);
    switch (name) {
      case "keys":
        return method((args) => {
          this.requireArgCount(name, args, 0);
          return makeList(this.heap, receiver.entries.map((entry) => entry.key));
        });
      case "values":
        return method((args) => {
          this.requireArgCount(name, args, 0);
          return makeList(this.heap, receiver.entries.map((entry) => entry.value));
        });
      case "items":
        return method((args) => {
          this.requireArgCount(name, args, 0);
          return makeList(this.heap, receiver.entries.map((entry) => makeTuple(this.heap, [entry.key, entry.value])));
        });
      case "get":
        return method((args): Value => {
          if (args.length < 1 || args.length > 2) throw new ThmTypeError("dict.get() expects one or two arguments");
          const found = this.dictFind(receiver, args[0]!);
          return found !== undefined ? found.value : (args[1] ?? makeNone(this.heap));
        });
      case "pop":
        return method((args) => {
          if (args.length < 1 || args.length > 2) throw new ThmTypeError("dict.pop() expects one or two arguments");
          const index = this.dictFindIndex(receiver, args[0]!);
          if (index < 0) {
            if (args.length === 2) return args[1]!;
            throw new ThmKeyError(this.stringify(args[0]!, true));
          }
          return receiver.entries.splice(index, 1)[0]!.value;
        });
      case "update":
        return makeNative(this.heap, "dict.update", (_vm, _receiver, args, keywords) => {
          if (args.length > 1) throw new ThmTypeError("dict.update() expects at most one positional argument");
          if (args.length === 1) this.dictUpdateFrom(receiver, args[0]!);
          for (const [key, value] of keywords ?? new Map<string, Value>()) this.dictSet(receiver, key, value);
          return makeNone(this.heap);
        }, [receiver], true);
      case "__contains__":
        return method((args) => {
          this.requireArgCount(name, args, 1);
          return this.dictFind(receiver, args[0]!) !== undefined;
        });
      case "clear":
        return method((args) => {
          this.requireArgCount(name, args, 0);
          receiver.entries.length = 0;
          return makeNone(this.heap);
        });
      case "copy":
        return method((args) => {
          this.requireArgCount(name, args, 0);
          return makeDict(this.heap, receiver.entries.map((entry) => ({ ...entry })));
        });
      case "setdefault":
        return method((args) => {
          if (args.length < 1 || args.length > 2) throw new ThmTypeError("dict.setdefault() expects one or two arguments");
          const existing = this.dictFind(receiver, args[0]!);
          if (existing !== undefined) return existing.value;
          const value = args[1] ?? makeNone(this.heap);
          this.dictSet(receiver, args[0]!, value);
          return value;
        });
      case "popitem":
        return method((args) => {
          this.requireArgCount(name, args, 0);
          if (receiver.entries.length === 0) throw new ThmKeyError("dictionary is empty");
          const entry = receiver.entries.pop()!;
          return makeTuple(this.heap, [entry.key, entry.value]);
        });
      case "fromkeys":
        return method((args) => {
          if (args.length < 1 || args.length > 2) throw new ThmTypeError("dict.fromkeys() expects one or two arguments");
          const result = makeDict(this.heap);
          const defaultVal = args[1] ?? makeNone(this.heap);
          for (const key of this.iterateAll(args[0]!)) {
            if (typeof key !== "string" && typeof key !== "number" && typeof key !== "bigint" && typeof key !== "boolean" && !isKind(key, "none")) {
              throw new ThmTypeError("dictionary keys must be hashable");
            }
            this.dictSet(result, key, defaultVal);
          }
          return result;
        });
      default:
        return undefined;
    }
  }

  private listMethod(receiver: ListValue, name: string): NativeValue | undefined {
    const method = (callback: (args: Value[]) => Value): NativeValue =>
      makeNative(this.heap, `list.${name}`, (_vm, _receiver, args) => callback(args), [receiver]);
    switch (name) {
      case "append":
        return method((args) => {
          this.requireArgCount(name, args, 1);
          receiver.items.push(args[0]!);
          return makeNone(this.heap);
        });
      case "insert":
        return method((args) => {
          this.requireArgCount(name, args, 2);
          const rawIndex = this.integer(args[0]!, "list.insert index");
          const index = rawIndex < 0 ? Math.max(receiver.items.length + rawIndex, 0) : Math.min(rawIndex, receiver.items.length);
          receiver.items.splice(index, 0, args[1]!);
          return makeNone(this.heap);
        });
      case "pop":
        return method((args) => {
          if (args.length > 1) throw new ThmTypeError("list.pop() expects zero or one argument");
          if (receiver.items.length === 0) throw new ThmIndexError("pop from empty list");
          const raw = args.length === 0 ? receiver.items.length - 1 : this.integer(args[0]!, "list.pop index");
          const index = this.normalizeIndex(raw, receiver.items.length);
          return receiver.items.splice(index, 1)[0]!;
        });
      case "remove":
        return method((args) => {
          this.requireArgCount(name, args, 1);
          const index = receiver.items.findIndex((item) => this.equalValues(item, args[0]!));
          if (index < 0) throw new ThmValueError("list.remove(x): x not in list");
          receiver.items.splice(index, 1);
          return makeNone(this.heap);
        });
      case "extend":
        return method((args) => {
          for (const arg of args) for (const item of this.iterateAll(arg)) receiver.items.push(item);
          return makeNone(this.heap);
        });
      case "index":
        return method((args) => {
          if (args.length < 1 || args.length > 2) throw new ThmTypeError("list.index() expects one or two arguments");
          const start = args.length === 2 ? this.integer(args[1]!, "list.index start") : 0;
          const adjustedStart = start < 0 ? Math.max(receiver.items.length + start, 0) : start;
          for (let i = adjustedStart; i < receiver.items.length; i++) {
            if (this.equalValues(receiver.items[i]!, args[0]!)) return i;
          }
          throw new ThmValueError("list.index(x): x not in list");
        });
      case "count":
        return method((args) => {
          this.requireArgCount(name, args, 1);
          let total = 0;
          for (const item of receiver.items) if (this.equalValues(item, args[0]!)) total++;
          return total;
        });
      case "clear":
        return method((args) => {
          this.requireArgCount(name, args, 0);
          receiver.items.length = 0;
          return makeNone(this.heap);
        });
      case "copy":
        return method((args) => {
          this.requireArgCount(name, args, 0);
          return makeList(this.heap, [...receiver.items]);
        });
      case "reverse":
        return method((args) => {
          this.requireArgCount(name, args, 0);
          receiver.items.reverse();
          return makeNone(this.heap);
        });
      case "sort":
        return makeNative(this.heap, "list.sort", (_vm, _receiver, args, keywords) => {
          this.requireArgCount("list.sort", args, 0);
          const { key, reverse } = this.sortKeywords("list.sort", keywords);
          this.sortValues(receiver.items, key, reverse);
          return makeNone(this.heap);
        }, [receiver], true);
      default:
        return undefined;
    }
  }

  private setMethod(receiver: SetValue, name: string): NativeValue | undefined {
    const method = (callback: (args: Value[]) => Value): NativeValue =>
      makeNative(this.heap, `set.${name}`, (_vm, _receiver, args) => callback(args), [receiver]);
    if (name === "add") {
      return method((args) => {
        this.requireArgCount(name, args, 1);
        this.setAdd(receiver, args[0]!);
        return makeNone(this.heap);
      });
    }
    if (name === "remove") {
      return method((args) => {
        this.requireArgCount(name, args, 1);
        if (!this.setHas(receiver, args[0]!)) throw new ThmKeyError(this.stringify(args[0]!, true));
        receiver.items = receiver.items.filter((item) => !this.equalValues(item, args[0]!));
        return makeNone(this.heap);
      });
    }
    if (name === "discard") {
      return method((args) => {
        this.requireArgCount(name, args, 1);
        receiver.items = receiver.items.filter((item) => !this.equalValues(item, args[0]!));
        return makeNone(this.heap);
      });
    }
    if (name === "difference") {
      return method((args) => {
        this.requireArgCount(name, args, 1);
        const values = this.iterateAll(args[0]!);
        const result = makeSet(this.heap);
        for (const item of receiver.items) if (!values.some((value) => this.equalValues(item, value))) this.setAdd(result, item);
        return result;
      });
    }
    if (name === "symmetric_difference") {
      return method((args) => {
        this.requireArgCount(name, args, 1);
        const values = this.iterateAll(args[0]!);
        const result = makeSet(this.heap);
        for (const item of receiver.items) if (!values.some((value) => this.equalValues(item, value))) this.setAdd(result, item);
        for (const item of values) if (!this.setHas(receiver, item)) this.setAdd(result, item);
        return result;
      });
    }
    if (name === "update") {
      return method((args) => {
        for (const arg of args) for (const item of this.iterateAll(arg)) this.setAdd(receiver, item);
        return makeNone(this.heap);
      });
    }
    if (name === "clear") {
      return method((args) => {
        this.requireArgCount(name, args, 0);
        receiver.items.length = 0;
        return makeNone(this.heap);
      });
    }
    if (name === "copy") {
      return method((args) => {
        this.requireArgCount(name, args, 0);
        const copy = makeSet(this.heap);
        for (const item of receiver.items) this.setAdd(copy, item);
        return copy;
      });
    }
    if (name === "pop") {
      return method((args) => {
        this.requireArgCount(name, args, 0);
        if (receiver.items.length === 0) throw new ThmKeyError("pop from an empty set");
        const value = receiver.items.pop()!;
        return value;
      });
    }
    if (name === "union" || name === "intersection") {
      return method((args) => {
        const result = makeSet(this.heap);
        for (const item of receiver.items) this.setAdd(result, item);
        for (const arg of args) {
          const values = this.iterateAll(arg);
          if (name === "union") {
            for (const item of values) this.setAdd(result, item);
          } else {
            result.items = result.items.filter((item) => values.some((value) => this.equalValues(item, value)));
          }
        }
        return result;
      });
    }
    if (name === "issubset" || name === "issuperset" || name === "isdisjoint") {
      return method((args) => {
        this.requireArgCount(name, args, 1);
        const values = this.iterateAll(args[0]!);
        if (name === "issubset") return receiver.items.every((item) => values.some((value) => this.equalValues(item, value)));
        if (name === "issuperset") return values.every((value) => this.setHas(receiver, value));
        return !receiver.items.some((item) => values.some((value) => this.equalValues(item, value)));
      });
    }
    if (name === "intersection_update" || name === "difference_update" || name === "symmetric_difference_update") {
      return method((args) => {
        this.requireArgCount(name, args, 1);
        const values = this.iterateAll(args[0]!);
        if (name === "intersection_update") {
          receiver.items = receiver.items.filter((item) => values.some((value) => this.equalValues(item, value)));
        } else if (name === "difference_update") {
          receiver.items = receiver.items.filter((item) => !values.some((value) => this.equalValues(item, value)));
        } else {
          const original = [...receiver.items];
          receiver.items = original.filter((item) => !values.some((value) => this.equalValues(item, value)));
          for (const value of values) if (!original.some((item) => this.equalValues(item, value))) this.setAdd(receiver, value);
        }
        return makeNone(this.heap);
      });
    }
    return undefined;
  }

  /** Merge a dict, or an iterable of key/value pairs, into `target` (shared by dict() and dict.update()). */
  private dictUpdateFrom(target: DictValue, source: Value): void {
    if (isKind(source, "dict")) {
      for (const entry of [...source.entries]) this.dictSet(target, entry.key, entry.value);
      return;
    }
    for (const pair of this.iterateAll(source)) {
      const parts = isKind(pair, "list") || isKind(pair, "tuple") ? pair.items : typeof pair === "string" ? Array.from(pair) : undefined;
      if (parts === undefined || parts.length !== 2) {
        throw new ThmValueError("dictionary update sequence element must be a pair");
      }
      this.dictSet(target, parts[0]!, parts[1]!);
    }
  }

  private parseInteger(text: string, base: number): bigint {
    const original = text;
    let body = text.trim().replace(/_/g, (underscore, offset: number, whole: string) =>
      /[0-9a-zA-Z]/.test(whole[offset - 1] ?? "") && /[0-9a-zA-Z]/.test(whole[offset + 1] ?? "") ? "" : underscore);
    let negative = false;
    if (body.startsWith("+") || body.startsWith("-")) {
      negative = body[0] === "-";
      body = body.slice(1);
    }
    const prefixes: Record<string, number> = { "0x": 16, "0o": 8, "0b": 2 };
    const prefix = body.slice(0, 2).toLowerCase();
    if (prefixes[prefix] !== undefined && (base === 0 || base === prefixes[prefix])) {
      base = prefixes[prefix]!;
      body = body.slice(2);
    } else if (base === 0) base = 10;
    const digits = "0123456789abcdefghijklmnopqrstuvwxyz".slice(0, base);
    if (body.length === 0 || ![...body.toLowerCase()].every((char) => digits.includes(char))) {
      throw new ThmValueError(`invalid literal for int() with base ${base}: ${JSON.stringify(original)}`);
    }
    let value = BigInt(0);
    const big = BigInt(base);
    for (const char of body.toLowerCase()) value = value * big + BigInt(digits.indexOf(char));
    return negative ? -value : value;
  }

  private parseFloat(text: string): number {
    const body = text.trim().replace(/_/g, "");
    const lowered = body.toLowerCase().replace(/^[+-]/, "");
    if (lowered === "inf" || lowered === "infinity") return body.startsWith("-") ? -Infinity : Infinity;
    if (lowered === "nan") return Number.NaN;
    if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(body)) {
      throw new ThmValueError(`could not convert string to float: ${JSON.stringify(text)}`);
    }
    return Number(body);
  }

  private dictFind(dictionary: DictValue, key: Value): DictEntry | undefined {
    const hash = this.hashValue(key);
    return dictionary.entries.find((entry) => entry.hash === hash && this.equalValues(entry.key, key));
  }

  private dictFindIndex(dictionary: DictValue, key: Value): number {
    const hash = this.hashValue(key);
    return dictionary.entries.findIndex((entry) => entry.hash === hash && this.equalValues(entry.key, key));
  }

  private dictSet(dictionary: DictValue, key: Value, value: Value): void {
    const hash = this.hashValue(key);
    const existing = dictionary.entries.find((entry) => entry.hash === hash && this.equalValues(entry.key, key));
    if (existing !== undefined) existing.value = value;
    else dictionary.entries.push({ key, value, hash });
  }

  private hashValue(value: Value, visited = new Set<number>()): string {
    if (isKind(value, "none")) return "none";
    if (typeof value === "boolean") return `number:${value ? 1 : 0}`;
    if (typeof value === "number") return `number:${Object.is(value, -0) ? 0 : value}`;
    if (typeof value === "bigint") return `number:${value}`;
    if (typeof value === "string") return `string:${value}`;
    if (isKind(value, "tuple")) {
      if (visited.has(value.heapId)) throw new ThmTypeError("recursive tuple is not hashable");
      visited.add(value.heapId);
      const hashes = value.items.map((item) => this.hashValue(item, visited));
      visited.delete(value.heapId);
      return `tuple:${JSON.stringify(hashes)}`;
    }
    throw new ThmTypeError(`unhashable type: '${this.typeName(value)}'`);
  }

  private setHas(set: SetValue, value: Value): boolean {
    const hash = this.hashValue(value);
    return set.items.some((item) => this.hashValue(item) === hash && this.equalValues(item, value));
  }

  private setAdd(set: SetValue, value: Value): void {
    if (!this.setHas(set, value)) set.items.push(value);
  }

  private unpack(value: Value, count: number): Value[] {
    const values = this.iterateAll(value);
    if (values.length !== count) {
      throw new ThmValueError(`unpacking requires ${count} values, received ${values.length}`);
    }
    return values;
  }

  private toIterator(value: Value, dictMode: "keys" | "values" | "items" = "keys"): IteratorValue {
    if (isKind(value, "iterator")) return value;
    if (isKind(value, "generator")) {
      return makeIterator(this.heap, { kind: "generator", source: value });
    }
    if (isKind(value, "list") || isKind(value, "tuple")) {
      return makeIterator(this.heap, { kind: "sequence", source: value, index: 0, step: 1 });
    }
    if (isKind(value, "dict")) {
      return makeIterator(this.heap, { kind: "dict", source: value, index: 0, size: value.entries.length, mode: dictMode });
    }
    if (isKind(value, "set")) {
      return makeIterator(this.heap, { kind: "set", source: value, index: 0, size: value.items.length });
    }
    if (typeof value === "string") return makeIterator(this.heap, { kind: "string", source: value, index: 0, step: 1 });
    if (isKind(value, "range")) return makeIterator(this.heap, { kind: "range", source: value, index: 0 });
    throw new ThmTypeError(`'${this.typeName(value)}' object is not iterable`);
  }

  private next(iterator: IteratorValue): { done: true } | { done: false; value: Value } {
    const state = iterator.state;
    if (state === null) throw new RuntimeError("Iterator has been released");
    switch (state.kind) {
      case "sequence": {
        const index = state.index;
        if (index < 0 || index >= state.source.items.length) return { done: true };
        state.index += state.step;
        return { done: false, value: state.source.items[index]! };
      }
      case "string": {
        if (state.index < 0 || state.index >= state.source.length) return { done: true };
        const value = state.source[state.index]!;
        state.index += state.step;
        return { done: false, value };
      }
      case "range": {
        if (state.index >= state.source.length) return { done: true };
        const value = state.source.start + state.source.step * state.index++;
        return { done: false, value };
      }
      case "dict": {
        if (state.source.entries.length !== state.size) throw new RuntimeError("dictionary changed size during iteration");
        if (state.index >= state.size) return { done: true };
        const entry = state.source.entries[state.index++]!;
        if (state.mode === "keys") return { done: false, value: entry.key };
        if (state.mode === "values") return { done: false, value: entry.value };
        return { done: false, value: makeTuple(this.heap, [entry.key, entry.value]) };
      }
      case "set": {
        if (state.source.items.length !== state.size) throw new RuntimeError("set changed size during iteration");
        if (state.index >= state.size) return { done: true };
        return { done: false, value: state.source.items[state.index++]! };
      }
      case "enumerate": {
        const next = this.next(state.source);
        if (next.done) return { done: true };
        return { done: false, value: makeTuple(this.heap, [state.index++, next.value]) };
      }
      case "zip": {
        const values: Value[] = [];
        for (const source of state.sources) {
          const next = this.next(source);
          if (next.done) return { done: true };
          values.push(next.value);
        }
        return { done: false, value: makeTuple(this.heap, values) };
      }
      case "map": {
        const values: Value[] = [];
        for (const source of state.sources) {
          const next = this.next(source);
          if (next.done) return { done: true };
          values.push(next.value);
        }
        return { done: false, value: this.invokeCallback(state.callback, values) };
      }
      case "filter": {
        while (true) {
          const next = this.next(state.source);
          if (next.done) return { done: true };
          const keep = state.callback === null
            ? this.truthy(next.value)
            : this.truthy(this.invokeCallback(state.callback, [next.value]));
          if (keep) return next;
        }
      }
      case "reverse-sequence": {
        if (state.index < 0) return { done: true };
        return { done: false, value: state.source.items[state.index--]! };
      }
      case "reverse-string": {
        if (state.index < 0) return { done: true };
        return { done: false, value: state.source[state.index--]! };
      }
      case "generator":
        return this.advanceGenerator(state.source);
    }
    throw new RuntimeError("Unknown iterator state");
  }

  /** Drive a generator function one step: start or resume its frame until it
   *  yields again or completes. */
  private advanceGenerator(generator: GeneratorValue): { done: true } | { done: false; value: Value } {
    if (generator.done) return { done: true };
    if (generator.error !== undefined) throw generator.error;

    if (!generator.started) {
      generator.started = true;
      this.pushGeneratorFrame(generator);
    } else {
      // Resume: put the saved frame back on the stack.
      this.frames.push(generator.frame);
      generator.frame = null;
    }

    const depth = this.frames.length - 1;
    try {
      this.executeUntil(depth);
    } catch (error) {
      generator.done = true;
      generator.error = error;
      throw error;
    }

    if (generator.pendingValue !== undefined) {
      const value = generator.pendingValue;
      generator.pendingValue = undefined;
      return { done: false, value };
    }
    // Frame completed without yielding (RETURN/HALT).
    generator.done = true;
    if (generator.error !== undefined) throw generator.error;
    return { done: true };
  }

  private pushGeneratorFrame(generator: GeneratorValue): void {
    const fn = generator.fn;
    const environment = this.bindFunction(fn, generator.args, generator.keywords);
    this.frames.push({
      chunk: fn.chunk,
      instructionPointer: 0,
      stackBase: this.stack.length,
      environment,
      module: this.moduleForEnvironment(environment),
      generator,
    });
    generator.frame = null;
  }

  iterateAll(value: Value): Value[] {
    const iterator = this.toIterator(value);
    const values: Value[] = [];
    while (true) {
      const result = this.next(iterator);
      if (result.done) return values;
      values.push(result.value);
    }
  }

  /** Stable sort with optional `key` function and `reverse` flag (Python semantics). */
  private sortValues(values: Value[], key: Value | null = null, reverse = false): void {
    const keys = key === null ? values : values.map((value) => this.invokeCallback(key, [value]));
    const order = values.map((_, index) => index);
    order.sort((left, right) => {
      const result = this.compareOrder(keys[left]!, keys[right]!);
      return reverse ? -result : result;
    });
    const sorted = order.map((index) => values[index]!);
    for (let index = 0; index < sorted.length; index++) values[index] = sorted[index]!;
  }

  /** Read `key=` / `reverse=` keyword arguments, rejecting anything else. */
  private sortKeywords(name: string, keywords: ReadonlyMap<string, Value> | undefined): { key: Value | null; reverse: boolean } {
    let key: Value | null = null;
    let reverse = false;
    for (const [keyword, value] of keywords ?? new Map<string, Value>()) {
      if (keyword === "key") key = value;
      else if (keyword === "reverse") reverse = this.truthy(value);
      else throw new ThmTypeError(`${name}() got an unexpected keyword argument '${keyword}'`);
    }
    return { key, reverse };
  }

  private minMax(kind: "min" | "max", args: Value[], keywords?: ReadonlyMap<string, Value>): Value {
    let key: Value | null = null;
    let fallback: Value | undefined;
    for (const [keyword, value] of keywords ?? new Map<string, Value>()) {
      if (keyword === "key") key = value;
      else if (keyword === "default") fallback = value;
      else throw new ThmTypeError(`${kind}() got an unexpected keyword argument '${keyword}'`);
    }
    if (args.length === 0) throw new ThmTypeError(`${kind} expected at least one argument`);
    const values = args.length === 1 ? this.iterateAll(args[0]!) : args;
    if (values.length === 0) {
      if (fallback !== undefined) return fallback;
      throw new ThmValueError(`${kind}() arg is an empty sequence`);
    }
    const keys = key === null ? values : values.map((value) => this.invokeCallback(key, [value]));
    let best = 0;
    for (let index = 1; index < values.length; index++) {
      const order = this.compareOrder(keys[index]!, keys[best]!);
      if ((kind === "min" && order < 0) || (kind === "max" && order > 0)) best = index;
    }
    return values[best]!;
  }

  private typeName(value: Value): string {
    if (isKind(value, "none")) return "NoneType";
    if (typeof value === "boolean") return "bool";
    if (typeof value === "bigint") return "int";
    if (typeof value === "number") return "float";
    if (typeof value === "string") return "str";
    if (isKind(value, "exception")) return value.exceptionType;
    if (isKind(value, "function")) return "function";
    if (isKind(value, "class")) return "type";
    if (isKind(value, "instance")) return value.klass.name;
    if (isKind(value, "super")) return "super";
    if (isKind(value, "native")) return "builtin_function";
    if (isKind(value, "module")) return "module";
    return value.kind;
  }

  private getType(value: Value): TypeValue | ClassValue {
    if (isKind(value, "instance")) return value.klass;
    if (isKind(value, "class")) {
      if (value.metaclass !== null) return value.metaclass;
      return this.rootMetaclass;
    }
    return makeType(this.heap, this.typeName(value));
  }

  private isSubclass(candidate: ClassValue, expected: ClassValue): boolean {
    return candidate.mro.includes(expected);
  }

  private isMetaclassSubclass(
    candidate: ClassValue | TypeValue,
    expected: ClassValue | TypeValue,
  ): boolean {
    if (isKind(expected, "type") && expected.name === "type") {
      return (isKind(candidate, "type") && candidate.name === "type") ||
        (isKind(candidate, "class") && candidate.isMetaclass);
    }
    return isKind(candidate, "class") && isKind(expected, "class") &&
      this.isSubclass(candidate, expected);
  }

  private isInstance(value: Value, typeName: string): boolean {
    if (typeName === "int") return typeof value === "bigint" || typeof value === "boolean";
    if (typeName === "float") return typeof value === "number";
    return this.typeName(value) === typeName;
  }

  private stringify(value: Value, representation: boolean, visited = new Set<number>()): string {
    if (isKind(value, "none")) return "none";
    if (typeof value === "boolean") return value ? "true" : "false";
    if (typeof value === "bigint") return String(value);
    if (typeof value === "number") return String(value);
    if (typeof value === "string") return representation ? JSON.stringify(value) : value;
    if (isKind(value, "bytes")) {
      const hexChars = "0123456789abcdef";
      let result = "b'";
      for (let i = 0; i < value.data.length; i++) {
        const b = value.data[i];
        if (b >= 0x20 && b < 0x7f && b !== 0x27 && b !== 0x5c) {
          result += String.fromCharCode(b);
        } else {
          result += "\\x" + hexChars[b >> 4] + hexChars[b & 0xf];
        }
      }
      return result + "'";
    }
    if (isKind(value, "exception")) {
      return value.message.length === 0
        ? `${value.exceptionType}()`
        : `${value.exceptionType}: ${value.message}`;
    }
    if (visited.has(value.heapId)) {
      if (isKind(value, "list")) return "[...]";
      if (isKind(value, "tuple")) return "(...)";
      if (isKind(value, "set")) return "{...}";
      if (isKind(value, "dict")) return "{...}";
    }
    if (isKind(value, "list") || isKind(value, "tuple") || isKind(value, "set")) {
      visited.add(value.heapId);
      const body = value.items.map((item) => this.stringify(item, true, visited)).join(", ");
      visited.delete(value.heapId);
      if (isKind(value, "list")) return `[${body}]`;
      if (isKind(value, "tuple")) return value.items.length === 1 ? `(${body},)` : `(${body})`;
      return value.items.length === 0 ? "set()" : `{${body}}`;
    }
    if (isKind(value, "dict")) {
      visited.add(value.heapId);
      const body = value.entries
        .map((entry) => `${this.stringify(entry.key, true, visited)}: ${this.stringify(entry.value, true, visited)}`)
        .join(", ");
      visited.delete(value.heapId);
      return `{${body}}`;
    }
    if (isKind(value, "function")) return `<function ${value.name}>`;
    if (isKind(value, "class")) return `<class '${value.name}'>`;
    if (isKind(value, "instance")) return `<${value.klass.name} object>`;
    if (isKind(value, "super")) {
      const name = value.instance === null
        ? "released"
        : isKind(value.instance, "instance")
          ? value.instance.klass.name
          : value.instance.name;
      return `<super: <${name} object>>`;
    }
    if (isKind(value, "native")) return `<built-in function ${value.name}>`;
    if (isKind(value, "range")) return `range(${value.start}, ${value.stop}, ${value.step})`;
    if (isKind(value, "type")) return `<class '${value.name}'>`;
    if (isKind(value, "module")) return `<module '${value.name}'>`;
    if (isKind(value, "coroutine")) return `<coroutine ${value.name}>`;
    return "<iterator>";
  }

  private fromConstant(value: Chunk["constants"][number]): Value {
    if (Array.isArray(value)) throw new RuntimeError("Unexpected array constant");
    if (value !== null && typeof value === "object" && value.constructor.name === "Uint8Array") {
      return makeBytes(this.heap, value as Uint8Array);
    }
    if (value === null) {
      return makeNone(this.heap);
    }
    return value as Value;
  }

  private requireArgCount(name: string, args: Value[], count: number): void {
    if (args.length !== count) throw new ThmTypeError(`${name}() takes exactly ${count} argument(s)`);
  }

  private popMany(count: number): Value[] {
    const result = Array.from({ length: count }, () => this.pop());
    result.reverse();
    return result;
  }

  private pop(): Value {
    const value = this.stack.pop();
    if (value === undefined) throw new RuntimeError("VM operand stack underflow");
    return value;
  }

  private peek(distance = 0): Value {
    const value = this.stack[this.stack.length - 1 - distance];
    if (value === undefined) throw new RuntimeError("VM operand stack underflow");
    return value;
  }

  private roots(): ManagedObject[] {
    const roots: ManagedObject[] = [
      this.rootMetaclass,
      ...managedReferences(this.stack),
      ...managedReferences(this.temporaryRoots),
    ];
    if (this.globals !== null) roots.push(this.globals);
    roots.push(...this.modules.values());
    for (const frame of this.frames) {
      roots.push(frame.environment);
      if (frame.capture !== undefined && frame.capture.value !== null) roots.push(...managedReferences([frame.capture.value]));
    }
    return roots;
  }
}

function parseFunctionCreationMetadata(
  text: string | undefined,
  parameterNames: string[],
): FunctionCreationMetadata {
  if (text === undefined) {
    return {
      parameters: parameterNames.map((name) => ({ name, kind: "positional", hasDefault: false })),
      defaults: 0,
      isAsync: false,
      isGenerator: false,
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new RuntimeError("Malformed function parameter metadata");
  }
  if (typeof value !== "object" || value === null) throw new RuntimeError("Malformed function parameter metadata");
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.parameters) || !Number.isInteger(record.defaults)) {
    throw new RuntimeError("Malformed function parameter metadata");
  }
  const rawParameters: unknown[] = record.parameters;
  const parameters: FunctionParameterSpec[] = [];
  let defaultCount = 0;
  for (let index = 0; index < rawParameters.length; index++) {
    const item = rawParameters[index];
    if (typeof item !== "object" || item === null) throw new RuntimeError("Malformed function parameter metadata");
    const parameter = item as Record<string, unknown>;
    const kind = parameter.kind;
    if (
      typeof parameter.name !== "string" ||
      parameter.name !== parameterNames[index] ||
      (kind !== "positional" && kind !== "vararg" && kind !== "keywordOnly" && kind !== "kwarg") ||
      typeof parameter.hasDefault !== "boolean"
    ) {
      throw new RuntimeError("Malformed function parameter metadata");
    }
    if (parameter.hasDefault) {
      if (kind === "vararg" || kind === "kwarg") throw new RuntimeError("Variadic parameter cannot have a default");
      defaultCount++;
    }
    parameters.push({ name: parameter.name, kind, hasDefault: parameter.hasDefault });
  }
  if (
    parameters.length !== parameterNames.length ||
    record.defaults !== defaultCount ||
    (record.defaults as number) < 0
  ) {
    throw new RuntimeError("Malformed function parameter metadata");
  }
  return {
    parameters,
    defaults: record.defaults as number,
    isAsync: record.isAsync === true,
    isGenerator: record.isGenerator === true,
  };
}

function parseCallArgumentSpecs(text: string | undefined, count: number): CallArgumentSpec[] {
  if (text === undefined) return Array.from({ length: count }, () => ({ kind: "positional" }));
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new RuntimeError("Malformed call argument metadata");
  }
  if (!Array.isArray(value) || value.length !== count) throw new RuntimeError("Malformed call argument metadata");
  const rawSpecs: unknown[] = value;
  const specs: CallArgumentSpec[] = [];
  for (const item of rawSpecs) {
    if (typeof item !== "object" || item === null) throw new RuntimeError("Malformed call argument metadata");
    const record = item as Record<string, unknown>;
    const kind = record.kind;
    const name = record.name;
    if (
      kind !== "positional" &&
      kind !== "keyword" &&
      kind !== "star" &&
      kind !== "keywordStar"
    ) {
      throw new RuntimeError("Malformed call argument metadata");
    }
    if (kind === "keyword" && typeof name !== "string") {
      throw new RuntimeError("Keyword argument metadata is missing its name");
    }
    specs.push(kind === "keyword" ? { kind, name: name as string } : { kind });
  }
  return specs;
}
