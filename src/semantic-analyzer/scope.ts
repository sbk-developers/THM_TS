import type { Statement } from "../parser/ast.js";
import { SyntaxError } from "../errors/errors.js";

export function collectScopeDeclarations(
  statements: Statement[],
  onDeclaration: (scope: "global" | "nonlocal", name: string) => void,
): void {
  const visit = (items: Statement[]): void => {
    for (const statement of items) {
      if (statement.kind === "scope") {
        for (const name of statement.names) onDeclaration(statement.scope, name);
      } else if (statement.kind === "switch") {
        visit(statement.cases.flatMap((clause) => clause.body));
        visit(statement.defaultBody);
      } else if (statement.kind === "if" || statement.kind === "while" || statement.kind === "for") {
        visit(statement.body);
        visit(statement.otherwise);
      } else if (statement.kind === "try") {
        visit(statement.body);
        for (const handler of statement.handlers) visit(handler.body);
        for (const handler of statement.handlers) visit(handler.body);
        visit(statement.otherwise);
        visit(statement.finalBody);
      }
    }
  };
  visit(statements);
}

export function collectLocalNames(
  statements: Statement[],
  parameters: string[],
  globals: ReadonlySet<string>,
  nonlocals: ReadonlySet<string>,
): Set<string> {
  const names = new Set(parameters);
  const visitTarget = (target: StatementTarget): void => {
    if (target.kind === "name") names.add(target.name);
    else if (target.kind === "tuple" || target.kind === "list") {
      for (const item of target.items) visitTarget(item);
    }
  };
  const visit = (items: Statement[]): void => {
    for (const statement of items) {
      if (statement.kind === "assign") {
        for (const target of statement.targets) visitTarget(target);
      } else if (statement.kind === "augmentedAssign") {
        visitTarget(statement.target);
      } else if (statement.kind === "annotate" && statement.value !== undefined) {
        visitTarget(statement.target);
      } else if (statement.kind === "function" || statement.kind === "class") {
        names.add(statement.name);
      } else if (statement.kind === "import") {
        names.add(statement.alias ?? statement.module.split(".")[0]!);
      } else if (statement.kind === "fromImport") {
        for (const item of statement.names) names.add(item.alias ?? item.name);
      } else if (statement.kind === "for") {
        visitTarget(statement.target);
        visit(statement.body);
        visit(statement.otherwise);
      } else if (statement.kind === "delete") {
        for (const target of statement.targets) visitTarget(target);
      } else if (statement.kind === "switch") {
        visit(statement.cases.flatMap((clause) => clause.body));
        visit(statement.defaultBody);
      } else if (statement.kind === "if" || statement.kind === "while") {
        visit(statement.body);
        visit(statement.otherwise);
      } else if (statement.kind === "try") {
        visit(statement.body);
        for (const handler of statement.handlers) {
          if (handler.name !== undefined) names.add(handler.name);
          visit(handler.body);
        }
        visit(statement.otherwise);
        visit(statement.finalBody);
      }
    }
  };
  visit(statements);
  for (const name of globals) names.delete(name);
  for (const name of nonlocals) names.delete(name);
  return names;
}

type StatementTarget = Extract<Statement, { kind: "assign" }>["targets"][number];

export function validateAssignmentTarget(target: StatementTarget, line: number, column: number): void {
  if (
    target.kind === "name" ||
    target.kind === "attribute" ||
    target.kind === "index" ||
    target.kind === "slice"
  ) return;
  if (target.kind === "tuple" || target.kind === "list") {
    for (const item of target.items) validateAssignmentTarget(item, line, column);
    return;
  }
  throw new SyntaxError("Invalid assignment target", { line, column });
}

export function validateControlStatements(
  statements: Statement[],
  isFunction: boolean,
  loopDepth = 0,
): void {
  for (const statement of statements) {
    if ((statement.kind === "break" || statement.kind === "continue") && loopDepth === 0) {
      throw new SyntaxError(`${statement.kind} outside a loop`, statement);
    }
    if (statement.kind === "return" && !isFunction) {
      throw new SyntaxError("return outside a function", statement);
    }
    if (statement.kind === "function" || statement.kind === "class") continue;
    if (statement.kind === "while" || statement.kind === "for") {
      validateControlStatements(statement.body, isFunction, loopDepth + 1);
      validateControlStatements(statement.otherwise, isFunction, loopDepth);
    } else if (statement.kind === "switch") {
      for (const clause of statement.cases) validateControlStatements(clause.body, isFunction, loopDepth);
      validateControlStatements(statement.defaultBody, isFunction, loopDepth);
    } else if (statement.kind === "if") {
      validateControlStatements(statement.body, isFunction, loopDepth);
      validateControlStatements(statement.otherwise, isFunction, loopDepth);
    } else if (statement.kind === "try") {
      validateControlStatements(statement.body, isFunction, loopDepth);
      for (const handler of statement.handlers) validateControlStatements(handler.body, isFunction, loopDepth);
      validateControlStatements(statement.otherwise, isFunction, loopDepth);
      validateControlStatements(statement.finalBody, isFunction, loopDepth);
    }
  }
}
