/**
 * semantic-analyzer/analyzer.ts
 * ---------------------------------------------------------------------------
 * Scope analysis pass run before code generation.
 *
 * For each function/class/module body it determines which names are locals,
 * globals, nonlocals, or captured from enclosing scopes, and validates
 * await/yield usage and assignment targets. The compiler consumes the result
 * to pick LOAD/STORE modes and closure cells.
 */

import type { Expr, Statement } from "../parser/ast.js";
import { SyntaxError } from "../errors/errors.js";
import { collectLocalNames, collectScopeDeclarations, validateAssignmentTarget, validateControlStatements } from "./scope.js";
import { SymbolTable } from "./symbol-table.js";

/** Scope classification of every name used in one body. */
export interface ScopeAnalysis {
  localNames: Set<string>;
  globalNames: Set<string>;
  nonlocalNames: Set<string>;
  capturedNames: Set<string>;
}

// Options for analyzing a scope.
export interface ScopeOptions {
  isFunction: boolean;
  parameters: string[];
  enclosingNames: ReadonlySet<string>;
  allowAwait?: boolean;
  allowYield?: boolean;
}

// Analyze scope for a list of statements.
export function analyzeScope(statements: Statement[], options: ScopeOptions): ScopeAnalysis {
  const symbols = new SymbolTable(options.enclosingNames, options.isFunction);
  collectScopeDeclarations(statements, (scope, name) => {
    if (scope === "global") symbols.declareGlobal(name);
    else symbols.declareNonlocal(name);
  });
  const localNames = collectLocalNames(
    statements,
    options.parameters,
    symbols.globals,
    symbols.nonlocals,
  );
  for (const name of localNames) symbols.defineLocal(name);

  for (const name of symbols.globals) {
    if (symbols.nonlocals.has(name)) throw new SyntaxError(`Name ${name} is both global and nonlocal`);
  }
  for (const name of symbols.nonlocals) {
    if (!options.isFunction) throw new SyntaxError("nonlocal declaration outside a function");
    if (!options.enclosingNames.has(name)) throw new SyntaxError(`No binding for nonlocal ${name}`);
  }

  for (const statement of statements) validateTargetsInStatement(statement);
  validateControlStatements(statements, options.isFunction);
  const awaitAllowed = Boolean(options.allowAwait);
  validateAwaitInStatements(statements, awaitAllowed);
  validateYieldInStatements(statements, options.isFunction, options.allowYield === true);
  collectCapturesInStatements(statements, symbols);

  analyzeChildScopes(statements, new Set([...options.enclosingNames, ...symbols.locals]), awaitAllowed);

  return {
    localNames: symbols.locals,
    globalNames: symbols.globals,
    nonlocalNames: symbols.nonlocals,
    capturedNames: symbols.captures,
  };
}

// Recursively analyze child scopes (functions and classes).
function analyzeChildScopes(
  statements: Statement[],
  enclosingNames: ReadonlySet<string>,
  parentAllowsAwait: boolean,
): void {
  for (const statement of statements) {
    if (statement.kind === "function") {
      analyzeScope(statement.body, {
        isFunction: true,
        parameters: statement.parameters.map((parameter) => parameter.name),
        enclosingNames,
        allowAwait: statement.isAsync,
        allowYield: statement.isGenerator,
      });
    } else if (statement.kind === "class") {
      analyzeScope(statement.body, {
        isFunction: false,
        parameters: [],
        enclosingNames,
        allowAwait: false,
      });
    } else {
      analyzeChildScopes(nestedStatements(statement), enclosingNames, parentAllowsAwait);
    }
  }
}

// Validate all assignment targets in a statement tree.
function validateTargetsInStatement(statement: Statement): void {
  if (statement.kind === "assign") {
    for (const target of statement.targets) validateAssignmentTarget(target, statement.line, statement.column);
  } else if (statement.kind === "augmentedAssign") {
    validateAssignmentTarget(statement.target, statement.line, statement.column);
  } else if (statement.kind === "annotate") {
    validateAssignmentTarget(statement.target, statement.line, statement.column);
  } else if (statement.kind === "for") {
    validateAssignmentTarget(statement.target, statement.line, statement.column);
  }
  for (const child of nestedStatements(statement)) validateTargetsInStatement(child);
}

// Return the nested statement lists of a compound statement.
function nestedStatements(statement: Statement): Statement[] {
  if (statement.kind === "switch") {
    return [...statement.cases.flatMap((clause) => clause.body), ...statement.defaultBody];
  }
  if (statement.kind === "if" || statement.kind === "while" || statement.kind === "for") {
    return [...statement.body, ...statement.otherwise];
  }
  if (statement.kind === "try") {
    return [
      ...statement.body,
      ...statement.handlers.flatMap((handler) => handler.body),
      ...statement.otherwise,
      ...statement.finalBody,
    ];
  }
  return [];
}

// Collect captured names (free variables) from statements.
function collectCapturesInStatements(statements: Statement[], symbols: SymbolTable): void {
  const visitExpression = (expression: Expr): void => {
    switch (expression.kind) {
      case "name":
        symbols.resolve(expression.name);
        return;
      case "literal":
        return;
      case "tuple":
      case "list":
      case "set":
        expression.items.forEach(visitExpression);
        return;
      case "dict":
        for (const [key, value] of expression.items) {
          visitExpression(key);
          visitExpression(value);
        }
        return;
      case "unary":
        visitExpression(expression.operand);
        return;
      case "binary":
        visitExpression(expression.left);
        visitExpression(expression.right);
        return;
      case "compare":
        visitExpression(expression.first);
        expression.rest.forEach((item) => visitExpression(item.right));
        return;
      case "conditional":
        visitExpression(expression.whenTrue);
        visitExpression(expression.condition);
        visitExpression(expression.whenFalse);
        return;
      case "lambda":
        return;
      case "await":
        visitExpression(expression.value);
        return;
      case "yield":
        if (expression.value !== undefined) visitExpression(expression.value);
        return;
      case "call":
        visitExpression(expression.callee);
        expression.args.forEach((argument) => visitExpression(argument.value));
        return;
      case "attribute":
        visitExpression(expression.receiver);
        return;
      case "index":
        visitExpression(expression.receiver);
        visitExpression(expression.index);
        return;
      case "slice":
        visitExpression(expression.receiver);
        if (expression.start !== undefined) visitExpression(expression.start);
        if (expression.stop !== undefined) visitExpression(expression.stop);
        if (expression.step !== undefined) visitExpression(expression.step);
        return;
      case "fstring":
        expression.parts.forEach((part) => {
          if (typeof part !== "string") visitExpression(part);
        });
        return;
      case "comprehension":
        expression.clauses.forEach((clause) => {
          visitExpression(clause.iterable);
          clause.filters.forEach(visitExpression);
        });
        if (expression.key !== undefined) visitExpression(expression.key);
        if (expression.element !== undefined) visitExpression(expression.element);
        return;
    }
  };

  for (const statement of statements) {
    switch (statement.kind) {
      case "expression": visitExpression(statement.expression); break;
      case "assign":
        statement.targets.forEach(visitExpression);
        visitExpression(statement.value);
        break;
      case "annotate":
        visitExpression(statement.target);
        if (statement.value !== undefined) visitExpression(statement.value);
        break;
      case "augmentedAssign":
        visitExpression(statement.target);
        visitExpression(statement.value);
        break;
      case "delete":
        statement.targets.forEach(visitExpression);
        break;
      case "function":
      case "class":
        break;
      case "if":
      case "while":
        visitExpression(statement.condition);
        break;
      case "switch":
        visitExpression(statement.subject);
        statement.cases.forEach((clause) => visitExpression(clause.value));
        break;
      case "for":
        visitExpression(statement.iterable);
        break;
      case "return":
      case "raise":
        if (statement.value !== undefined) visitExpression(statement.value);
        break;
      case "assert":
        visitExpression(statement.condition);
        if (statement.message !== undefined) visitExpression(statement.message);
        break;
      case "try":
        statement.handlers.forEach((handler) => {
          if (handler.type !== undefined) visitExpression(handler.type);
        });
        break;
      case "import":
      case "fromImport":
      case "break":
      case "continue":
      case "pass":
      case "scope":
        break;
    }
    for (const child of nestedStatements(statement)) collectCapturesInStatements([child], symbols);
  }
}

// Validate that await only appears inside async functions.
function validateAwaitInStatements(statements: Statement[], allowAwait: boolean): void {
  const visitExpression = (expression: Expr): void => {
    switch (expression.kind) {
      case "await":
        if (!allowAwait) throw new SyntaxError("await outside an async function", expression);
        visitExpression(expression.value);
        return;
      case "yield":
        if (expression.value !== undefined) visitExpression(expression.value);
        return;
      case "literal":
      case "name":
        return;
      case "tuple":
      case "list":
      case "set":
        expression.items.forEach(visitExpression);
        return;
      case "dict":
        for (const [key, value] of expression.items) {
          visitExpression(key);
          visitExpression(value);
        }
        return;
      case "unary":
        visitExpression(expression.operand);
        return;
      case "binary":
        visitExpression(expression.left);
        visitExpression(expression.right);
        return;
      case "compare":
        visitExpression(expression.first);
        expression.rest.forEach((item) => visitExpression(item.right));
        return;
      case "conditional":
        visitExpression(expression.whenTrue);
        visitExpression(expression.condition);
        visitExpression(expression.whenFalse);
        return;
      case "lambda":
        return;
      case "call":
        visitExpression(expression.callee);
        expression.args.forEach((argument) => visitExpression(argument.value));
        return;
      case "attribute":
        visitExpression(expression.receiver);
        return;
      case "index":
        visitExpression(expression.receiver);
        visitExpression(expression.index);
        return;
      case "slice":
        visitExpression(expression.receiver);
        if (expression.start !== undefined) visitExpression(expression.start);
        if (expression.stop !== undefined) visitExpression(expression.stop);
        if (expression.step !== undefined) visitExpression(expression.step);
        return;
      case "fstring":
        expression.parts.forEach((part) => {
          if (typeof part !== "string") visitExpression(part);
        });
        return;
      case "comprehension":
        expression.clauses.forEach((clause) => {
          visitExpression(clause.iterable);
          clause.filters.forEach(visitExpression);
        });
        if (expression.key !== undefined) visitExpression(expression.key);
        if (expression.element !== undefined) visitExpression(expression.element);
        return;
    }
  };
  for (const statement of statements) {
    switch (statement.kind) {
      case "expression": visitExpression(statement.expression); break;
      case "assign":
        statement.targets.forEach(visitExpression);
        visitExpression(statement.value);
        break;
      case "annotate":
        visitExpression(statement.target);
        if (statement.value !== undefined) visitExpression(statement.value);
        break;
      case "augmentedAssign":
        visitExpression(statement.target);
        visitExpression(statement.value);
        break;
      case "delete":
        statement.targets.forEach(visitExpression);
        break;
      case "if":
      case "while":
        visitExpression(statement.condition);
        break;
      case "for":
        visitExpression(statement.iterable);
        break;
      case "return":
      case "raise":
        if (statement.value !== undefined) visitExpression(statement.value);
        break;
      case "assert":
        visitExpression(statement.condition);
        if (statement.message !== undefined) visitExpression(statement.message);
        break;
      case "try":
        statement.handlers.forEach((handler) => {
          if (handler.type !== undefined) visitExpression(handler.type);
        });
        break;
      case "function":
      case "class":
      case "import":
      case "fromImport":
      case "break":
      case "continue":
      case "pass":
      case "scope":
        break;
    }
    validateAwaitInStatements(nestedStatements(statement), allowAwait);
  }
}

// Validate that yield only appears inside generator functions.
function validateYieldInStatements(statements: Statement[], inFunction: boolean, allowYield: boolean): void {
  const visitExpression = (expression: Expr): void => {
    switch (expression.kind) {
      case "yield":
        if (!inFunction) throw new SyntaxError("yield outside function", expression);
        if (!allowYield) throw new SyntaxError("yield inside a non-generator function", expression);
        if (expression.value !== undefined) visitExpression(expression.value);
        return;
      case "await":
        visitExpression(expression.value);
        return;
      case "literal":
      case "name":
        return;
      case "tuple":
      case "list":
      case "set":
        expression.items.forEach(visitExpression);
        return;
      case "dict":
        for (const [key, value] of expression.items) {
          visitExpression(key);
          visitExpression(value);
        }
        return;
      case "unary":
        visitExpression(expression.operand);
        return;
      case "binary":
        visitExpression(expression.left);
        visitExpression(expression.right);
        return;
      case "compare":
        visitExpression(expression.first);
        expression.rest.forEach((item) => visitExpression(item.right));
        return;
      case "conditional":
        visitExpression(expression.whenTrue);
        visitExpression(expression.condition);
        visitExpression(expression.whenFalse);
        return;
      case "lambda":
        return;
      case "call":
        visitExpression(expression.callee);
        expression.args.forEach((argument) => visitExpression(argument.value));
        return;
      case "attribute":
        visitExpression(expression.receiver);
        return;
      case "index":
        visitExpression(expression.receiver);
        visitExpression(expression.index);
        return;
      case "slice":
        visitExpression(expression.receiver);
        if (expression.start !== undefined) visitExpression(expression.start);
        if (expression.stop !== undefined) visitExpression(expression.stop);
        if (expression.step !== undefined) visitExpression(expression.step);
        return;
      case "fstring":
        expression.parts.forEach((part) => {
          if (typeof part !== "string") visitExpression(part);
        });
        return;
      case "comprehension":
        expression.clauses.forEach((clause) => {
          visitExpression(clause.iterable);
          clause.filters.forEach(visitExpression);
        });
        if (expression.key !== undefined) visitExpression(expression.key);
        if (expression.element !== undefined) visitExpression(expression.element);
        return;
    }
  };
  for (const statement of statements) {
    switch (statement.kind) {
      case "expression": visitExpression(statement.expression); break;
      case "assign":
        statement.targets.forEach(visitExpression);
        visitExpression(statement.value);
        break;
      case "annotate":
        visitExpression(statement.target);
        if (statement.value !== undefined) visitExpression(statement.value);
        break;
      case "augmentedAssign":
        visitExpression(statement.target);
        visitExpression(statement.value);
        break;
      case "delete":
        statement.targets.forEach(visitExpression);
        break;
      case "if":
      case "while":
        visitExpression(statement.condition);
        break;
      case "for":
        visitExpression(statement.iterable);
        break;
      case "return":
      case "raise":
        if (statement.value !== undefined) visitExpression(statement.value);
        break;
      case "assert":
        visitExpression(statement.condition);
        if (statement.message !== undefined) visitExpression(statement.message);
        break;
      case "try":
        statement.handlers.forEach((handler) => {
          if (handler.type !== undefined) visitExpression(handler.type);
        });
        break;
      case "function":
      case "class":
      case "import":
      case "fromImport":
      case "break":
      case "continue":
      case "pass":
      case "scope":
        break;
    }
    for (const child of nestedStatements(statement)) validateYieldInStatements([child], inFunction, allowYield);
  }
}
