import type { Expr, Parameter, Program, Statement } from "./ast.js";
import { SyntaxError } from "../errors/errors.js";
import { tokenize, type Token } from "../lexer/tokenizer.js";

const binaryPrecedence: Record<string, number> = {
  or: 1,
  and: 2,
  "==": 3,
  "!=": 3,
  "<": 3,
  "<=": 3,
  ">": 3,
  ">=": 3,
  in: 3,
  is: 3,
  "|": 4,
  "^": 5,
  "&": 6,
  "<<": 7,
  ">>": 7,
  "+": 8,
  "-": 8,
  "*": 9,
  "/": 9,
  "//": 9,
  "%": 9,
  "**": 11,
};

const assignmentOperators = new Set(["=", "+=", "-=", "*=", "/=", "//=", "%=", "**=", "&=", "|=", "^=", "<<=", ">>="]);

export class Parser {
  private current = 0;

  constructor(private readonly tokens: Token[]) {}

  parseProgram(): Program {
    const statements: Statement[] = [];
    this.skipNewlines();
    while (!this.checkKind("eof")) {
      statements.push(...this.parseDecoratedStatement());
      this.skipNewlines();
    }
    return { statements };
  }

  parseExpressionOnly(): Expr {
    this.skipNewlines();
    const expression = this.parseExpression();
    this.skipNewlines();
    if (!this.checkKind("eof")) throw this.error("Unexpected token after expression");
    return expression;
  }

  private parseDecoratedStatement(): Statement[] {
    const decorators: Expr[] = [];
    while (this.match("@")) {
      decorators.push(this.parseExpression());
      this.consumeLineEnd();
    }
    const statement = this.parseStatement(decorators);
    if (decorators.length > 0 && statement[0]?.kind !== "function" && statement[0]?.kind !== "class") {
      throw this.error("Decorators can only be applied to functions and classes");
    }
    return statement;
  }

  private parseStatement(decorators: Expr[] = []): Statement[] {
    const word = this.peek().value;
    const next = this.peek(1);
    const assignmentAfterName = assignmentOperators.has(next.value);
    const postfixAfterName = next.value === "." || next.value === "(" || next.value === "[";
    if (
      word === "with" &&
      !assignmentAfterName &&
      !postfixAfterName &&
      next.kind === "identifier"
    ) {
      throw this.error(`${word} statements are not supported`);
    }
    if (word === "match" && next.kind === "identifier" && this.peek(2).value === "{") {
      throw this.error("match statements are not supported");
    }
    if (word === "async" && this.peek(1).value === "def") {
      const start = this.advance();
      if (!this.matchKeyword("def")) throw this.error("Expected 'def' after 'async'");
      return [this.parseFunction(decorators, true, start)];
    }
    if (word === "async" && this.peek(1).value === "for") {
      throw this.error("async for is not supported");
    }
    if (word === "async" && this.peek(1).value === "with") {
      throw this.error("async with is not supported");
    }
    if (this.matchKeyword("def")) return [this.parseFunction(decorators)];
    if (this.matchKeyword("class")) return [this.parseClass(decorators)];
    if (this.checkKeyword("del") && !assignmentAfterName) {
      this.advance();
      return [this.parseDelete()];
    }
    if (this.matchKeyword("if")) return [this.parseIf()];
    if (this.matchKeyword("switch")) return [this.parseSwitch()];
    if (this.matchKeyword("while")) return [this.parseWhile()];
    if (this.matchKeyword("for")) return [this.parseFor()];
    if (this.matchKeyword("return")) return [this.parseReturn()];
    if (this.matchKeyword("break")) return [this.simpleStatement("break")];
    if (this.matchKeyword("continue")) return [this.simpleStatement("continue")];
    if (this.matchKeyword("pass")) return [this.simpleStatement("pass")];
    if (this.matchKeyword("global")) return [this.parseScope("global")];
    if (this.matchKeyword("nonlocal")) return [this.parseScope("nonlocal")];
    if (this.matchKeyword("raise")) return [this.parseRaise()];
    if (this.matchKeyword("assert")) return [this.parseAssert()];
    if (this.matchKeyword("try")) return [this.parseTry()];
    if (this.matchKeyword("import")) return [this.parseImport()];
    if (this.matchKeyword("from")) return [this.parseFromImport()];
    return [this.parseSimpleStatement()];
  }

  private parseFunction(decorators: Expr[], isAsync = false, asyncToken?: Token): Statement {
    const start = asyncToken ?? this.previous();
    const name = this.consumeIdentifier("Expected function name");
    const typeParameters = this.parseTypeParameters();
    this.consume("(", "Expected '(' after function name");
    const parameters = this.parseParameters();
    this.consume(")", "Expected ')' after parameters");
    let returnAnnotation: string | undefined;
    if (this.match("->")) returnAnnotation = this.parseAnnotation(new Set(["{"]));
    const body = this.parseBlock(`function '${name.value}'`);
    this.validateParameters(parameters, name);
    return {
      kind: "function",
      name: name.value,
      isAsync,
      isGenerator: this.blockContainsYield(body),
      typeParameters,
      parameters,
      returnAnnotation,
      decorators,
      body,
      line: start.line,
      column: start.column,
    };
  }

  private parseClass(decorators: Expr[]): Statement {
    const start = this.previous();
    const name = this.consumeIdentifier("Expected class name");
    const typeParameters = this.parseTypeParameters();
    const bases: Expr[] = [];
    let metaclass: Expr | undefined;
    if (this.match("(")) {
      if (!this.check(")")) {
        do {
          if (this.checkKind("identifier") && this.peek().value === "metaclass" && this.peek(1).value === "=") {
            if (metaclass !== undefined) throw this.error("Duplicate metaclass argument");
            this.advance();
            this.advance();
            metaclass = this.parseExpression();
          } else {
            if (metaclass !== undefined) throw this.error("Base class follows metaclass argument");
            bases.push(this.parseExpression());
          }
        } while (this.match(",") && !this.check(")"));
      }
      this.consume(")", "Expected ')' after base classes");
    }
    return {
      kind: "class",
      name: name.value,
      typeParameters,
      bases,
      metaclass,
      decorators,
      body: this.parseBlock(`class '${name.value}'`),
      line: start.line,
      column: start.column,
    };
  }

  private parseDelete(): Statement {
    const start = this.previous();
    const targets = [this.parseExpression()];
    while (this.match(",")) targets.push(this.parseExpression());
    const deletable = (target: Expr): boolean =>
      target.kind === "name" || target.kind === "attribute" || target.kind === "index" || target.kind === "slice" ||
      ((target.kind === "tuple" || target.kind === "list") && target.items.every(deletable));
    if (!targets.every(deletable)) {
      throw new SyntaxError("cannot delete this expression", start);
    }
    return { kind: "delete", targets, line: start.line, column: start.column };
  }

  private parseTypeParameters(): string[] {
    if (!this.match("[")) return [];
    const parameters: string[] = [];
    if (this.check("]")) throw this.error("Type parameter list cannot be empty");
    do {
      parameters.push(this.consumeIdentifier("Expected type parameter name").value);
    } while (this.match(",") && !this.check("]"));
    this.consume("]", "Expected ']' after type parameters");
    return parameters;
  }

  private parseParameters(): Parameter[] {
    const parameters: Parameter[] = [];
    this.skipNewlines();
    let sawDefault = false;
    let keywordOnly = false;
    let sawVararg = false;
    let sawKwarg = false;
    while (!this.check(")") && !this.checkKind("eof")) {
      this.skipNewlines();
      if (this.match("**")) {
        if (sawKwarg) throw this.error("Only one **kwargs parameter is allowed");
        parameters.push(this.parseParameter("kwarg"));
        sawKwarg = true;
        this.skipNewlines();
        if (this.match(",") && !this.check(")")) throw this.error("**kwargs must be the final parameter");
        break;
      }
      if (this.match("*")) {
        if (sawVararg) throw this.error("Only one *args parameter is allowed");
        sawVararg = true;
        keywordOnly = true;
        if (this.match(",")) continue;
        if (this.check(")")) throw this.error("Expected a name after '*'");
        parameters.push(this.parseParameter("vararg"));
      } else {
        const parameter = this.parseParameter(keywordOnly ? "keywordOnly" : "positional");
        if (parameter.kind === "positional") {
          if (parameter.defaultValue !== undefined) sawDefault = true;
          else if (sawDefault) throw this.error("Non-default parameter follows default parameter");
        }
        parameters.push(parameter);
      }
      this.skipNewlines();
      if (!this.match(",")) break;
      this.skipNewlines();
    }
    return parameters;
  }

  private parseParameter(kind: Parameter["kind"]): Parameter {
    const name = this.consumeIdentifier("Expected parameter name");
    let annotation: string | undefined;
    if (this.match(":")) annotation = this.parseAnnotation(new Set(["=", ",", ")"]));
    let defaultValue: Expr | undefined;
    if (this.match("=")) {
      if (kind === "vararg" || kind === "kwarg") throw this.error(`${kind === "vararg" ? "*args" : "**kwargs"} cannot have a default`);
      defaultValue = this.parseExpression();
    }
    return { name: name.value, kind, annotation, defaultValue };
  }

  private validateParameters(parameters: Parameter[], functionName: Token): void {
    const names = new Set<string>();
    let sawVararg = false;
    let sawKwarg = false;
    for (const parameter of parameters) {
      if (names.has(parameter.name)) {
        throw new SyntaxError(`Duplicate parameter name ${parameter.name}`, functionName);
      }
      names.add(parameter.name);
      if (parameter.kind === "vararg") {
        if (sawVararg || sawKwarg) throw new SyntaxError("Invalid vararg parameter ordering", functionName);
        sawVararg = true;
      }
      if (parameter.kind === "kwarg") {
        if (sawKwarg) throw new SyntaxError("Duplicate **kwargs parameter", functionName);
        sawKwarg = true;
      }
    }
  }

  private parseAnnotation(stops: Set<string>): string {
    const parts: string[] = [];
    let parens = 0;
    let brackets = 0;
    let braces = 0;
    while (!this.checkKind("eof")) {
      const token = this.peek();
      if (
        parens === 0 &&
        brackets === 0 &&
        braces === 0 &&
        (stops.has(token.value) || token.kind === "newline")
      ) {
        break;
      }
      if (token.value === "(") parens++;
      else if (token.value === ")") {
        if (parens === 0) break;
        parens--;
      } else if (token.value === "[") brackets++;
      else if (token.value === "]") {
        if (brackets === 0) break;
        brackets--;
      } else if (token.value === "{") braces++;
      else if (token.value === "}") {
        if (braces === 0) break;
        braces--;
      }
      parts.push(this.advance().value);
    }
    if (parts.length === 0) throw this.error("Expected annotation");
    return parts.join(" ");
  }

  private parseBlock(context = "a block"): Statement[] {
    this.skipNewlines();
    if (!this.check("{")) {
      const token = this.peek();
      throw this.error(
        `Expected an indented block after ${context} (found '{' expected, got '${token.value}' at ${token.line}:${token.column})`,
      );
    }
    this.consume("{", "Expected '{' to begin block");
    const statements: Statement[] = [];
    this.skipNewlines();
    while (!this.check("}") && !this.checkKind("eof")) {
      statements.push(...this.parseDecoratedStatement());
      this.skipNewlines();
    }
    this.consume("}", "Expected '}' after block");
    return statements;
  }

  private parseIf(): Statement {
    const start = this.previous();
    const condition = this.parseExpression();
    const body = this.parseBlock();
    this.skipNewlines();
    let otherwise: Statement[] = [];
    if (this.matchKeyword("else")) {
      otherwise = this.parseBlock();
    } else if (this.matchKeyword("elif")) {
      otherwise = [this.parseIf()];
    }
    return { kind: "if", condition, body, otherwise, line: start.line, column: start.column };
  }

  private parseSwitch(): Statement {
    const start = this.previous();
    this.consume("(", "Expected '(' after 'switch'");
    const subject = this.parseExpression();
    this.consume(")", "Expected ')' after switch subject");
    this.skipNewlines();
    if (!this.check("{")) throw this.error("Expected '{' to begin switch block");
    this.consume("{", "Expected '{' to begin switch block");
    const cases: Array<{ value: Expr; body: Statement[] }> = [];
    let defaultBody: Statement[] = [];
    let sawDefault = false;
    this.skipNewlines();
    while (!this.check("}") && !this.checkKind("eof")) {
      if (this.matchKeyword("case")) {
        const value = this.parseExpression();
        this.skipNewlines();
        let body: Statement[];
        if (this.match(":")) {
          // fallthrough style: single statement form `case N: stmt` — collect
          // statements until the next case/default/closing brace.
          body = [];
          while (!this.checkKeyword("case") && !this.checkKeyword("default") && !this.check("}") && !this.checkKind("eof")) {
            body.push(...this.parseDecoratedStatement());
            this.skipNewlines();
          }
        } else {
          body = this.parseBlock("case clause");
          this.skipNewlines();
        }
        cases.push({ value, body });
      } else if (this.matchKeyword("default")) {
        if (sawDefault) throw this.error("Multiple 'default' clauses in switch statement");
        sawDefault = true;
        this.skipNewlines();
        if (this.match(":")) {
          defaultBody = [];
          while (!this.checkKeyword("case") && !this.checkKeyword("default") && !this.check("}") && !this.checkKind("eof")) {
            defaultBody.push(...this.parseDecoratedStatement());
            this.skipNewlines();
          }
        } else {
          defaultBody = this.parseBlock("default clause");
          this.skipNewlines();
        }
      } else {
        const token = this.peek();
        throw this.error(`Expected 'case' or 'default' in switch block (got '${token.value}' at ${token.line}:${token.column})`);
      }
    }
    this.consume("}", "Expected '}' after switch block");
    return { kind: "switch", subject, cases, defaultBody, line: start.line, column: start.column };
  }

  private parseWhile(): Statement {
    const start = this.previous();
    const condition = this.parseExpression();
    const body = this.parseBlock();
    this.skipNewlines();
    const otherwise = this.matchKeyword("else") ? this.parseBlock() : [];
    return { kind: "while", condition, body, otherwise, line: start.line, column: start.column };
  }

  private parseFor(): Statement {
    const start = this.previous();
    const targetItems = [this.parseExpression(4)];
    while (this.match(",")) {
      if (this.checkKeyword("in")) break;
      targetItems.push(this.parseExpression(4));
    }
    const target = targetItems.length === 1
      ? targetItems[0]!
      : { kind: "tuple" as const, items: targetItems, line: start.line, column: start.column };
    if (!this.matchKeyword("in")) throw this.error("Expected 'in' in for statement");
    const iterable = this.parseExpression();
    const body = this.parseBlock();
    this.skipNewlines();
    const otherwise = this.matchKeyword("else") ? this.parseBlock() : [];
    return { kind: "for", target, iterable, body, otherwise, isAsync: false, line: start.line, column: start.column };
  }

  private parseReturn(): Statement {
    const start = this.previous();
    const value = this.checkKind("newline") || this.check("}") || this.checkKind("eof")
      ? undefined
      : this.parseExpressionList();
    return { kind: "return", value, line: start.line, column: start.column };
  }

  private simpleStatement(kind: "break" | "continue" | "pass"): Statement {
    const token = this.previous();
    return { kind, line: token.line, column: token.column };
  }

  private parseScope(scope: "global" | "nonlocal"): Statement {
    const start = this.previous();
    const names = [this.consumeIdentifier(`Expected name after ${scope}`).value];
    while (this.match(",")) names.push(this.consumeIdentifier(`Expected name after ${scope}`).value);
    if (new Set(names).size !== names.length) throw this.error(`Duplicate name in ${scope} declaration`);
    return { kind: "scope", scope, names, line: start.line, column: start.column };
  }

  private parseRaise(): Statement {
    const start = this.previous();
    const value = this.checkKind("newline") || this.check("}") ? undefined : this.parseExpression();
    return { kind: "raise", value, line: start.line, column: start.column };
  }

  private parseAssert(): Statement {
    const start = this.previous();
    const condition = this.parseExpression();
    const message = this.match(",") ? this.parseExpression() : undefined;
    return { kind: "assert", condition, message, line: start.line, column: start.column };
  }

  private parseTry(): Statement {
    const start = this.previous();
    const body = this.parseBlock();
    const handlers: Array<{ type?: Expr; name?: string; body: Statement[] }> = [];
    let otherwise: Statement[] = [];
    let finalBody: Statement[] = [];
    this.skipNewlines();
    while (this.matchKeyword("except")) {
      let type: Expr | undefined;
      let name: string | undefined;
      if (!this.check("{")) {
        type = this.parseExpression();
        if (this.matchKeyword("as")) name = this.consumeIdentifier("Expected exception variable").value;
      }
      handlers.push({ type, name, body: this.parseBlock() });
      this.skipNewlines();
    }
    if (this.matchKeyword("else")) {
      otherwise = this.parseBlock();
      this.skipNewlines();
    }
    if (this.matchKeyword("finally")) finalBody = this.parseBlock();
    if (handlers.length === 0 && finalBody.length === 0) {
      throw new SyntaxError("try requires except or finally", start);
    }
    return { kind: "try", body, handlers, otherwise, finalBody, line: start.line, column: start.column };
  }

  private parseImport(): Statement {
    const start = this.previous();
    const module = this.parseDottedName();
    const alias = this.matchKeyword("as") ? this.consumeIdentifier("Expected import alias").value : undefined;
    return { kind: "import", module, alias, line: start.line, column: start.column };
  }

  private parseFromImport(): Statement {
    const start = this.previous();
    let module = "";
    while (this.match(".")) module += ".";
    if (this.checkKind("identifier")) module += this.parseDottedName();
    this.consumeKeyword("import", "Expected 'import' in from-import statement");
    if (this.match("*")) throw this.error("from ... import * is not supported");
    const names: Array<{ name: string; alias?: string }> = [];
    do {
      const name = this.consumeIdentifier("Expected imported name").value;
      const alias = this.matchKeyword("as") ? this.consumeIdentifier("Expected import alias").value : undefined;
      names.push({ name, alias });
    } while (this.match(","));
    return { kind: "fromImport", module, names, line: start.line, column: start.column };
  }

  private parseDottedName(): string {
    let name = this.consumeIdentifier("Expected module name").value;
    while (this.match(".")) name += `.${this.consumeIdentifier("Expected name after '.'").value}`;
    return name;
  }

  private parseSimpleStatement(): Statement {
    const start = this.peek();
    const first = this.parseExpressionList();
    if (this.match(":")) {
      const annotation = this.parseAnnotation(new Set(["="]));
      const value = this.match("=") ? this.parseExpressionList() : undefined;
      return { kind: "annotate", target: first, annotation, value, line: start.line, column: start.column };
    }
    const assignments: Expr[] = [first];
    if (assignmentOperators.has(this.peek().value)) {
      const operator = this.advance().value;
      if (operator !== "=") {
        const value = this.parseExpressionList();
        return {
          kind: "augmentedAssign",
          target: first,
          operator: operator.slice(0, -1),
          value,
          line: start.line,
          column: start.column,
        };
      }
      let right: Expr;
      while (true) {
        right = this.parseExpressionList();
        if (!this.match("=")) break;
        assignments.push(right);
      }
      return {
        kind: "assign",
        targets: assignments,
        value: right,
        line: start.line,
        column: start.column,
      };
    }
    return { kind: "expression", expression: first, line: start.line, column: start.column };
  }

  private parseExpressionList(): Expr {
    return this.parseExpressionListFrom(this.parseExpression());
  }

  private parseExpressionListFrom(first: Expr): Expr {
    if (!this.match(",")) return first;
    const items = [first];
    while (!this.checkKind("newline") && !this.check("}") && !this.check(")") && !this.check("]") && !this.checkKind("eof")) {
      items.push(this.parseExpression());
      if (!this.match(",")) break;
    }
    return { kind: "tuple", items, line: first.line, column: first.column };
  }

  private parseExpression(minPrecedence = 0): Expr {
    let left = this.parsePrefix();
    left = this.parsePostfix(left);

    while (true) {
      if (this.check(":=")) throw this.error("Walrus assignment is not supported");
      if (this.checkKeyword("if") && minPrecedence === 0) {
        this.advance();
        const condition = this.parseExpression();
        this.consumeKeyword("else", "Expected 'else' in conditional expression");
        const whenFalse = this.parseExpression();
        left = { kind: "conditional", whenTrue: left, condition, whenFalse, line: left.line, column: left.column };
        continue;
      }

      const comparison = this.peekComparisonOperator();
      if (comparison !== undefined && 3 >= minPrecedence) {
        const first = left;
        const rest: Array<{ operator: string; right: Expr }> = [];
        while (this.peekComparisonOperator() !== undefined) {
          const operator = this.consumeComparisonOperator();
          rest.push({ operator, right: this.parseExpression(4) });
        }
        left = { kind: "compare", first, rest, line: first.line, column: first.column };
        continue;
      }

      const operator = this.peek().value;
      const precedence = binaryPrecedence[operator];
      if (precedence === undefined || precedence < minPrecedence || ["is", "in"].includes(operator)) break;
      this.advance();
      const right = this.parseExpression(precedence + (operator === "**" ? 0 : 1));
      left = { kind: "binary", operator, left, right, line: left.line, column: left.column };
    }
    return left;
  }

  private parsePrefix(): Expr {
    const token = this.advance();
    if (token.kind === "number") {
      const source = token.value.split("_").join("");
      if (!source.includes(".") && !source.includes("e") && !source.includes("E")) {
        try {
          return { kind: "literal", value: BigInt(source), line: token.line, column: token.column };
        } catch {
          throw new SyntaxError("Invalid integer literal", token);
        }
      }
      const value = Number(source);
      if (!Number.isFinite(value)) throw new SyntaxError("Invalid numeric literal", token);
      return { kind: "literal", value, line: token.line, column: token.column };
    }
    if (token.kind === "string") {
      // Python-style implicit concatenation: adjacent string literals form
      // one constant at parse time (e.g. "hello" " world").
      let value = token.value;
      while (this.checkKind("string")) value += this.advance().value;
      return { kind: "literal", value, line: token.line, column: token.column };
    }
    if (token.kind === "bytes") {
      // Bytes literals: b"..." or b'...'
      // Python-style implicit concatenation for bytes.
      let value = token.value;
      while (this.checkKind("bytes")) value += this.advance().value;
      return { kind: "bytes", value, line: token.line, column: token.column };
    }
    if (token.kind === "fstring") return this.parseFString(token);
    if (token.kind === "identifier") {
      if (token.value === "true" || token.value === "True") return { kind: "literal", value: true, line: token.line, column: token.column };
      if (token.value === "false" || token.value === "False") return { kind: "literal", value: false, line: token.line, column: token.column };
      if (token.value === "none") return { kind: "literal", value: null, line: token.line, column: token.column };
      if (token.value === "None") return { kind: "literal", value: null, line: token.line, column: token.column };
      if (token.value === "lambda") return this.parseLambda(token);
      if (token.value === "not") {
        const operand = this.parseExpression(3);
        return { kind: "unary", operator: "not", operand, line: token.line, column: token.column };
      }
      if (token.value === "yield") {
        if (
          this.checkKind("newline") ||
          this.check("}") ||
          this.check(")") ||
          this.check("]") ||
          this.check(",") ||
          this.check(":") ||
          this.checkKind("eof")
        ) {
          return { kind: "yield", line: token.line, column: token.column };
        }
        return { kind: "yield", value: this.parseExpression(), line: token.line, column: token.column };
      }
      if (token.value === "await") {
        const operand = this.parseExpression(3);
        return { kind: "await", value: operand, line: token.line, column: token.column };
      }
      return { kind: "name", name: token.value, line: token.line, column: token.column };
    }
    if (token.value === "+" || token.value === "-" || token.value === "~") {
      const operand = this.parseExpression(10);
      return { kind: "unary", operator: token.value, operand, line: token.line, column: token.column };
    }
    if (token.value === "(") {
      if (this.match(")")) return { kind: "tuple", items: [], line: token.line, column: token.column };
      const start = this.peek();
      const first = this.parseExpression();
      if (this.checkKeyword("for")) {
        const clauses = this.parseComprehensionClauses(")");
        this.consume(")", "Expected ')' after generator expression");
        return { kind: "comprehension", container: "generator", element: first, clauses, line: start.line, column: start.column };
      }
      const expression = this.parseExpressionListFrom(first);
      this.consume(")", "Expected ')' after expression");
      return expression;
    }
    if (token.value === "[") {
      this.skipNewlines();
      if (this.match("]")) return { kind: "list", items: [], line: token.line, column: token.column };
      const first = this.parseExpression();
      if (this.checkKeyword("for")) {
        const clauses = this.parseComprehensionClauses("]");
        this.consume("]", "Expected ']' after list comprehension");
        return { kind: "comprehension", container: "list", element: first, clauses, line: token.line, column: token.column };
      }
      const items = [first];
      while (this.match(",")) {
        this.skipNewlines();
        if (this.check("]")) break;
        items.push(this.parseExpression());
        this.skipNewlines();
      }
      this.consume("]", "Expected ']' after list");
      return { kind: "list", items, line: token.line, column: token.column };
    }
    if (token.value === "{") return this.parseBraceExpression(token);
    throw new SyntaxError(`Expected expression, found ${token.value || "end of input"}`, token);
  }

  private parseLambda(start: Token): Expr {
    const parameters: Parameter[] = [];
    if (!this.check(":")) {
      do {
        const name = this.consumeIdentifier("Expected lambda parameter name");
        let defaultValue: Expr | undefined;
        if (this.match("=")) defaultValue = this.parseExpression();
        parameters.push({ name: name.value, kind: "positional", defaultValue });
      } while (this.match(",") && !this.check(":"));
    }
    this.consume(":", "Expected ':' after lambda parameters");
    const names = new Set<string>();
    for (const parameter of parameters) {
      if (names.has(parameter.name)) throw new SyntaxError(`Duplicate parameter name ${parameter.name}`, start);
      names.add(parameter.name);
    }
    return { kind: "lambda", parameters, body: this.parseExpression(), line: start.line, column: start.column };
  }

  private parsePostfix(initial: Expr): Expr {
    let expression = initial;
    while (true) {
      if (this.match("(")) {
        const args = this.parseCallArguments();
        this.consume(")", "Expected ')' after arguments");
        expression = { kind: "call", callee: expression, args, line: expression.line, column: expression.column };
      } else if (this.match(".")) {
        const name = this.consumeIdentifier("Expected attribute name after '.'");
        expression = {
          kind: "attribute",
          receiver: expression,
          name: name.value,
          line: expression.line,
          column: expression.column,
        };
      } else if (this.match("[")) {
        this.skipNewlines();
        let start: Expr | undefined;
        if (!this.check(":") && !this.check("]")) start = this.parseExpression();
        if (this.match(":")) {
          this.skipNewlines();
          const stop = this.check(":") || this.check("]") ? undefined : this.parseExpression();
          let step: Expr | undefined;
          if (this.match(":")) {
            this.skipNewlines();
            if (!this.check("]")) step = this.parseExpression();
          }
          this.consume("]", "Expected ']' after slice");
          expression = { kind: "slice", receiver: expression, start, stop, step, line: expression.line, column: expression.column };
        } else {
          if (start === undefined) throw this.error("Empty subscription");
          this.consume("]", "Expected ']' after index");
          expression = { kind: "index", receiver: expression, index: start, line: expression.line, column: expression.column };
        }
      } else {
        return expression;
      }
    }
  }

  private parseCallArguments(): Array<{ kind: "positional" | "keyword" | "star" | "keywordStar"; value: Expr; name?: string }> {
    const args: Array<{ kind: "positional" | "keyword" | "star" | "keywordStar"; value: Expr; name?: string }> = [];
    const keywordNames = new Set<string>();
    let sawKeyword = false;
    this.skipNewlines();
    while (!this.check(")") && !this.checkKind("eof")) {
      this.skipNewlines();
      if (this.match("**")) {
        args.push({ kind: "keywordStar", value: this.parseExpression() });
        sawKeyword = true;
      } else if (this.match("*")) {
        args.push({ kind: "star", value: this.parseExpression() });
      } else if (this.checkKind("identifier") && this.peek(1).value === "=") {
        const name = this.advance().value;
        this.advance();
        if (keywordNames.has(name)) throw this.error(`Duplicate keyword argument ${name}`);
        keywordNames.add(name);
        args.push({ kind: "keyword", name, value: this.parseExpression() });
        sawKeyword = true;
      } else {
        if (sawKeyword) throw this.error("Positional argument follows keyword argument");
        const first = this.parseExpression();
        // Bare generator-expression argument: f(x for x in xs) — no parens
        // needed around the comprehension, mirroring Python's call syntax.
        if (this.checkKeyword("for")) {
          const clauses = this.parseComprehensionClauses(")");
          args.push({ kind: "positional", value: { kind: "comprehension", container: "generator", element: first, clauses, line: first.line, column: first.column } });
          this.skipNewlines();
          if (!this.check(")")) throw this.error("Expected ')' after generator expression argument");
          break;
        }
        args.push({ kind: "positional", value: first });
      }
      this.skipNewlines();
      if (!this.match(",") || this.check(")")) break;
    }
    return args;
  }

  private parseBraceExpression(start: Token): Expr {
    this.skipNewlines();
    if (this.match("}")) return { kind: "dict", items: [], line: start.line, column: start.column };
    const first = this.parseExpression();
    this.skipNewlines();
    if (this.match(":")) {
      const value = this.parseExpression();
      this.skipNewlines();
      if (this.checkKeyword("for")) {
        const clauses = this.parseComprehensionClauses("}");
        this.consume("}", "Expected '}' after dictionary comprehension");
        return { kind: "comprehension", container: "dict", key: first, element: value, clauses, line: start.line, column: start.column };
      }
      const items: Array<[Expr, Expr]> = [[first, value]];
      while (this.match(",")) {
        this.skipNewlines();
        if (this.check("}")) break;
        const key = this.parseExpression();
        this.consume(":", "Expected ':' between dictionary key and value");
        items.push([key, this.parseExpression()]);
        this.skipNewlines();
      }
      this.consume("}", "Expected '}' after dictionary");
      return { kind: "dict", items, line: start.line, column: start.column };
    }
    if (this.checkKeyword("for")) {
      const clauses = this.parseComprehensionClauses("}");
      this.consume("}", "Expected '}' after set comprehension");
      return { kind: "comprehension", container: "set", element: first, clauses, line: start.line, column: start.column };
    }
    const items = [first];
    while (this.match(",")) {
      this.skipNewlines();
      if (this.check("}")) break;
      items.push(this.parseExpression());
      this.skipNewlines();
    }
    this.consume("}", "Expected '}' after set");
    return { kind: "set", items, line: start.line, column: start.column };
  }

  private parseComprehensionClauses(end: string): Array<{ target: Expr; iterable: Expr; filters: Expr[]; isAsync: boolean }> {
    const clauses: Array<{ target: Expr; iterable: Expr; filters: Expr[]; isAsync: boolean }> = [];
    while (this.matchKeyword("for") || (this.checkKeyword("async") && this.peek(1).value === "for")) {
      let isAsync = false;
      if (this.matchKeyword("async")) {
        isAsync = true;
        this.consumeKeyword("for", "Expected 'for' after 'async' in comprehension");
      }
      const targetFirst = this.parseExpression(4);
      let target: Expr = targetFirst;
      if (this.match(",")) {
        const items = [targetFirst];
        do { items.push(this.parseExpression(4)); } while (this.match(",") && !this.checkKeyword("in"));
        target = { kind: "tuple", items, line: targetFirst.line, column: targetFirst.column };
      }
      this.consumeKeyword("in", "Expected 'in' in comprehension");
      const iterable = this.parseExpression(4);
      const filters: Expr[] = [];
      while (this.matchKeyword("if")) filters.push(this.parseExpression(0));
      clauses.push({ target, iterable, filters, isAsync });
      this.skipNewlines();
      if (!(this.checkKeyword("for") || (this.checkKeyword("async") && this.peek(1).value === "for"))) break;
    }
    if (clauses.length === 0) throw this.error("Expected comprehension 'for' clause");
    return clauses;
  }

  private parseDelimitedExpressions(end: string): Expr[] {
    const items: Expr[] = [];
    this.skipNewlines();
    if (this.match(end)) return items;
    do {
      this.skipNewlines();
      items.push(this.parseExpression());
      this.skipNewlines();
    } while (this.match(",") && !this.check(end));
    this.consume(end, `Expected '${end}' after items`);
    return items;
  }

  private parseFString(token: Token): Expr {
    const parts: Array<string | Expr> = [];
    let text = "";
    let index = 0;
    while (index < token.value.length) {
      const char = token.value[index] ?? "";
      const next = token.value[index + 1] ?? "";
      if ((char === "{" || char === "}") && next === char) {
        text += char;
        index += 2;
        continue;
      }
      if (char === "}") throw new SyntaxError("Unmatched '}' in f-string", token);
      if (char !== "{") {
        text += char;
        index++;
        continue;
      }
      if (text.length > 0) {
        parts.push(text);
        text = "";
      }
      const expressionStart = ++index;
      let depth = 1;
      let quote = "";
      let escaped = false;
      while (index < token.value.length && depth > 0) {
        const current = token.value[index] ?? "";
        if (quote !== "") {
          if (escaped) escaped = false;
          else if (current === "\\") escaped = true;
          else if (current === quote) quote = "";
        } else if (current === "'" || current === '"') {
          quote = current;
        } else if (current === "{") {
          depth++;
        } else if (current === "}") {
          depth--;
        }
        index++;
      }
      if (depth !== 0) throw new SyntaxError("Unclosed interpolation in f-string", token);
      const source = token.value.slice(expressionStart, index - 1);
      if (source.length === 0) throw new SyntaxError("Empty interpolation in f-string", token);
      if (this.hasTopLevelColon(source)) throw new SyntaxError("F-string format specifications are not supported", token);
      parts.push(new Parser(tokenize(source)).parseExpressionOnly());
    }
    if (text.length > 0) parts.push(text);
    return { kind: "fstring", parts, line: token.line, column: token.column };
  }

  private hasTopLevelColon(source: string): boolean {
    const tokens = tokenize(source);
    let parens = 0;
    let brackets = 0;
    let braces = 0;
    for (const token of tokens) {
      if (token.kind === "eof") break;
      if (token.value === "(") parens++;
      else if (token.value === ")") parens--;
      else if (token.value === "[") brackets++;
      else if (token.value === "]") brackets--;
      else if (token.value === "{") braces++;
      else if (token.value === "}") braces--;
      else if (token.value === ":" && parens === 0 && brackets === 0 && braces === 0) return true;
    }
    return false;
  }

  private peekComparisonOperator(): string | undefined {
    if (this.checkKeyword("is") && this.peek(1).value === "not") return "is not";
    if (this.matchAhead("==", "!=", "<", "<=", ">", ">=", "in", "is")) return this.peek().value;
    if (this.checkKeyword("not") && this.peek(1).value === "in") return "not in";
    return undefined;
  }

  private consumeComparisonOperator(): string {
    if (this.matchKeyword("not")) {
      this.consumeKeyword("in", "Expected 'in' after 'not'");
      return "not in";
    }
    if (this.matchKeyword("is")) {
      return this.matchKeyword("not") ? "is not" : "is";
    }
    return this.advance().value;
  }

  private matchAhead(...values: string[]): boolean {
    return values.includes(this.peek().value);
  }

  private consumeLineEnd(): void {
    if (this.matchKind("newline")) {
      this.skipNewlines();
      return;
    }
    if (!this.check("}") && !this.checkKind("eof")) throw this.error("Expected end of statement");
  }

  private skipNewlines(): void {
    while (this.matchKind("newline")) {}
  }

  private checkKeyword(value: string): boolean {
    return this.peek().kind === "identifier" && this.peek().value === value;
  }

  private matchKeyword(value: string): boolean {
    if (!this.checkKeyword(value)) return false;
    this.advance();
    return true;
  }

  private consumeKeyword(value: string, message: string): Token {
    if (this.checkKeyword(value)) return this.advance();
    throw this.error(message);
  }

  private consumeIdentifier(message: string): Token {
    if (this.checkKind("identifier")) return this.advance();
    throw this.error(message);
  }

  private consume(value: string, message: string): Token {
    if (this.check(value)) return this.advance();
    throw this.error(message);
  }

  private match(...values: string[]): boolean {
    if (values.some((value) => this.check(value))) {
      this.advance();
      return true;
    }
    return false;
  }

  private matchKind(kind: Token["kind"]): boolean {
    if (!this.checkKind(kind)) return false;
    this.advance();
    return true;
  }

  private check(value: string): boolean {
    const token = this.peek();
    // String literals such as "*" or ")" must never match operators or keywords.
    if (token.kind === "string" || token.kind === "fstring") return false;
    return token.value === value;
  }

  private checkKind(kind: Token["kind"]): boolean {
    return this.peek().kind === kind;
  }

  private advance(): Token {
    if (!this.checkKind("eof")) this.current++;
    return this.previous();
  }

  private peek(distance = 0): Token {
    return this.tokens[Math.min(this.current + distance, this.tokens.length - 1)]!;
  }

  private previous(): Token {
    return this.tokens[Math.max(this.current - 1, 0)]!;
  }

  private error(message: string): SyntaxError {
    return new SyntaxError(message, this.peek());
  }

  /** Whether any direct (non-nested-function) statement in the block yields. */
  private blockContainsYield(statements: Statement[]): boolean {
    for (const statement of statements) {
      if (this.statementContainsYield(statement)) return true;
    }
    return false;
  }

  private statementContainsYield(statement: Statement): boolean {
    switch (statement.kind) {
      case "expression":
        return this.expressionContainsYield(statement.expression);
      case "assign":
        return statement.targets.some((target) => this.expressionContainsYield(target))
          || this.expressionContainsYield(statement.value);
      case "augmentedAssign":
        return this.expressionContainsYield(statement.target) || this.expressionContainsYield(statement.value);
      case "annotate":
        return statement.value !== undefined && this.expressionContainsYield(statement.value);
      case "return":
      case "raise":
        return statement.value !== undefined && this.expressionContainsYield(statement.value);
      case "if":
        return this.expressionContainsYield(statement.condition)
          || this.blockContainsYield(statement.body)
          || this.blockContainsYield(statement.otherwise);
      case "while":
        return this.expressionContainsYield(statement.condition)
          || this.blockContainsYield(statement.body)
          || this.blockContainsYield(statement.otherwise);
      case "for":
        return this.expressionContainsYield(statement.iterable)
          || this.blockContainsYield(statement.body)
          || this.blockContainsYield(statement.otherwise);
      case "try":
        return this.blockContainsYield(statement.body)
          || statement.handlers.some((handler) => this.blockContainsYield(handler.body))
          || this.blockContainsYield(statement.otherwise)
          || this.blockContainsYield(statement.finalBody);
      case "delete":
        return statement.targets.some((target) => this.expressionContainsYield(target));
      case "assert":
        return this.expressionContainsYield(statement.condition)
          || (statement.message !== undefined && this.expressionContainsYield(statement.message));
      default:
        return false;
    }
  }

  private expressionContainsYield(expression: Expr): boolean {
    switch (expression.kind) {
      case "yield":
        return true;
      case "literal":
      case "bytes":
      case "name":
        return false;
      case "tuple":
      case "list":
      case "set":
        return expression.items.some((item) => this.expressionContainsYield(item));
      case "dict":
        return expression.items.some(([key, value]) =>
          this.expressionContainsYield(key) || this.expressionContainsYield(value));
      case "unary":
        return this.expressionContainsYield(expression.operand);
      case "binary":
        return this.expressionContainsYield(expression.left) || this.expressionContainsYield(expression.right);
      case "compare":
        return this.expressionContainsYield(expression.first)
          || expression.rest.some((item) => this.expressionContainsYield(item.right));
      case "conditional":
        return this.expressionContainsYield(expression.whenTrue)
          || this.expressionContainsYield(expression.condition)
          || this.expressionContainsYield(expression.whenFalse);
      case "await":
      case "attribute":
      case "index":
        return this.expressionContainsYield((expression as { value?: Expr; receiver: Expr }).value
          ?? (expression as { receiver: Expr }).receiver);
      case "slice":
        return this.expressionContainsYield(expression.receiver)
          || [expression.start, expression.stop, expression.step].some(
            (part) => part !== undefined && this.expressionContainsYield(part));
      case "fstring":
        return expression.parts.some((part) => typeof part !== "string" && this.expressionContainsYield(part));
      case "call":
        return this.expressionContainsYield(expression.callee)
          || expression.args.some((argument) => this.expressionContainsYield(argument.value));
      case "comprehension":
        return expression.clauses.some((clause) =>
          this.expressionContainsYield(clause.iterable) || clause.filters.some((filter) => this.expressionContainsYield(filter)))
          || (expression.key !== undefined && this.expressionContainsYield(expression.key))
          || (expression.element !== undefined && this.expressionContainsYield(expression.element));
      case "lambda":
        return false;
    }
  }
}

export function parse(source: string): Program {
  return new Parser(tokenize(source)).parseProgram();
}

export function parseExpression(source: string): Expr {
  return new Parser(tokenize(source)).parseExpressionOnly();
}

