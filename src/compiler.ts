import type { Expr, Program, Statement } from "./parser/ast.js";
import { CompileError, SyntaxError } from "./errors/errors.js";
import {
  validateChunk,
  type Chunk,
  type ExceptionEntry,
  type Instruction,
  type Opcode,
} from "./compiler/bytecode/bytecode.js";
import { analyzeScope } from "./semantic-analyzer/analyzer.js";

interface LoopContext {
  continueTarget: number;
  breaks: number[];
  iterator: boolean;
  finalizerDepth: number;
}

type Finalizer = { body: Statement[]; source: Statement };

class ChunkCompiler {
  private readonly code: Instruction[] = [];
  private comprehensionCounter = 0;
  private readonly comprehensionNameRemaps = new Map<string, string>();
  private readonly constants: Chunk["constants"] = [];
  private readonly names: string[] = [];
  private readonly nested: Chunk[] = [];
  private readonly annotations: string[] = [];
  private readonly loopStack: LoopContext[] = [];
  private readonly finalizers: Finalizer[] = [];
  private readonly exceptions: ExceptionEntry[] = [];
  private localNames: Set<string>;
  private globalNames = new Set<string>();
  private nonlocalNames = new Set<string>();
  private capturedNames = new Set<string>();

  constructor(
    private readonly name: string,
    private readonly sourceFile: string,
    private readonly isFunction: boolean,
    private readonly parameters: string[],
    private readonly genericParameters: string[],
    private readonly enclosingNames: Set<string>,
    private readonly isAsync = false,
    private readonly isGenerator = false,
  ) {
    this.localNames = isFunction ? new Set(parameters) : new Set();
  }

  compile(statements: Statement[]): Chunk {
    const scope = analyzeScope(statements, {
      isFunction: this.isFunction,
      parameters: this.parameters,
      enclosingNames: this.enclosingNames,
      allowAwait: this.isAsync,
      allowYield: this.isGenerator,
    });
    this.localNames = scope.localNames;
    this.globalNames = scope.globalNames;
    this.nonlocalNames = scope.nonlocalNames;
    this.capturedNames = scope.capturedNames;

    for (const statement of statements) this.compileStatement(statement);
    if (this.isFunction) {
      this.emit("CONST", this.constant(null), undefined, this.lastLocation());
      this.emit("RETURN", undefined, undefined, this.lastLocation());
    } else {
      this.emit("HALT", undefined, undefined, this.lastLocation());
    }

    const chunk: Chunk = {
      name: this.name,
      sourceFile: this.sourceFile,
      code: this.code,
      constants: this.constants,
      names: this.names,
      nested: this.nested,
      annotations: this.annotations,
      genericParameters: this.genericParameters,
      parameters: this.parameters,
      localNames: [...this.localNames].sort(),
      exceptions: this.exceptions,
    };
    // debug: validateChunk(chunk);
    return chunk;
  }

  private compileStatement(statement: Statement): void {
    switch (statement.kind) {
      case "expression":
        if (statement.expression.kind === "yield" && this.isGenerator) {
          // Bare yield statement: compile inside the function so YIELD's
          // suspend/resume contract keeps the operand stack balanced.
          this.compileExpression(statement.expression);
          return;
        }
        this.compileExpression(statement.expression);
        this.emit("POP", undefined, undefined, statement);
        return;
      case "assign":
        this.compileExpression(statement.value);
        for (let index = 0; index < statement.targets.length; index++) {
          if (index + 1 < statement.targets.length) this.emit("DUP", undefined, undefined, statement);
          this.compileStoreTarget(statement.targets[index]!, statement);
        }
        return;
      case "annotate": {
        this.annotations.push(`${describeTarget(statement.target)}: ${statement.annotation}`);
        if (statement.value !== undefined) {
          this.compileExpression(statement.value);
          this.compileStoreTarget(statement.target, statement);
        }
        return;
      }
      case "augmentedAssign":
        this.compileAugmentedAssignment(statement);
        return;
      case "function":
        this.compileFunction(statement);
        return;
      case "class":
        this.compileClass(statement);
        return;
      case "if":
        this.compileIf(statement);
        return;
      case "switch":
        this.compileSwitch(statement);
        return;
      case "while":
        this.compileWhile(statement);
        return;
      case "for":
        this.compileFor(statement);
        return;
      case "return":
        if (!this.isFunction) throw new SyntaxError("return outside a function", statement);
        if (statement.value === undefined) this.emit("CONST", this.constant(null), undefined, statement);
        else this.compileExpression(statement.value);
        this.compileFinalizersFrom(0);
        this.emit("RETURN", undefined, undefined, statement);
        return;
      case "break": {
        const loop = this.loopStack[this.loopStack.length - 1];
        if (loop === undefined) throw new SyntaxError("break outside a loop", statement);
        this.compileFinalizersFrom(loop.finalizerDepth);
        if (loop.iterator) this.emit("POP", undefined, undefined, statement);
        loop.breaks.push(this.emit("JUMP", 0, undefined, statement));
        return;
      }
      case "continue": {
        const loop = this.loopStack[this.loopStack.length - 1];
        if (loop === undefined) throw new SyntaxError("continue outside a loop", statement);
        this.compileFinalizersFrom(loop.finalizerDepth);
        this.emit("JUMP", loop.continueTarget, undefined, statement);
        return;
      }
      case "pass":
      case "scope":
        return;
      case "delete":
        for (const target of statement.targets) this.compileDeleteTarget(target, statement);
        return;
      case "raise":
        if (statement.value !== undefined) this.compileExpression(statement.value);
        this.emit("RAISE", statement.value === undefined ? 0 : 1, undefined, statement);
        return;
      case "assert":
        this.compileExpression(statement.condition);
        const assertionPassed = this.emit("JUMP_IF_TRUE", 0, undefined, statement);
        this.emit("LOAD", this.nameIndex("AssertionError"), "global", statement);
        if (statement.message === undefined) {
          this.emit("CONST", this.constant(""), undefined, statement);
        } else {
          this.compileExpression(statement.message);
        }
        this.emit("CALL", 1, undefined, statement);
        this.emit("RAISE", 1, undefined, statement);
        this.patch(assertionPassed, this.code.length);
        return;
      case "try":
        this.compileTry(statement);
        return;
      case "import":
        this.emit("IMPORT", statement.alias === undefined ? 0 : 1, statement.module, statement);
        this.emit(
          "STORE",
          this.nameIndex(statement.alias ?? statement.module.split(".")[0]!),
          this.storeMode(statement.alias ?? statement.module.split(".")[0]!),
          statement,
        );
        return;
      case "fromImport":
        this.emit("IMPORT", 1, statement.module, statement);
        for (const item of statement.names) {
          this.emit("DUP", undefined, undefined, statement);
          this.emit("GET_ATTR", this.nameIndex(item.name), undefined, statement);
          const name = item.alias ?? item.name;
          this.emit("STORE", this.nameIndex(name), this.storeMode(name), statement);
        }
        this.emit("POP", undefined, undefined, statement);
        return;
    }
  }

  private compileClass(statement: Extract<Statement, { kind: "class" }>): void {
    if (statement.metaclass === undefined) {
      this.emit("CONST", this.constant(null), undefined, statement);
    } else {
      this.compileExpression(statement.metaclass);
    }
    for (const base of statement.bases) this.compileExpression(base);
    this.emit("BUILD_TUPLE", statement.bases.length, undefined, statement);
    const visible = new Set([...this.enclosingNames, ...this.localNames]);
    const childCompiler = new ChunkCompiler(
      `<class ${statement.name}>`, this.sourceFile, true, [], statement.typeParameters, visible,
    );
    const childChunk = childCompiler.compile(statement.body);
    this.nested.push(childChunk);
    this.emit("MAKE_CLASS", this.nested.length - 1, statement.name, statement);
    this.compileDecorators(statement.decorators, statement);
    this.emit("STORE", this.nameIndex(statement.name), this.storeMode(statement.name), statement);
  }

  private compileTry(statement: Extract<Statement, { kind: "try" }>): void {
    const hasFinally = statement.finalBody.length > 0;
    const finalizer: Finalizer | undefined = hasFinally
      ? { body: statement.finalBody, source: statement }
      : undefined;
    const activeDepth = this.finalizers.length;
    const tryStart = this.code.length;
    if (finalizer !== undefined) this.finalizers.push(finalizer);
    for (const child of statement.body) this.compileStatement(child);
    if (finalizer !== undefined) this.finalizers.pop();
    const tryEnd = this.code.length;

    const elseStart = this.code.length;
    if (finalizer !== undefined) this.finalizers.push(finalizer);
    for (const child of statement.otherwise) this.compileStatement(child);
    if (finalizer !== undefined) this.finalizers.pop();
    const elseEnd = this.code.length;
    if (hasFinally) this.compileFinalizerBody(finalizer!, activeDepth);
    const normalExits = [this.emit("JUMP", 0, undefined, statement)];

    const dispatch = this.code.length;
    const pendingFinallyEntries: number[] = [];
    if (statement.handlers.length > 0) {
      this.exceptions.push(this.exceptionEntry(tryStart, tryEnd, dispatch, "except", statement));
      const handlerExits: number[] = [];
      for (const handler of statement.handlers) {
        let nextHandler = -1;
        if (handler.type !== undefined) {
          this.emit("DUP", undefined, undefined, statement);
          this.compileExpression(handler.type);
          this.emit("EXC_MATCH", undefined, undefined, statement);
          nextHandler = this.emit("JUMP_IF_FALSE", 0, undefined, statement);
        }

        if (handler.name !== undefined) {
          this.emit("STORE", this.nameIndex(handler.name), this.storeMode(handler.name), statement);
        } else {
          this.emit("POP", undefined, undefined, statement);
        }

        const handlerStart = this.code.length;
        if (finalizer !== undefined) this.finalizers.push(finalizer);
        for (const child of handler.body) this.compileStatement(child);
        if (finalizer !== undefined) this.finalizers.pop();
        const handlerEnd = this.code.length;
        if (hasFinally) this.compileFinalizerBody(finalizer!, activeDepth);
        handlerExits.push(this.emit("JUMP", 0, undefined, statement));
        if (nextHandler >= 0) this.patch(nextHandler, this.code.length);
        if (hasFinally && handlerEnd > handlerStart) {
          pendingFinallyEntries.push(this.exceptions.length);
          this.exceptions.push(this.exceptionEntry(handlerStart, handlerEnd, 0, "finally", statement));
        }
      }

      this.emit("POP", undefined, undefined, statement);
      if (hasFinally) this.compileFinalizerBody(finalizer!, activeDepth);
      this.emit("RAISE", 0, undefined, statement);
      normalExits.push(...handlerExits);
    } else if (hasFinally) {
      pendingFinallyEntries.push(this.exceptions.length);
      this.exceptions.push(this.exceptionEntry(tryStart, tryEnd, dispatch, "finally", statement));
      this.emit("POP", undefined, undefined, statement);
      this.compileFinalizerBody(finalizer!, activeDepth);
      this.emit("RAISE", 0, undefined, statement);
    }

    if (hasFinally && elseEnd > elseStart) {
      pendingFinallyEntries.push(this.exceptions.length);
      this.exceptions.push(this.exceptionEntry(elseStart, elseEnd, 0, "finally", statement));
    }
    if (hasFinally && statement.handlers.length > 0) {
      const cleanup = this.code.length;
      for (const index of pendingFinallyEntries) this.patchExceptionHandler(index, cleanup);
      this.emit("POP", undefined, undefined, statement);
      this.compileFinalizerBody(finalizer!, activeDepth);
      this.emit("RAISE", 0, undefined, statement);
    } else if (hasFinally && pendingFinallyEntries.length > 0) {
      for (const index of pendingFinallyEntries) this.patchExceptionHandler(index, dispatch);
    }
    const end = this.code.length;
    for (const jump of normalExits) this.patch(jump, end);
  }

  private exceptionEntry(
    start: number,
    end: number,
    handler: number,
    kind: "except" | "finally",
    source: Statement,
  ): ExceptionEntry {
    return {
      start,
      end,
      handler,
      kind,
      stackDepth: 1,
      line: source.line,
      column: source.column,
    };
  }

  private patchExceptionHandler(index: number, handler: number): void {
    const entry = this.exceptions[index];
    if (entry === undefined) throw new CompileError("Invalid compiler exception handler");
    entry.handler = handler;
  }

  private compileFinalizerBody(finalizer: Finalizer, outerDepth: number): void {
    const currentDepth = this.finalizers.length;
    this.finalizers.length = outerDepth;
    try {
      for (const child of finalizer.body) this.compileStatement(child);
    } finally {
      this.finalizers.length = currentDepth;
    }
  }

  private compileFinalizersFrom(depth: number): void {
    for (let index = this.finalizers.length - 1; index >= depth; index--) {
      this.compileFinalizerBody(this.finalizers[index]!, index);
    }
  }

  private compileFunction(statement: Extract<Statement, { kind: "function" }>): void {
    const visible = new Set([...this.enclosingNames, ...this.localNames]);
    const childCompiler = new ChunkCompiler(
      statement.name,
      this.sourceFile,
      true,
      statement.parameters.map((parameter) => parameter.name),
      statement.typeParameters,
      visible,
      statement.isAsync,
      statement.isGenerator,
    );
    const childChunk = childCompiler.compile(statement.body);
    for (const parameter of statement.parameters) {
      if (parameter.annotation !== undefined) {
        childChunk.annotations.push(`parameter ${parameter.name}: ${parameter.annotation}`);
      }
    }
    if (statement.returnAnnotation !== undefined) {
      childChunk.annotations.push(`return: ${statement.returnAnnotation}`);
    }
    const defaults = statement.parameters.filter((parameter) => parameter.defaultValue !== undefined);
    for (const parameter of defaults) this.compileExpression(parameter.defaultValue!);
    this.nested.push(childChunk);
    this.emit("MAKE_FUNCTION", this.nested.length - 1, JSON.stringify({
      parameters: statement.parameters.map(({ name, kind, defaultValue }) => ({
        name, kind, hasDefault: defaultValue !== undefined,
      })),
      defaults: defaults.length,
      isAsync: statement.isAsync,
      isGenerator: statement.isGenerator,
    }), statement);
    this.compileDecorators(statement.decorators, statement);
    this.emit("STORE", this.nameIndex(statement.name), this.storeMode(statement.name), statement);
  }

  /** Apply decorators from the bottom up: @a @b def f -> a(b(f)). */
  private compileDecorators(decorators: Expr[], statement: Statement): void {
    for (let index = decorators.length - 1; index >= 0; index--) {
      this.compileExpression(decorators[index]!);
      // The decorated object is already on the stack. CALL expects the
      // callable below its arguments, so exchange the two stack values.
      this.emit("SWAP", undefined, undefined, statement);
      this.emit("CALL", 1, undefined, statement);
    }
  }

  private compileIf(statement: Extract<Statement, { kind: "if" }>): void {
    this.compileExpression(statement.condition);
    const falseJump = this.emit("JUMP_IF_FALSE", 0, undefined, statement);
    for (const child of statement.body) this.compileStatement(child);
    if (statement.otherwise.length === 0) {
      this.patch(falseJump, this.code.length);
      return;
    }
    const endJump = this.emit("JUMP", 0, undefined, statement);
    this.patch(falseJump, this.code.length);
    for (const child of statement.otherwise) this.compileStatement(child);
    this.patch(endJump, this.code.length);
  }

  private compileSwitch(statement: Extract<Statement, { kind: "switch" }>): void {
    this.compileExpression(statement.subject);
    const endJumps: number[] = [];
    const defaultJumps: number[] = [];
    for (const clause of statement.cases) {
      this.emit("DUP", undefined, undefined, statement);
      this.compileExpression(clause.value);
      this.emit("COMPARE", undefined, "==", statement);
      const nextJump = this.emit("JUMP_IF_FALSE", 0, undefined, statement);
      this.emit("POP", undefined, undefined, statement); // pop the matched subject
      for (const child of clause.body) this.compileStatement(child);
      endJumps.push(this.emit("JUMP", 0, undefined, statement));
      this.patch(nextJump, this.code.length);
    }
    this.emit("POP", undefined, undefined, statement); // pop unmatched subject
    for (const child of statement.defaultBody) this.compileStatement(child);
    const end = this.code.length;
    for (const jump of endJumps) this.patch(jump, end);
    void defaultJumps;
  }

  private compileWhile(statement: Extract<Statement, { kind: "while" }>): void {
    const start = this.code.length;
    this.compileExpression(statement.condition);
    const exitJump = this.emit("JUMP_IF_FALSE", 0, undefined, statement);
    const loop: LoopContext = { continueTarget: start, breaks: [], iterator: false, finalizerDepth: this.finalizers.length };
    this.loopStack.push(loop);
    for (const child of statement.body) this.compileStatement(child);
    this.loopStack.pop();
    this.emit("JUMP", start, undefined, statement);
    this.patch(exitJump, this.code.length);
    for (const child of statement.otherwise) this.compileStatement(child);
    const end = this.code.length;
    for (const jump of loop.breaks) this.patch(jump, end);
  }

  private compileFor(statement: Extract<Statement, { kind: "for" }>): void {
    if (statement.isAsync) throw new CompileError("async for is not supported", statement.line, statement.column);
    this.compileExpression(statement.iterable);
    this.emit("ITER", undefined, undefined, statement);
    const start = this.code.length;
    const next = this.emit("ITER_NEXT", 0, undefined, statement);
    this.compileStoreTarget(statement.target, statement);
    const loop: LoopContext = { continueTarget: start, breaks: [], iterator: true, finalizerDepth: this.finalizers.length };
    this.loopStack.push(loop);
    for (const child of statement.body) this.compileStatement(child);
    this.loopStack.pop();
    this.emit("JUMP", start, undefined, statement);
    this.patch(next, this.code.length);
    for (const child of statement.otherwise) this.compileStatement(child);
    const end = this.code.length;
    for (const jump of loop.breaks) this.patch(jump, end);
  }

  private compileAugmentedAssignment(statement: Extract<Statement, { kind: "augmentedAssign" }>): void {
    const { target } = statement;
    if (target.kind === "name") {
      this.emit("LOAD", this.nameIndex(target.name), this.loadMode(target.name), target);
      this.compileExpression(statement.value);
      this.emit("BINARY", undefined, statement.operator, statement);
      this.emit("STORE", this.nameIndex(target.name), this.storeMode(target.name), target);
      return;
    }
    if (target.kind === "attribute") {
      this.compileExpression(target.receiver);
      this.emit("DUP", undefined, undefined, target);
      this.emit("GET_ATTR", this.nameIndex(target.name), undefined, target);
      this.compileExpression(statement.value);
      this.emit("BINARY", undefined, statement.operator, statement);
      this.emit("SET_ATTR", this.nameIndex(target.name), undefined, target);
      return;
    }
    if (target.kind === "index") {
      this.compileExpression(target.receiver);
      this.compileExpression(target.index);
      this.emit("DUP2", undefined, undefined, target);
      this.emit("GET_ITEM", undefined, undefined, target);
      this.compileExpression(statement.value);
      this.emit("BINARY", undefined, statement.operator, statement);
      this.emit("SET_ITEM", undefined, undefined, target);
      return;
    }
    throw new SyntaxError("Invalid augmented assignment target", target);
  }

  private compileDeleteTarget(target: Expr, source: { line: number; column: number }): void {
    switch (target.kind) {
      case "name":
        this.emit("DEL_NAME", this.nameIndex(target.name), this.storeMode(target.name), target);
        return;
      case "attribute":
        this.compileExpression(target.receiver);
        this.emit("DEL_ATTR", this.nameIndex(target.name), undefined, target);
        return;
      case "index":
        this.compileExpression(target.receiver);
        this.compileExpression(target.index);
        this.emit("DEL_ITEM", undefined, undefined, target);
        return;
      case "slice":
        this.compileExpression(target.receiver);
        this.compileOptional(target.start, target);
        this.compileOptional(target.stop, target);
        this.compileOptional(target.step, target);
        this.emit("DEL_SLICE", undefined, undefined, target);
        return;
      case "tuple":
      case "list":
        for (const item of target.items) this.compileDeleteTarget(item, source);
        return;
      default:
        throw new SyntaxError("cannot delete this expression", source);
    }
  }

  private compileStoreTarget(target: Expr, source: { line: number; column: number }): void {
    switch (target.kind) {
      case "name": {
        const name = this.comprehensionNameRemaps.get(target.name) ?? target.name;
        this.emit("STORE", this.nameIndex(name), this.storeMode(name), target);
        return;
      }
      case "tuple":
        this.emit("UNPACK_SEQUENCE", target.items.length, undefined, target);
        for (const item of target.items) this.compileStoreTarget(item, source);
        return;
      case "list":
        this.emit("UNPACK_SEQUENCE", target.items.length, undefined, target);
        for (const item of target.items) this.compileStoreTarget(item, source);
        return;
      case "attribute":
        this.compileExpression(target.receiver);
        this.emit("SWAP", undefined, undefined, target);
        this.emit("SET_ATTR", this.nameIndex(target.name), undefined, target);
        return;
      case "index":
        this.compileExpression(target.receiver);
        this.compileExpression(target.index);
        this.emit("ROT3", undefined, undefined, target);
        this.emit("SET_ITEM", undefined, undefined, target);
        return;
      case "slice":
        // Stack: value. Build receiver,start,stop,step above it, then SET_SLICE pops all five
        // with the assigned value deepest (SET_SLICE reads it from below the slice operands).
        this.compileExpression(target.receiver);
        this.compileOptional(target.start, target);
        this.compileOptional(target.stop, target);
        this.compileOptional(target.step, target);
        this.emit("SET_SLICE", undefined, undefined, target);
        return;
      default:
        throw new SyntaxError("Invalid assignment target", source);
    }
  }

  private compileExpression(expression: Expr): void {
    switch (expression.kind) {
      case "literal":
        this.emit("CONST", this.constant(expression.value), undefined, expression);
        return;
      case "bytes":
        this.emit("CONST", this.constant(new TextEncoder().encode(expression.value)), undefined, expression);
        return;
      case "name": {
        const name = this.comprehensionNameRemaps.get(expression.name) ?? expression.name;
        this.emit("LOAD", this.nameIndex(name), this.loadMode(name), expression);
        return;
      }
      case "tuple":
      case "list":
      case "set":
        for (const item of expression.items) this.compileExpression(item);
        this.emit(
          expression.kind === "tuple" ? "BUILD_TUPLE" : expression.kind === "list" ? "BUILD_LIST" : "BUILD_SET",
          expression.items.length,
          undefined,
          expression,
        );
        return;
      case "dict":
        for (const [key, value] of expression.items) {
          this.compileExpression(key);
          this.compileExpression(value);
        }
        this.emit("BUILD_DICT", expression.items.length, undefined, expression);
        return;
      case "comprehension":
        this.compileComprehension(expression);
        return;
      case "unary":
        this.compileExpression(expression.operand);
        this.emit("UNARY", undefined, expression.operator, expression);
        return;
      case "binary":
        this.compileBinary(expression);
        return;
      case "compare":
        this.compileExpression(expression.first);
        if (expression.rest.length === 1) {
          this.compileExpression(expression.rest[0]!.right);
          this.emit("COMPARE", undefined, expression.rest[0]!.operator, expression);
          return;
        }
        const failures: number[] = [];
        for (let index = 0; index < expression.rest.length; index++) {
          const item = expression.rest[index]!;
          this.compileExpression(item.right);
          if (index + 1 < expression.rest.length) {
            failures.push(this.emit("COMPARE_JUMP", 0, item.operator, expression));
          } else {
            this.emit("COMPARE", undefined, item.operator, expression);
          }
        }
        for (const failure of failures) this.patch(failure, this.code.length);
        return;
      case "conditional": {
        this.compileExpression(expression.condition);
        const elseJump = this.emit("JUMP_IF_FALSE", 0, undefined, expression);
        this.compileExpression(expression.whenTrue);
        const endJump = this.emit("JUMP", 0, undefined, expression);
        this.patch(elseJump, this.code.length);
        this.compileExpression(expression.whenFalse);
        this.patch(endJump, this.code.length);
        return;
      }
      case "await":
        this.compileExpression(expression.value);
        this.emit("AWAIT", undefined, undefined, expression);
        return;
      case "yield":
        if (expression.value !== undefined) this.compileExpression(expression.value);
        else this.emit("CONST", this.constant(null), undefined, expression);
        this.emit("YIELD", undefined, undefined, expression);
        return;
      case "lambda":
        this.compileLambda(expression);
        return;
      case "call":
        this.compileExpression(expression.callee);
        for (const argument of expression.args) this.compileExpression(argument.value);
        this.emit("CALL", expression.args.length, JSON.stringify(expression.args.map(({ kind, name }) => ({ kind, name }))), expression);
        return;
      case "attribute":
        this.compileExpression(expression.receiver);
        this.emit("GET_ATTR", this.nameIndex(expression.name), undefined, expression);
        return;
      case "index":
        this.compileExpression(expression.receiver);
        this.compileExpression(expression.index);
        this.emit("GET_ITEM", undefined, undefined, expression);
        return;
      case "slice":
        this.compileExpression(expression.receiver);
        this.compileOptional(expression.start, expression);
        this.compileOptional(expression.stop, expression);
        this.compileOptional(expression.step, expression);
        this.emit("GET_SLICE", undefined, undefined, expression);
        return;
      case "fstring":
        for (const part of expression.parts) {
          if (typeof part === "string") this.emit("CONST", this.constant(part), undefined, expression);
          else this.compileExpression(part);
        }
        this.emit("BUILD_STRING", expression.parts.length, undefined, expression);
        return;
    }
  }

  private compileComprehension(expression: Extract<Expr, { kind: "comprehension" }>): void {
    const tempName = `$__thm_comp_${this.comprehensionCounter++}`;
    this.localNames.add(tempName);
    if (expression.container === "list") this.emit("BUILD_LIST", 0, undefined, expression);
    else if (expression.container === "set") this.emit("BUILD_SET", 0, undefined, expression);
    else this.emit("BUILD_DICT", 0, undefined, expression);
    this.emit("STORE", this.nameIndex(tempName), this.storeMode(tempName), expression);

    const compileClause = (index: number): void => {
      const clause = expression.clauses[index];
      if (clause === undefined) {
        this.emit("LOAD", this.nameIndex(tempName), this.loadMode(tempName), expression);
        if (expression.container === "dict") {
          this.compileExpression(expression.key!);
          this.compileExpression(expression.element!);
          this.emit("DICT_SET", undefined, undefined, expression);
        } else {
          this.compileExpression(expression.element!);
          this.emit(expression.container === "list" ? "LIST_APPEND" : "SET_ADD", undefined, undefined, expression);
        }
        this.emit("POP", undefined, undefined, expression);
        return;
      }
      if (clause.isAsync) throw new CompileError("async for comprehensions are not supported", expression.line, expression.column);
      this.compileExpression(clause.iterable);
      this.emit("ITER", undefined, undefined, expression);
      const loopStart = this.code.length;
      const exhausted = this.emit("ITER_NEXT", 0, undefined, expression);
      const previousMappings = new Map<string, string | undefined>();
      for (const name of this.targetNames(clause.target)) {
        previousMappings.set(name, this.comprehensionNameRemaps.get(name));
        const mapped = `$__thm_comp_${this.comprehensionCounter++}`;
        this.localNames.add(mapped);
        this.comprehensionNameRemaps.set(name, mapped);
      }
      this.compileStoreTarget(clause.target, expression);
      const rejected: number[] = [];
      for (const filter of clause.filters) {
        this.compileExpression(filter);
        rejected.push(this.emit("JUMP_IF_FALSE", 0, undefined, filter));
      }
      compileClause(index + 1);
      const continuePoint = this.code.length;
      for (const jump of rejected) this.patch(jump, continuePoint);
      this.emit("JUMP", loopStart, undefined, expression);
      this.patch(exhausted, this.code.length);
      for (const [name, previous] of previousMappings) {
        if (previous === undefined) this.comprehensionNameRemaps.delete(name);
        else this.comprehensionNameRemaps.set(name, previous);
      }
    };
    compileClause(0);
    this.emit("LOAD", this.nameIndex(tempName), this.loadMode(tempName), expression);
  }

  private targetNames(target: Expr): string[] {
    if (target.kind === "name") return [target.name];
    if (target.kind === "tuple" || target.kind === "list") return target.items.flatMap((item) => this.targetNames(item));
    return [];
  }

  private compileLambda(expression: Extract<Expr, { kind: "lambda" }>): void {
    const visible = new Set([...this.enclosingNames, ...this.localNames]);
    const childCompiler = new ChunkCompiler(
      "<lambda>",
      this.sourceFile,
      true,
      expression.parameters.map((parameter) => parameter.name),
      [],
      visible,
    );
    const childChunk = childCompiler.compile([{
      kind: "return",
      value: expression.body,
      line: expression.line,
      column: expression.column,
    }]);
    const defaults = expression.parameters.filter((parameter) => parameter.defaultValue !== undefined);
    for (const parameter of defaults) this.compileExpression(parameter.defaultValue!);
    this.nested.push(childChunk);
    this.emit("MAKE_FUNCTION", this.nested.length - 1, JSON.stringify({
      parameters: expression.parameters.map(({ name, kind, defaultValue }) => ({
        name, kind, hasDefault: defaultValue !== undefined,
      })),
      defaults: defaults.length,
    }), expression);
  }

  private compileBinary(expression: Extract<Expr, { kind: "binary" }>): void {
    if (expression.operator === "and" || expression.operator === "or") {
      this.compileExpression(expression.left);
      this.emit("DUP", undefined, undefined, expression);
      const jump = this.emit(
        expression.operator === "and" ? "JUMP_IF_FALSE" : "JUMP_IF_TRUE",
        0,
        undefined,
        expression,
      );
      this.emit("POP", undefined, undefined, expression);
      this.compileExpression(expression.right);
      this.patch(jump, this.code.length);
      return;
    }
    this.compileExpression(expression.left);
    this.compileExpression(expression.right);
    this.emit("BINARY", undefined, expression.operator, expression);
  }

  private compileOptional(expression: Expr | undefined, source: { line: number; column: number }): void {
    if (expression === undefined) this.emit("CONST", this.constant(null), undefined, source);
    else this.compileExpression(expression);
  }

  private loadMode(name: string): string {
    if (!this.isFunction || this.globalNames.has(name)) return "global";
    if (this.nonlocalNames.has(name)) return "nonlocal";
    if (this.localNames.has(name)) return "local";
    return this.capturedNames.has(name) ? "closure" : "global";
  }

  private storeMode(name: string): string {
    if (!this.isFunction || this.globalNames.has(name)) return "global";
    if (this.nonlocalNames.has(name)) return "nonlocal";
    return "local";
  }

  private constant(value: Chunk["constants"][number]): number {
    const existing = this.constants.findIndex((candidate) => {
      if (Array.isArray(candidate) && Array.isArray(value)) {
        return candidate.length === value.length && candidate.every((item, index) => item === value[index]);
      }
      return Object.is(candidate, value);
    });
    if (existing >= 0) return existing;
    this.constants.push(value);
    return this.constants.length - 1;
  }

  private nameIndex(value: string): number {
    const existing = this.names.indexOf(value);
    if (existing >= 0) return existing;
    this.names.push(value);
    return this.names.length - 1;
  }

  private emit(op: Opcode, a: number | undefined, text: string | undefined, source: { line: number; column: number }): number {
    const instruction: Instruction = { op, line: source.line, column: source.column };
    if (a !== undefined) instruction.a = a;
    if (text !== undefined) instruction.text = text;
    this.code.push(instruction);
    return this.code.length - 1;
  }

  private patch(index: number, destination: number): void {
    this.code[index]!.a = destination;
  }

  private lastLocation(): { line: number; column: number } {
    const instruction = this.code[this.code.length - 1];
    return instruction === undefined ? { line: 1, column: 1 } : { line: instruction.line, column: instruction.column };
  }
}

function describeTarget(target: Expr): string {
  if (target.kind === "name") return target.name;
  if (target.kind === "attribute") return `${describeTarget(target.receiver)}.${target.name}`;
  if (target.kind === "index") return `${describeTarget(target.receiver)}[...]`;
  return "<target>";
}

export function compile(program: Program, sourceFile = "<stdin>"): Chunk {
  return new ChunkCompiler("<module>", sourceFile, false, [], [], new Set(), true).compile(program.statements);
}
