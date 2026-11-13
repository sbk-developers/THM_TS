/**
 * Tolerant THM source analyzer for the LSP.
 *
 * Extracts the information language features need from a source file without
 * rejecting incomplete code:
 *   - top-level and nested function/class definitions (with parameter spans)
 *   - variable assignments (scope-aware: global / local)
 *   - imports (`import x`, `import x as y`, `from x import a, b`)
 *   - attribute accesses (`obj.member`)
 *   - calls with argument names (`f(x=1, **kwargs)`)
 *   - references to every name (for find-references and rename)
 */

import { isKeyword, tokenize, type Token } from "./lexer.js";

export interface Definition {
  kind:
    | "function"
    | "class"
    | "variable"
    | "parameter"
    | "import"
    | "importMember"
    | "exception"
    | "builtin";
  name: string;
  line: number;
  column: number;
  length: number;
  container?: string | undefined;
  parameters?: ParameterInfo[];
  detail?: string;
}

export interface ParameterInfo {
  name: string;
  kind: "positional" | "vararg" | "keywordOnly" | "kwarg";
  hasDefault: boolean;
}

export interface ImportInfo {
  module: string;
  alias?: string;
  members: Array<{ name: string; alias?: string; column: number }>;
  line: number;
  fromImport: boolean;
}

export interface Reference {
  name: string;
  line: number;
  column: number;
  length: number;
  container?: string | undefined;
  /** Attribute access like `obj.name`. */
  isAttribute: boolean;
}

export interface CallInfo {
  calleeName: string;
  line: number;
  column: number;
  argNames: string[];
}

export interface DocumentAnalysis {
  definitions: Definition[];
  imports: ImportInfo[];
  references: Reference[];
  calls: CallInfo[];
}

interface PendingKwarg {
  parenDepth: number;
  argNames: string[];
  calleeName: string;
  calleeLine: number;
  calleeColumn: number;
}

/** Parse the source into a lightweight semantic index. */
export function analyze(source: string): DocumentAnalysis {
  const tokens = tokenize(source);
  const definitions: Definition[] = [];
  const imports: ImportInfo[] = [];
  const references: Reference[] = [];
  const calls: CallInfo[] = [];

  let index = 0;
  const classStack: string[] = [];
  const functionStack: string[] = [];
  let braceDepth = 0;
  const openParens: PendingKwarg[] = [];

  const peek = (ahead = 0): Token =>
    tokens[Math.min(index + ahead, tokens.length - 1)];
  const isOperator = (token: Token, value: string): boolean =>
    token.kind === "operator" && token.value === value;

  const containerName = (): string | undefined =>
    functionStack.length > 0
      ? functionStack[functionStack.length - 1]
      : classStack[classStack.length - 1];

  const pushReference = (
    name: string,
    token: Token,
    isAttribute: boolean,
  ): void => {
    if (isKeyword(name)) return;
    references.push({
      name,
      line: token.line,
      column: token.column,
      length: token.length,
      container: containerName(),
      isAttribute,
    });
  };

  while (index < tokens.length) {
    const token = tokens[index];

    if (isOperator(token, "{")) braceDepth++;
    if (isOperator(token, "}")) braceDepth = Math.max(0, braceDepth - 1);

    // --- function/class definitions -------------------------------------
    if (
      token.kind === "keyword" &&
      token.value === "def" &&
      peek(1).kind === "identifier"
    ) {
      const nameToken = peek(1);
      const container = classStack[classStack.length - 1];
      const parameters: ParameterInfo[] = [];
      let detail = `def ${nameToken.value}`;
      // Scan the parameter list.
      let cursor = index + 2;
      if (isOperator(tokens[cursor], "(")) {
        cursor++;
        let depth = 1;
        let expectingName = true;
        while (cursor < tokens.length && depth > 0) {
          const parameterToken = tokens[cursor];
          if (isOperator(parameterToken, "(")) depth++;
          if (isOperator(parameterToken, ")")) {
            depth--;
            if (depth === 0) break;
          }
          if (
            parameterToken.kind === "operator" &&
            (parameterToken.value === "/" || parameterToken.value === "*")
          ) {
            // Bare markers: `/` positional-only divider and a lone `*` that is
            // not part of `*args` / `**kwargs`. The identifier branch below
            // classifies `*args`/`**kwargs` by inspecting its preceding token.
            cursor++;
            continue;
          }
          if (
            parameterToken.kind === "identifier" &&
            expectingName &&
            depth === 1
          ) {
            const next = tokens[cursor + 1];
            const hasDefault = next.kind === "operator" && next.value === "=";
            const isVararg =
              tokens[cursor - 1]?.kind === "operator" &&
              tokens[cursor - 1]?.value === "*";
            const isKwarg =
              tokens[cursor - 1]?.kind === "operator" &&
              tokens[cursor - 1]?.value === "**";
            const keywordOnly = parameters.some(
              (parameter) => parameter.kind === "vararg",
            );
            parameters.push({
              name: parameterToken.value,
              kind: isKwarg
                ? "kwarg"
                : isVararg
                  ? "vararg"
                  : keywordOnly
                    ? "keywordOnly"
                    : "positional",
              hasDefault,
            });
            if (isKwarg) detail += ` **${parameterToken.value}`;
            else if (isVararg) detail += ` *${parameterToken.value}`;
            else
              detail +=
                (detail.includes("(") ? ", " : "(") + parameterToken.value;
            expectingName = false;
          }
          if (isOperator(parameterToken, ",")) expectingName = true;
          if (hasDefaultAfter(tokens, cursor))
            skipDefaultValue(tokens, cursor, (next) => {
              cursor = next;
            });
          cursor++;
        }
        detail += ")";
      }
      definitions.push({
        kind: "function",
        name: nameToken.value,
        line: nameToken.line,
        column: nameToken.column,
        length: nameToken.length,
        container,
        parameters,
        detail,
      });
      functionStack.push(nameToken.value);
      index = cursor > index ? cursor : index + 2;
      continue;
    }

    if (
      token.kind === "keyword" &&
      token.value === "class" &&
      peek(1).kind === "identifier"
    ) {
      const nameToken = peek(1);
      definitions.push({
        kind: "class",
        name: nameToken.value,
        line: nameToken.line,
        column: nameToken.column,
        length: nameToken.length,
        container: classStack[classStack.length - 1],
      });
      classStack.push(nameToken.value);
      index += 2;
      continue;
    }

    // --- imports ----------------------------------------------------------
    if (
      token.kind === "keyword" &&
      token.value === "import" &&
      peek(1).kind === "identifier"
    ) {
      const moduleToken = peek(1);
      const alias =
        isKeyword(peek(2).value) &&
        peek(2).value === "as" &&
        peek(3).kind === "identifier"
          ? peek(3).value
          : undefined;
      const dotted = collectDottedName(tokens, index + 1);
      imports.push({
        module: dotted.name,
        alias: alias ?? undefined,
        members: [],
        line: moduleToken.line,
        fromImport: false,
      });
      definitions.push({
        kind: "import",
        name: alias ?? dotted.name.split(".")[0],
        line: moduleToken.line,
        column: moduleToken.column,
        length: moduleToken.length,
        detail: `import ${dotted.name}`,
      });
      index += dotted.endIndex - index;
      continue;
    }

    if (
      token.kind === "keyword" &&
      token.value === "from" &&
      peek(1).kind === "identifier"
    ) {
      const dotted = collectDottedName(tokens, index + 1);
      const relative = token.line;
      if (
        peek(dotted.endIndex - index).value === "import" ||
        isOperator(peek(dotted.endIndex - index), "import")
      ) {
        let memberIndex = dotted.endIndex + 1;
        const members: Array<{ name: string; alias?: string; column: number }> =
          [];
        while (
          memberIndex < tokens.length &&
          tokens[memberIndex].kind !== "newline" &&
          tokens[memberIndex].kind !== "eof" &&
          !isOperator(tokens[memberIndex], "}")
        ) {
          const memberToken = tokens[memberIndex];
          if (
            memberToken.kind === "identifier" ||
            memberToken.kind === "keyword"
          ) {
            const alias =
              tokens[memberIndex + 1]?.value === "as" &&
              tokens[memberIndex + 2]?.kind === "identifier"
                ? tokens[memberIndex + 2].value
                : undefined;
            members.push({
              name: memberToken.value,
              alias: alias ?? undefined,
              column: memberToken.column,
            });
            definitions.push({
              kind: "importMember",
              name: alias ?? memberToken.value,
              line: memberToken.line,
              column: memberToken.column,
              length: memberToken.length,
              detail: `from ${dotted.name} import ${memberToken.value}`,
            });
            memberIndex += alias !== undefined ? 3 : 1;
            if (isOperator(tokens[memberIndex], ",")) memberIndex++;
          } else {
            memberIndex++;
          }
        }
        imports.push({
          module: dotted.name,
          members,
          line: relative,
          fromImport: true,
        });
        index = memberIndex;
        continue;
      }
    }

    // --- calls ------------------------------------------------------------
    if (isOperator(token, "(")) {
      const previous = tokens[index - 1];
      const calleeName =
        previous !== undefined &&
        (previous.kind === "identifier" || previous.kind === "keyword")
          ? previous.value
          : "";
      openParens.push({
        parenDepth: braceDepth,
        argNames: [],
        calleeName,
        calleeLine: previous?.line ?? token.line,
        calleeColumn: previous?.column ?? token.column,
      });
      if (calleeName !== "") pushReference(calleeName, previous, false);
      index++;
      continue;
    }

    if (isOperator(token, ")") && openParens.length > 0) {
      const pending = openParens.pop()!;
      if (pending.calleeName !== "" && pending.argNames.length > 0) {
        calls.push({
          calleeName: pending.calleeName,
          line: pending.calleeLine,
          column: pending.calleeColumn,
          argNames: pending.argNames,
        });
      }
      index++;
      continue;
    }

    // Keyword argument names inside calls: `name=` where `=` is not comparison.
    if (
      token.kind === "identifier" &&
      peek(1).kind === "operator" &&
      peek(1).value === "=" &&
      openParens.length > 0 &&
      openParens[openParens.length - 1].parenDepth === braceDepth
    ) {
      openParens[openParens.length - 1].argNames.push(token.value);
      index += 2;
      continue;
    }

    // **kwargs unpacking in a call.
    if (
      token.kind === "operator" &&
      token.value === "**" &&
      peek(1).kind === "identifier" &&
      openParens.length > 0
    ) {
      openParens[openParens.length - 1].argNames.push(`**${peek(1).value}`);
      pushReference(peek(1).value, peek(1), false);
      index += 2;
      continue;
    }

    // --- assignments and plain names --------------------------------------
    if (token.kind === "identifier") {
      const next = peek(1);
      if (next.kind === "operator" && next.value === "=") {
        definitions.push({
          kind: "variable",
          name: token.value,
          line: token.line,
          column: token.column,
          length: token.length,
          container: containerName(),
        });
      }
      pushReference(token.value, token, false);
      index++;
      continue;
    }

    // Attribute accesses: `receiver.name`.
    if (
      token.kind === "operator" &&
      token.value === "." &&
      peek(1).kind === "identifier"
    ) {
      pushReference(peek(1).value, peek(1), true);
      index += 2;
      continue;
    }

    index++;
  }

  return { definitions, imports, references, calls };
}

function hasDefaultAfter(tokens: Token[], cursor: number): boolean {
  return (
    tokens[cursor + 1]?.kind === "operator" && tokens[cursor + 1]?.value === "="
  );
}

/** Skip a default value expression starting at the `=` after `cursor`. */
function skipDefaultValue(
  tokens: Token[],
  cursor: number,
  setCursor: (next: number) => void,
): void {
  let scan = cursor + 2;
  let depth = 0;
  while (scan < tokens.length) {
    const token = tokens[scan];
    if (token.kind === "operator") {
      if ("([{".includes(token.value)) depth++;
      if (")]}".includes(token.value)) {
        if (depth === 0) break;
        depth--;
      }
      if (token.value === "," && depth === 0) break;
    }
    if (token.kind === "newline") break;
    scan++;
  }
  setCursor(scan - 1);
}

/** Collect a dotted module path like `a.b.c` starting at `startIndex`. */
function collectDottedName(
  tokens: Token[],
  startIndex: number,
): { name: string; endIndex: number } {
  let index = startIndex;
  let name = tokens[startIndex]?.value ?? "";
  while (
    tokens[index + 1]?.value === "." &&
    tokens[index + 2]?.kind === "identifier"
  ) {
    name += `.${tokens[index + 2].value}`;
    index += 2;
  }
  return { name, endIndex: index + 1 };
}
