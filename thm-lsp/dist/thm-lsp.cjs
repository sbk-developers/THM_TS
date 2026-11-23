#!/usr/bin/env node
#!/usr/bin/env node
"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// src/rpc.ts
function sendMessage(output, message) {
  const payload = JSON.stringify(message);
  output.write(`Content-Length: ${Buffer.byteLength(payload, "utf8")}\r
\r
${payload}`, "utf8");
}
function serveStdio(sink) {
  let buffer = Buffer.alloc(0);
  const tryExtract = () => {
    for (; ; ) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = buffer.slice(0, headerEnd).toString("utf8");
      const lengthText = /Content-Length:\s*(\d+)/i.exec(header)?.[1];
      if (lengthText === void 0) {
        buffer = buffer.slice(headerEnd + 4);
        continue;
      }
      const contentLength = Number(lengthText);
      const bodyStart = headerEnd + 4;
      if (buffer.length < bodyStart + contentLength) return;
      const body = buffer.slice(bodyStart, bodyStart + contentLength).toString("utf8");
      buffer = buffer.slice(bodyStart + contentLength);
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch (error) {
        console.error(`[thm-lsp] bad message: ${String(error)}`);
        continue;
      }
      try {
        if (parsed !== void 0) sink.onMessage(parsed);
      } catch (error) {
        console.error(`[thm-lsp] handler error: ${error instanceof Error ? error.stack : String(error)}`);
      }
    }
  };
  process.stdin.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    tryExtract();
  });
  process.stdin.on("end", () => process.exit(0));
  process.stdin.on("close", () => process.exit(0));
  process.stdin.resume();
}

// src/lexer.ts
var KEYWORDS = [
  "and",
  "as",
  "assert",
  "async",
  "await",
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
  "case",
  "default",
  "switch",
  "try",
  "while",
  "yield"
];
var OPERATORS = [
  "**=",
  ":=",
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
  "!",
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
  "@"
];
var CONTINUING = /* @__PURE__ */ new Set([
  ",",
  ":",
  ".",
  ":=",
  "=",
  "+",
  "-",
  "*",
  "/",
  "//",
  "%",
  "**",
  "<<",
  ">>",
  "==",
  "!=",
  "<",
  "<=",
  ">",
  ">=",
  "+=",
  "-=",
  "*=",
  "/=",
  "//=",
  "%=",
  "**=",
  "&",
  "|",
  "^",
  "&=",
  "|=",
  "^=",
  "<<=",
  ">>=",
  "->",
  "and",
  "or",
  "not",
  "is",
  "in"
]);
var TWO_CHAR_QUOTE_PREFIXES = /* @__PURE__ */ new Set(["rb", "br", "fr", "rf"]);
var ONE_CHAR_PREFIXES = /* @__PURE__ */ new Set(["r", "b", "f"]);
function isKeyword(word) {
  return KEYWORDS.includes(word);
}
function push(state, kind, startOffset, startLine, startColumn, endOffset) {
  const end = endOffset ?? state.pos;
  state.tokens.push({
    kind,
    value: state.source.slice(startOffset, end),
    line: startLine,
    column: startColumn,
    offset: startOffset,
    length: end - startOffset
  });
}
function advance(state, count = 1) {
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
function tryIdentifierOrPrefixedString(state) {
  const match = /^[A-Za-z_]\w*/.exec(state.source.slice(state.pos));
  if (match === null) return false;
  const word = match[0];
  const rest = state.source.slice(state.pos + word.length).slice(0, 3);
  const lower = word.toLowerCase();
  let prefixLength = 0;
  let quote = "";
  if (rest.startsWith('"""') || rest.startsWith("'''")) {
    if (ONE_CHAR_PREFIXES.has(lower)) prefixLength = 1;
    quote = rest.slice(0, 3);
  } else if (rest[0] === '"' || rest[0] === "'") {
    if (ONE_CHAR_PREFIXES.has(lower) || TWO_CHAR_QUOTE_PREFIXES.has(lower.slice(0, 2))) {
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
function lexString(state, withPrefix) {
  const startOffset = state.pos;
  const startLine = state.line;
  const startColumn = state.column;
  advance(state, withPrefix.length);
  const quote = state.source[state.pos] ?? '"';
  const triple = state.source.slice(state.pos, state.pos + 3) === quote.repeat(3);
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
      push(state, "error", startOffset, startLine, startColumn);
      return;
    }
    advance(state);
  }
  push(state, "error", startOffset, startLine, startColumn);
}
function tokenize(source) {
  const state = {
    source,
    pos: 0,
    line: 0,
    column: 0,
    tokens: [],
    parenDepth: 0,
    indentStack: [0]
  };
  let atLineStart = true;
  while (state.pos < source.length) {
    const char = state.source[state.pos];
    if (char === " " || char === "	" || char === "\r") {
      advance(state);
      continue;
    }
    if (char === "\n") {
      let previous;
      for (let back = state.tokens.length - 1; back >= 0; back--) {
        if (state.tokens[back].kind !== "comment") {
          previous = state.tokens[back];
          break;
        }
      }
      const wasOpen = state.parenDepth > 0 || previous !== void 0 && (previous.kind === "operator" || previous.kind === "keyword") && CONTINUING.has(previous.value);
      advance(state);
      if (!wasOpen)
        state.tokens.push({
          kind: "newline",
          value: "\n",
          line: state.line - 1,
          column: 0,
          offset: state.pos - 1,
          length: 1
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
    }
    if (char === "(" || char === "[") state.parenDepth++;
    if (char === ")" || char === "]")
      state.parenDepth = Math.max(0, state.parenDepth - 1);
    if (char === '"' || char === "'") {
      lexString(state, "");
      continue;
    }
    if (tryIdentifierOrPrefixedString(state)) continue;
    const digitMatch = /^(0[xXbBoO][0-9a-fA-F_]+|\d[\d_]*(\.\d[\d_]*)?([eE][+-]?\d+)?)/.exec(
      state.source.slice(state.pos)
    );
    if (digitMatch !== null && /[0-9]/.test(char)) {
      const numStart = state.pos;
      const numLine = state.line;
      const numColumn = state.column;
      advance(state, digitMatch[0].length);
      push(state, "number", numStart, numLine, numColumn, state.pos);
      continue;
    }
    const operator = OPERATORS.find(
      (candidate) => state.source.startsWith(candidate, state.pos)
    );
    if (operator !== void 0) {
      const opStart = state.pos;
      const opLine = state.line;
      const opColumn = state.column;
      advance(state, operator.length);
      push(state, "operator", opStart, opLine, opColumn, state.pos);
      continue;
    }
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
    length: 0
  });
  return state.tokens;
}

// src/analyzer.ts
function analyze(source) {
  const tokens = tokenize(source);
  const definitions = [];
  const imports = [];
  const references = [];
  const calls = [];
  let index = 0;
  const classStack = [];
  const functionStack = [];
  let braceDepth = 0;
  const openParens = [];
  const peek = (ahead = 0) => tokens[Math.min(index + ahead, tokens.length - 1)];
  const isOperator = (token, value) => token.kind === "operator" && token.value === value;
  const containerName = () => functionStack.length > 0 ? functionStack[functionStack.length - 1] : classStack[classStack.length - 1];
  const pushReference = (name, token, isAttribute) => {
    if (isKeyword(name)) return;
    references.push({
      name,
      line: token.line,
      column: token.column,
      length: token.length,
      container: containerName(),
      isAttribute
    });
  };
  while (index < tokens.length) {
    const token = tokens[index];
    if (isOperator(token, "{")) braceDepth++;
    if (isOperator(token, "}")) braceDepth = Math.max(0, braceDepth - 1);
    if (token.kind === "keyword" && token.value === "def" && peek(1).kind === "identifier") {
      const nameToken = peek(1);
      const container = classStack[classStack.length - 1];
      const parameters = [];
      let detail = `def ${nameToken.value}`;
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
          if (parameterToken.kind === "operator" && (parameterToken.value === "/" || parameterToken.value === "*")) {
            cursor++;
            continue;
          }
          if (parameterToken.kind === "identifier" && expectingName && depth === 1) {
            const next = tokens[cursor + 1];
            const hasDefault = next.kind === "operator" && next.value === "=";
            const isVararg = tokens[cursor - 1]?.kind === "operator" && tokens[cursor - 1]?.value === "*";
            const isKwarg = tokens[cursor - 1]?.kind === "operator" && tokens[cursor - 1]?.value === "**";
            const keywordOnly = parameters.some(
              (parameter) => parameter.kind === "vararg"
            );
            parameters.push({
              name: parameterToken.value,
              kind: isKwarg ? "kwarg" : isVararg ? "vararg" : keywordOnly ? "keywordOnly" : "positional",
              hasDefault
            });
            if (isKwarg) detail += ` **${parameterToken.value}`;
            else if (isVararg) detail += ` *${parameterToken.value}`;
            else
              detail += (detail.includes("(") ? ", " : "(") + parameterToken.value;
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
        detail
      });
      functionStack.push(nameToken.value);
      index = cursor > index ? cursor : index + 2;
      continue;
    }
    if (token.kind === "keyword" && token.value === "class" && peek(1).kind === "identifier") {
      const nameToken = peek(1);
      definitions.push({
        kind: "class",
        name: nameToken.value,
        line: nameToken.line,
        column: nameToken.column,
        length: nameToken.length,
        container: classStack[classStack.length - 1]
      });
      classStack.push(nameToken.value);
      index += 2;
      continue;
    }
    if (token.kind === "keyword" && token.value === "import" && peek(1).kind === "identifier") {
      const moduleToken = peek(1);
      const alias = isKeyword(peek(2).value) && peek(2).value === "as" && peek(3).kind === "identifier" ? peek(3).value : void 0;
      const dotted = collectDottedName(tokens, index + 1);
      imports.push({
        module: dotted.name,
        alias: alias ?? void 0,
        members: [],
        line: moduleToken.line,
        fromImport: false
      });
      definitions.push({
        kind: "import",
        name: alias ?? dotted.name.split(".")[0],
        line: moduleToken.line,
        column: moduleToken.column,
        length: moduleToken.length,
        detail: `import ${dotted.name}`
      });
      index += dotted.endIndex - index;
      continue;
    }
    if (token.kind === "keyword" && token.value === "from" && peek(1).kind === "identifier") {
      const dotted = collectDottedName(tokens, index + 1);
      const relative = token.line;
      if (peek(dotted.endIndex - index).value === "import" || isOperator(peek(dotted.endIndex - index), "import")) {
        let memberIndex = dotted.endIndex + 1;
        const members = [];
        while (memberIndex < tokens.length && tokens[memberIndex].kind !== "newline" && tokens[memberIndex].kind !== "eof" && !isOperator(tokens[memberIndex], "}")) {
          const memberToken = tokens[memberIndex];
          if (memberToken.kind === "identifier" || memberToken.kind === "keyword") {
            const alias = tokens[memberIndex + 1]?.value === "as" && tokens[memberIndex + 2]?.kind === "identifier" ? tokens[memberIndex + 2].value : void 0;
            members.push({
              name: memberToken.value,
              alias: alias ?? void 0,
              column: memberToken.column
            });
            definitions.push({
              kind: "importMember",
              name: alias ?? memberToken.value,
              line: memberToken.line,
              column: memberToken.column,
              length: memberToken.length,
              detail: `from ${dotted.name} import ${memberToken.value}`
            });
            memberIndex += alias !== void 0 ? 3 : 1;
            if (isOperator(tokens[memberIndex], ",")) memberIndex++;
          } else {
            memberIndex++;
          }
        }
        imports.push({
          module: dotted.name,
          members,
          line: relative,
          fromImport: true
        });
        index = memberIndex;
        continue;
      }
    }
    if (isOperator(token, "(")) {
      const previous = tokens[index - 1];
      const calleeName = previous !== void 0 && (previous.kind === "identifier" || previous.kind === "keyword") ? previous.value : "";
      openParens.push({
        parenDepth: braceDepth,
        argNames: [],
        calleeName,
        calleeLine: previous?.line ?? token.line,
        calleeColumn: previous?.column ?? token.column
      });
      if (calleeName !== "") pushReference(calleeName, previous, false);
      index++;
      continue;
    }
    if (isOperator(token, ")") && openParens.length > 0) {
      const pending = openParens.pop();
      if (pending.calleeName !== "" && pending.argNames.length > 0) {
        calls.push({
          calleeName: pending.calleeName,
          line: pending.calleeLine,
          column: pending.calleeColumn,
          argNames: pending.argNames
        });
      }
      index++;
      continue;
    }
    if (token.kind === "identifier" && peek(1).kind === "operator" && peek(1).value === "=" && openParens.length > 0 && openParens[openParens.length - 1].parenDepth === braceDepth) {
      openParens[openParens.length - 1].argNames.push(token.value);
      index += 2;
      continue;
    }
    if (token.kind === "operator" && token.value === "**" && peek(1).kind === "identifier" && openParens.length > 0) {
      openParens[openParens.length - 1].argNames.push(`**${peek(1).value}`);
      pushReference(peek(1).value, peek(1), false);
      index += 2;
      continue;
    }
    if (token.kind === "identifier") {
      const next = peek(1);
      if (next.kind === "operator" && next.value === "=") {
        definitions.push({
          kind: "variable",
          name: token.value,
          line: token.line,
          column: token.column,
          length: token.length,
          container: containerName()
        });
      }
      pushReference(token.value, token, false);
      index++;
      continue;
    }
    if (token.kind === "operator" && token.value === "." && peek(1).kind === "identifier") {
      pushReference(peek(1).value, peek(1), true);
      index += 2;
      continue;
    }
    index++;
  }
  return { definitions, imports, references, calls };
}
function hasDefaultAfter(tokens, cursor) {
  return tokens[cursor + 1]?.kind === "operator" && tokens[cursor + 1]?.value === "=";
}
function skipDefaultValue(tokens, cursor, setCursor) {
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
function collectDottedName(tokens, startIndex) {
  let index = startIndex;
  let name = tokens[startIndex]?.value ?? "";
  while (tokens[index + 1]?.value === "." && tokens[index + 2]?.kind === "identifier") {
    name += `.${tokens[index + 2].value}`;
    index += 2;
  }
  return { name, endIndex: index + 1 };
}

// src/builtins-info.ts
var GLOBAL_FUNCTIONS = {
  write: "write(*values) -> None \u2014 print values separated by spaces, then a newline",
  print: "print(*values) -> None \u2014 alias of write()",
  len: "len(obj) -> int \u2014 length of a str, list, tuple, dict, set, range or bytes",
  isinstance: "isinstance(obj, cls) -> bool \u2014 true when obj is an instance of cls (or its subclass)",
  issubclass: "issubclass(cls, base) -> bool \u2014 true when cls derives from base",
  super: "super() \u2014 the next class in the MRO for the enclosing method",
  staticmethod: "staticmethod(fn) \u2014 wrap fn as a static method",
  classmethod: "classmethod(fn) \u2014 wrap fn as a class method",
  property: "property(get, [set], [delete]) \u2014 declare a managed attribute",
  type: "type(x) \u2014 the runtime type of x, or type(name, bases, dict) to build a class",
  abs: "abs(n) -> number \u2014 absolute value",
  all: "all(iterable) -> bool \u2014 true when every element is truthy",
  any: "any(iterable) -> bool \u2014 true when any element is truthy",
  callable: "callable(v) -> bool \u2014 true when v can be called",
  chr: "chr(code) -> str \u2014 character for a Unicode code point",
  divmod: "divmod(a, b) -> tuple \u2014 quotient and remainder pair",
  enumerate: "enumerate(iterable, [start=0]) \u2014 iterator of (index, item) pairs",
  filter: "filter(fn, iterable) \u2014 elements where fn(element) is truthy",
  iter: "iter(iterable) \u2014 iterator over the elements",
  map: "map(fn, *iterables) \u2014 fn applied to each element positionally",
  max: "max(*args) \u2014 largest argument",
  min: "min(*args) \u2014 smallest argument",
  next: "next(iterator) \u2014 the next element, raising StopIteration when exhausted",
  ord: "ord(ch) -> int \u2014 Unicode code point of a one-character string",
  pow: "pow(base, exp, [mod]) \u2014 base raised to exp",
  repr: "repr(v) -> str \u2014 the debug representation of v",
  reversed: "reversed(seq) \u2014 iterator over seq backwards",
  round: "round(n, [digits]) \u2014 rounded value",
  setattr: "setattr(obj, name, value) \u2014 set an attribute",
  getattr: "getattr(obj, name, [default]) \u2014 read an attribute or default",
  hasattr: "hasattr(obj, name) -> bool \u2014 true when the attribute exists",
  sorted: "sorted(iterable, [key], [reverse]) -> list \u2014 sorted copy",
  sum: "sum(iterable, [start]) \u2014 total of the elements",
  zip: "zip(*iterables) \u2014 iterator of tuples of corresponding elements",
  gc_collect: "gc_collect() -> int \u2014 collect unreachable managed objects",
  input: "input([prompt]) -> str \u2014 read a line from stdin"
};
var GLOBAL_TYPES = {
  bool: "bool \u2014 truth type (true/false)",
  dict: "dict \u2014 key/value map",
  float: "float \u2014 binary floating-point number",
  int: "int \u2014 arbitrary-precision integer",
  list: "list \u2014 mutable sequence",
  range: "range \u2014 arithmetic progression",
  set: "set \u2014 unordered unique collection",
  str: "str \u2014 UTF-8 text",
  tuple: "tuple \u2014 immutable sequence",
  type: "type \u2014 the type of types",
  BaseException: "BaseException \u2014 root of the exception hierarchy",
  Exception: "Exception \u2014 parent of all standard exceptions",
  ArithmeticError: "ArithmeticError(Exception)",
  ZeroDivisionError: "ZeroDivisionError(ArithmeticError) \u2014 division or modulo by zero",
  OverflowError: "OverflowError(ArithmeticError)",
  AssertionError: "AssertionError(Exception) \u2014 raised by a failed assert",
  AttributeError: "AttributeError(Exception) \u2014 missing attribute",
  EOFError: "EOFError(Exception)",
  ImportError: "ImportError(Exception) \u2014 module resolution or execution failure",
  LookupError: "LookupError(Exception)",
  IndexError: "IndexError(LookupError) \u2014 sequence subscript out of range",
  KeyError: "KeyError(LookupError) \u2014 missing dict key",
  NameError: "NameError(Exception) \u2014 unknown name",
  OSError: "OSError(Exception) \u2014 filesystem failure",
  RuntimeError: "RuntimeError(Exception)",
  NotImplementedError: "NotImplementedError(RuntimeError)",
  RecursionError: "RecursionError(RuntimeError)",
  StopIteration: "StopIteration(Exception)",
  TypeError: "TypeError(Exception) \u2014 wrong type/value shape",
  ValueError: "ValueError(Exception) \u2014 right type, wrong value"
};
var KEYWORD_HELP = {
  and: "Boolean AND (short-circuit)",
  as: "alias in `import ... as` / `from ... import ... as` / `except ... as`",
  assert: "assert condition[, message] \u2014 raise AssertionError when condition is falsy",
  break: "exit the enclosing loop",
  case: "case value { ... } \u2014 branch of a switch statement",
  default: "default { ... } \u2014 fallback branch of a switch statement",
  class: "class Name(Bases) { ... } \u2014 declare a class",
  continue: "jump to the next loop iteration",
  def: "def name(params) { ... } \u2014 declare a function",
  del: "del target \u2014 remove a variable, attribute or item",
  elif: "alternative branch of an if/elif chain",
  else: "fallback branch of if/while/for/try",
  except: "exception handler clause of try",
  finally: "always-run clause of try",
  for: "for item in iterable { ... } \u2014 iterate; optional else clause",
  from: "from module import member [as alias], ...",
  global: "global name \u2014 assign the module-level binding",
  if: "if condition { ... }",
  import: "import module [as alias]",
  in: "membership test / for target",
  is: "identity comparison",
  lambda: "lambda params: expression \u2014 anonymous function",
  nonlocal: "nonlocal name \u2014 assign the nearest enclosing function binding",
  not: "Boolean NOT",
  or: "Boolean OR (short-circuit)",
  pass: "do nothing",
  raise: "raise expr \u2014 throw an exception object (bare raise re-throws)",
  return: "return [value] \u2014 leave the function",
  switch: "switch (subject) { case value { ... } default { ... } } \u2014 multi-way branch",
  try: "try { ... } except E [as e] { ... } else { ... } finally { ... }",
  while: "while condition { ... } \u2014 optional else clause"
};
var BUILTIN_MODULES = {
  math: {
    pi: "value \u2014 \u03C0 constant",
    e: "value \u2014 e constant",
    tau: "value \u2014 \u03C4 constant",
    sqrt: "sqrt(x) \u2014 square root",
    floor: "floor(x) \u2014 round down",
    ceil: "ceil(x) \u2014 round up",
    sin: "sin(x) \u2014 sine",
    cos: "cos(x) \u2014 cosine"
  },
  os: {
    getcwd: "getcwd() \u2014 current working directory",
    exists: "exists(path) \u2014 path exists?",
    isdir: "isdir(path) \u2014 path is a directory?",
    listdir: "listdir([path]) \u2014 directory entries",
    join: "join(*paths) \u2014 join with the platform separator",
    system: "system(cmd) \u2014 run a shell command",
    platform: "platform() \u2014 OS platform",
    arch: "arch() \u2014 CPU architecture",
    version: "version() \u2014 kernel release",
    cpus: "cpus() \u2014 CPU model"
  },
  random: {
    seed: "seed(n) \u2014 seed the generator",
    random: "random() \u2014 float in [0, 1)",
    randint: "randint(a, b) \u2014 inclusive integer",
    randrange: "randrange([start], stop, [step])",
    uniform: "uniform(a, b) \u2014 float in [a, b]",
    gauss: "gauss(mu, sigma) \u2014 normal deviate",
    getrandbits: "getrandbits(k) \u2014 k random bits",
    choice: "choice(seq) \u2014 one element",
    choices: "choices(seq, [k]) \u2014 sample with replacement",
    shuffle: "shuffle(seq) \u2014 in-place shuffle",
    sample: "sample(seq, k) \u2014 sample without replacement"
  },
  sys: {
    argv: "value \u2014 argument list",
    exit: "exit([code]) \u2014 terminate the process",
    platform: 'value \u2014 "thm"',
    version: "value \u2014 interpreter version"
  },
  bytes: {
    bytes: "bytes(iterable) \u2014 construct bytes",
    len: "len(b) \u2014 byte count",
    getitem: "getitem(b, i)",
    slice: "slice(b, start, stop, step)",
    decode: "decode(b, [encoding])",
    encode: "encode(s, [encoding])",
    hex: "hex(b) \u2014 hex string",
    fromhex: "fromhex(s) \u2014 parse hex"
  },
  requests: {
    get: "get(url) \u2014 HTTP GET, returns a response object"
  },
  test_sbk: {
    greet: "greet() \u2014 example custom built-in",
    values: "values \u2014 example constants"
  }
};
var MODULE_DESCRIPTIONS = {
  math: "Mathematical constants and trigonometry/rounding functions",
  os: "Host operating-system and filesystem access",
  random: "Pseudo-random number generation",
  sys: "Interpreter-level values (argv, exit, version)",
  bytes: "Byte-buffer construction, slicing and encoding helpers",
  requests: "HTTP GET and file reading helpers",
  test_sbk: "Example custom built-in module"
};
var TYPE_MEMBERS = {
  str: {
    upper: "upper() \u2014 uppercase copy",
    lower: "lower() \u2014 lowercase copy",
    strip: "strip([chars]) \u2014 trim both ends",
    split: "split([sep]) \u2014 split into a list",
    join: "join(parts) \u2014 concatenate with this separator",
    replace: "replace(old, new)",
    startswith: "startswith(prefix) \u2014 prefix check",
    endswith: "startswith(prefix) \u2014 suffix check",
    find: "find(needle) \u2014 first index or -1",
    format: "format(*args) \u2014 substitution"
  },
  list: {
    append: "append(item) \u2014 push at the end",
    pop: "pop([index]) \u2014 remove and return",
    extend: "extend(other) \u2014 append all",
    insert: "insert(i, item)",
    remove: "remove(value) \u2014 delete first match",
    sort: "sort() \u2014 in-place sort",
    reverse: "reverse() \u2014 in-place reversal",
    clear: "clear() \u2014 drop all items",
    index: "index(value) \u2014 first position",
    count: "count(value) \u2014 occurrences"
  },
  dict: {
    keys: "keys() \u2014 iterable of keys",
    values: "values() \u2014 iterable of values",
    items: "items() \u2014 iterable of (k, v) pairs",
    get: "get(key, [default])",
    pop: "pop(key, [default])",
    setdefault: "setdefault(key, default)",
    clear: "clear() \u2014 empty the map",
    update: "update(other) \u2014 merge"
  },
  set: {
    add: "add(item)",
    remove: "remove(item)",
    discard: "discard(item)",
    clear: "clear()"
  }
};
var GLOBAL_SIGNATURES = buildSignatures();
function buildSignatures() {
  const signatures = {};
  for (const [name, doc] of Object.entries(GLOBAL_FUNCTIONS)) {
    const open = doc.indexOf("(");
    const close = doc.indexOf(")", open);
    const parameterText = open >= 0 && close > open ? doc.slice(open + 1, close) : "";
    const label = doc.split("\u2014")[0].trim();
    signatures[name] = {
      label,
      parameters: parameterText.split(",").map((part) => part.trim()).filter((part) => part !== "").map((part) => ({
        label: part.replace(/^\*\*/, "**").replace(/^\*/, "*")
      })),
      documentation: doc.slice(doc.indexOf("\u2014") + 1).trim() || doc
    };
  }
  for (const [name, doc] of Object.entries(GLOBAL_TYPES)) {
    signatures[name] = {
      label: `${name}(initializers...)`,
      parameters: [],
      documentation: doc
    };
  }
  return signatures;
}

// src/features.ts
var import_fs = require("fs");

// src/positions.ts
var LineIndex = class {
  constructor(text) {
    this.text = text;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code === 10) this.starts.push(i + 1);
      else if (code === 13 && text.charCodeAt(i + 1) !== 10) this.starts.push(i + 1);
    }
  }
  text;
  starts = [0];
  get lineCount() {
    return this.starts.length;
  }
  lineStart(line) {
    return this.starts[Math.max(0, Math.min(line, this.starts.length - 1))];
  }
  lineEnd(line) {
    if (line >= this.starts.length - 1) return this.text.length;
    let end = this.starts[line + 1] - 1;
    if (end > 0 && this.text.charCodeAt(end - 1) === 13) end--;
    return end;
  }
  offsetAt(line, character) {
    if (line < 0) return 0;
    if (line >= this.starts.length) return this.text.length;
    return Math.min(this.lineStart(line) + Math.max(0, character), this.lineEnd(line));
  }
  positionAt(offset) {
    const clamped = Math.max(0, Math.min(offset, this.text.length));
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = lo + hi + 1 >> 1;
      if (this.starts[mid] <= clamped) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo, character: clamped - this.starts[lo] };
  }
  rangeOf(offset, length) {
    return { start: this.positionAt(offset), end: this.positionAt(offset + length) };
  }
};
function offsetToPosition(text, line, character) {
  const index = new LineIndex(text);
  const offset = index.offsetAt(line, character);
  return { offset, lineText: text.slice(index.lineStart(line), index.lineEnd(line)) };
}

// src/workspace.ts
var fs = __toESM(require("fs"));
var path = __toESM(require("path"));

// src/binder.ts
var CONTINUATION_OPENERS = /* @__PURE__ */ new Set(["(", "[", "{"]);
var PRELUDE_NAMES = /* @__PURE__ */ new Set([
  "true",
  "false",
  "none",
  "self",
  "cls",
  "super",
  "__name__",
  "__file__",
  "__doc__",
  "bytes",
  "object",
  "NotImplemented",
  "Ellipsis",
  "gc_collect",
  "getattr",
  "hasattr",
  "setattr",
  "input",
  "map",
  "max",
  "min",
  "next",
  "ord",
  "pow",
  "repr",
  "reversed",
  "round",
  "sorted",
  "sum",
  "zip",
  "exit",
  "quit",
  "id",
  "hash",
  "hex",
  "bin",
  "oct",
  "format",
  "vars",
  "dir",
  "open",
  "slice",
  "frozenset",
  "complex",
  "bytearray"
]);
function bind(source) {
  const allTokens = tokenize(source);
  const comments = allTokens.filter((token) => token.kind === "comment");
  const tokens = allTokens.filter(
    (token) => token.kind !== "comment" && token.kind !== "indent" && token.kind !== "dedent"
  );
  const moduleScope = newScope("module", void 0, 0, source.length);
  const scopes = [moduleScope];
  const symbols = [];
  const occurrences = [];
  const imports = [];
  const blocks = [];
  const match = pairBrackets(tokens);
  for (const [open, close] of match.entries()) {
    if (tokens[open].value === "{" && close >= 0)
      blocks.push({ open: tokens[open].offset, close: tokens[close].offset });
  }
  const isOp = (index2, value) => index2 >= 0 && index2 < tokens.length && tokens[index2].kind === "operator" && tokens[index2].value === value;
  const isKw = (index2, value) => index2 >= 0 && index2 < tokens.length && tokens[index2].kind === "keyword" && tokens[index2].value === value;
  const isIdent = (index2) => index2 >= 0 && index2 < tokens.length && tokens[index2].kind === "identifier";
  const skipNl = (index2) => {
    while (index2 < tokens.length && tokens[index2].kind === "newline") index2++;
    return index2;
  };
  function newScope(kind, parent, start, end) {
    const scope = {
      kind,
      parent,
      start,
      end,
      symbols: /* @__PURE__ */ new Map(),
      children: [],
      globals: /* @__PURE__ */ new Set(),
      nonlocals: /* @__PURE__ */ new Set()
    };
    parent?.children.push(scope);
    return scope;
  }
  function openScope(kind, parent, start, end) {
    const scope = newScope(kind, parent, start, end);
    scopes.push(scope);
    return scope;
  }
  function bindingScope(scope, name) {
    if (scope.globals.has(name)) return moduleScope;
    if (scope.nonlocals.has(name)) {
      let cursor = scope.parent;
      while (cursor !== void 0) {
        if (cursor.kind !== "class" && cursor.kind !== "module" && cursor.symbols.has(name)) return cursor;
        cursor = cursor.parent;
      }
    }
    return scope;
  }
  function addOccurrence(token, scope, flags) {
    const occurrence = {
      name: token.value,
      offset: token.offset,
      line: token.line,
      column: token.column,
      length: token.length,
      isWrite: flags.write ?? false,
      isDeclaration: flags.decl ?? false,
      isAttribute: flags.attr ?? false,
      receiver: flags.receiver,
      scope
    };
    occurrences.push(occurrence);
    return occurrence;
  }
  function declare(token, scope, kind, extra = {}) {
    const target = kind === "variable" ? bindingScope(scope, token.value) : scope;
    const existing = target.symbols.get(token.value);
    if (existing !== void 0 && kind === "variable") {
      if (existing.kind === "function" || existing.kind === "class" || existing.kind === "method" || existing.kind === "import" || existing.kind === "importMember")
        existing.rebound = true;
      const occurrence2 = addOccurrence(token, scope, { write: true });
      occurrence2.symbol = existing;
      existing.occurrences.push(occurrence2);
      return existing;
    }
    if (existing !== void 0 && kind !== "variable" && existing.kind !== "parameter") {
      const occurrence2 = addOccurrence(token, scope, { write: true, decl: true });
      occurrence2.symbol = existing;
      existing.occurrences.push(occurrence2);
      existing.rebound = true;
      Object.assign(existing, extra, {
        kind,
        line: token.line,
        column: token.column,
        offset: token.offset,
        length: token.length
      });
      return existing;
    }
    const symbol = {
      name: token.value,
      kind,
      scope: target,
      line: token.line,
      column: token.column,
      offset: token.offset,
      length: token.length,
      occurrences: [],
      ...extra
    };
    target.symbols.set(token.value, symbol);
    symbols.push(symbol);
    const occurrence = addOccurrence(token, scope, { write: true, decl: true });
    occurrence.symbol = symbol;
    symbol.occurrences.push(occurrence);
    return symbol;
  }
  function moduleLevelOf(_outer, classScope) {
    return classScope;
  }
  function annotationText(from, stops) {
    let depth = 0;
    let index2 = from;
    const parts = [];
    while (index2 < tokens.length) {
      const token = tokens[index2];
      if (token.kind === "newline" || token.kind === "eof") break;
      if (token.kind === "operator") {
        if (depth === 0 && stops.has(token.value)) break;
        if (CONTINUATION_OPENERS.has(token.value)) depth++;
        else if (token.value === ")" || token.value === "]" || token.value === "}") {
          if (depth === 0) break;
          depth--;
        }
      }
      parts.push(token.value);
      index2++;
    }
    return { text: parts.join(" ").replace(/ ([\],.)]) /g, "$1 ").replace(/([\[(.]) /g, "$1"), end: index2 };
  }
  const frames = [{ scope: moduleScope, closeIndex: tokens.length }];
  const current = () => frames[frames.length - 1].scope;
  let index = 0;
  let pendingDecorators = 0;
  const comprehensionStack = [];
  const lambdaStack = [];
  const popFinished = () => {
    while (frames.length > 1 && index >= frames[frames.length - 1].closeIndex) frames.pop();
    while (comprehensionStack.length > 0 && index > comprehensionStack[comprehensionStack.length - 1].closeIndex)
      comprehensionStack.pop();
    while (lambdaStack.length > 0 && index >= lambdaStack[lambdaStack.length - 1].endIndex) {
      const done = lambdaStack.pop();
      const at = frames.findIndex((frame) => frame.scope === done.scope);
      if (at > 0) frames.splice(at, 1);
    }
  };
  function lambdaEnd(from) {
    let depth = 0;
    let i = from;
    while (i < tokens.length) {
      const t = tokens[i];
      if (t.kind === "newline" || t.kind === "eof") return i;
      if (t.kind === "operator") {
        if (CONTINUATION_OPENERS.has(t.value)) depth++;
        else if (t.value === ")" || t.value === "]" || t.value === "}") {
          if (depth === 0) return i;
          depth--;
        } else if (depth === 0 && (t.value === "," || t.value === ";")) return i;
      }
      i++;
    }
    return i;
  }
  function parseParams(start, fnScope, outer, isLambda) {
    const params = [];
    let i = start;
    let seenVararg = false;
    let kind = "positional";
    const closer = isLambda ? ":" : ")";
    while (i < tokens.length) {
      i = skipNl(i);
      const token = tokens[i];
      if (token === void 0 || token.kind === "eof") break;
      if (isOp(i, closer) && !isLambda) break;
      if (isLambda && isOp(i, ":")) break;
      if (isOp(i, ",")) {
        i++;
        continue;
      }
      if (isOp(i, "/")) {
        i++;
        continue;
      }
      kind = seenVararg ? "keywordOnly" : "positional";
      if (isOp(i, "*") || isOp(i, "**")) {
        const star = tokens[i].value;
        i++;
        if (star === "**") kind = "kwarg";
        else {
          kind = "vararg";
          seenVararg = true;
        }
        if (!isIdent(i)) continue;
      }
      if (!isIdent(i)) {
        i++;
        continue;
      }
      const nameToken = tokens[i];
      i++;
      let annotation;
      if (isOp(i, ":") && !isLambda) {
        const parsed = annotationText(i + 1, /* @__PURE__ */ new Set([",", "="]));
        annotation = parsed.text;
        for (let k = i + 1; k < parsed.end; k++)
          if (tokens[k].kind === "identifier" && !isOp(k - 1, ".")) referenceName(k, outer, true);
        i = parsed.end;
      }
      let hasDefault = false;
      let defaultText;
      if (isOp(i, "=")) {
        hasDefault = true;
        const startDefault = i + 1;
        let depth = 0;
        let j = startDefault;
        while (j < tokens.length) {
          const t = tokens[j];
          if (t.kind === "newline" || t.kind === "eof") {
            if (depth === 0) break;
            j++;
            continue;
          }
          if (t.kind === "operator") {
            if (CONTINUATION_OPENERS.has(t.value)) depth++;
            else if (t.value === ")" || t.value === "]" || t.value === "}") {
              if (depth === 0) break;
              depth--;
            } else if (depth === 0 && (t.value === "," || isLambda && t.value === ":")) break;
          }
          j++;
        }
        defaultText = tokens.slice(startDefault, j).filter((t) => t.kind !== "newline").map((t) => t.value).join("");
        for (let k = startDefault; k < j; k++) processExpressionToken(k, outer);
        i = j;
      }
      const symbol = declare(nameToken, fnScope, "parameter", { annotation });
      void symbol;
      params.push({ name: nameToken.value, kind, hasDefault, annotation, defaultText });
    }
    return { params, end: i };
  }
  function processExpressionToken(i, scope) {
    const token = tokens[i];
    if (token.kind !== "identifier") return;
    if (isOp(i - 1, ".")) {
      const receiver = isIdent(i - 2) ? tokens[i - 2].value : void 0;
      addOccurrence(token, scope, { attr: true, receiver });
      return;
    }
    if (isOp(i + 1, "=") && isOp(i - 1, "(")) {
      addOccurrence(token, scope, { attr: false });
      return;
    }
    referenceName(i, scope);
  }
  function referenceName(i, scope, annotation = false) {
    const token = tokens[i];
    if (token.kind !== "identifier") return;
    const occurrence = addOccurrence(token, scope, {});
    if (annotation) occurrence.isAnnotation = true;
  }
  function docstringAfter(openIdx) {
    const at = skipNl(openIdx + 1);
    const tok = tokens[at];
    if (tok === void 0 || tok.kind !== "string") return void 0;
    const after = tokens[at + 1];
    if (after !== void 0 && after.kind !== "newline" && !(after.kind === "operator" && after.value === "}")) return void 0;
    const m = /^[rRbBfF]*("""|\'\'\'|"|\')([\s\S]*?)\1$/.exec(tok.value);
    if (m === null) return void 0;
    const lines = m[2].replace(/^\n/, "").split("\n");
    const indents = lines.slice(1).filter((l) => l.trim() !== "").map((l) => /^\s*/.exec(l)[0].length);
    const strip = indents.length > 0 ? Math.min(...indents) : 0;
    return [lines[0].trim(), ...lines.slice(1).map((l) => l.slice(strip))].join("\n").trim();
  }
  function formatSignature(name, params, returns, isAsync) {
    const rendered = params.map((param) => {
      const prefix = param.kind === "vararg" ? "*" : param.kind === "kwarg" ? "**" : "";
      let text = prefix + param.name;
      if (param.annotation) text += `: ${param.annotation}`;
      if (param.hasDefault) text += param.annotation ? ` = ${param.defaultText ?? "\u2026"}` : `=${param.defaultText ?? "\u2026"}`;
      return text;
    });
    return `${isAsync ? "async " : ""}def ${name}(${rendered.join(", ")})${returns ? ` -> ${returns}` : ""}`;
  }
  function findBlockOpen(from) {
    const at = skipNl(from);
    return isOp(at, "{") ? at : -1;
  }
  while (index < tokens.length) {
    popFinished();
    const token = tokens[index];
    if (token.kind === "eof") break;
    const scope = current();
    if (isOp(index, "@") && (index === 0 || tokens[index - 1].kind === "newline")) {
      pendingDecorators++;
      index++;
      continue;
    }
    if (isKw(index, "def") || token.value === "async" && isKw(index + 1, "def")) {
      const isAsync = token.value === "async";
      const defIndex = isAsync ? index + 1 : index;
      if (isIdent(defIndex + 1)) {
        const nameToken = tokens[defIndex + 1];
        let cursor = defIndex + 2;
        const fnTypeParams = [];
        if (isOp(cursor, "[")) {
          const close = match.get(cursor) ?? -1;
          if (close > 0) {
            for (let k = cursor + 1; k < close; k++)
              if (isIdent(k) && (isOp(k - 1, "[") || isOp(k - 1, ","))) fnTypeParams.push(tokens[k]);
            cursor = close + 1;
          }
        }
        let params = [];
        let returns;
        let openBrace = -1;
        const methodOwner = scope.kind === "class";
        const fnScope = openScope("function", scope, token.offset, source.length);
        for (const typeParam of fnTypeParams) declare(typeParam, fnScope, "parameter", { detail: `type parameter ${typeParam.value}` });
        if (isOp(cursor, "(")) {
          const parsed = parseParams(cursor + 1, fnScope, scope, false);
          params = parsed.params;
          cursor = parsed.end + 1;
        }
        if (isOp(cursor, "->")) {
          const parsed = annotationText(cursor + 1, /* @__PURE__ */ new Set(["{"]));
          returns = parsed.text;
          for (let k = cursor + 1; k < parsed.end; k++)
            if (tokens[k].kind === "identifier" && !isOp(k - 1, ".")) referenceName(k, scope, true);
          cursor = parsed.end;
        }
        openBrace = findBlockOpen(cursor);
        const closeIdx = openBrace >= 0 ? match.get(openBrace) ?? tokens.length - 1 : cursor;
        const endOffset = openBrace >= 0 && closeIdx >= 0 && closeIdx < tokens.length ? tokens[closeIdx].offset + tokens[closeIdx].length : tokens[Math.min(cursor, tokens.length - 1)].offset;
        fnScope.start = openBrace >= 0 ? tokens[openBrace].offset : token.offset;
        fnScope.end = endOffset;
        const symbol = declare(nameToken, scope, methodOwner ? "method" : "function", {
          parameters: params,
          detail: formatSignature(nameToken.value, params, returns, isAsync),
          fullStart: token.offset,
          fullEnd: endOffset,
          returnAnnotation: returns,
          isAsync,
          decorated: pendingDecorators > 0,
          doc: openBrace >= 0 ? docstringAfter(openBrace) : void 0
        });
        fnScope.owner = symbol;
        pendingDecorators = 0;
        if (openBrace >= 0) {
          frames.push({ scope: fnScope, closeIndex: closeIdx });
          index = openBrace + 1;
        } else {
          index = cursor;
        }
        continue;
      }
    }
    if (isKw(index, "class") && isIdent(index + 1)) {
      const nameToken = tokens[index + 1];
      let cursor = index + 2;
      const classTypeParams = [];
      if (isOp(cursor, "[")) {
        const close = match.get(cursor) ?? -1;
        if (close > 0) {
          for (let k = cursor + 1; k < close; k++)
            if (isIdent(k) && (isOp(k - 1, "[") || isOp(k - 1, ","))) classTypeParams.push(tokens[k]);
          cursor = close + 1;
        }
      }
      const bases = [];
      if (isOp(cursor, "(")) {
        const close = match.get(cursor) ?? cursor;
        for (let k = cursor + 1; k < close; k++) {
          if (tokens[k].kind === "identifier") {
            if (isOp(k + 1, "=")) {
              k++;
              continue;
            }
            referenceName(k, scope);
            if (!isOp(k - 1, ".")) bases.push(tokens[k].value);
          }
        }
        cursor = close + 1;
      }
      const openBrace = findBlockOpen(cursor);
      const closeIdx = openBrace >= 0 ? match.get(openBrace) ?? tokens.length - 1 : cursor;
      const endOffset = openBrace >= 0 && closeIdx < tokens.length ? tokens[closeIdx].offset + tokens[closeIdx].length : tokens[Math.min(cursor, tokens.length - 1)].offset;
      const classScope = openScope(
        "class",
        scope,
        openBrace >= 0 ? tokens[openBrace].offset : token.offset,
        endOffset
      );
      const symbol = declare(nameToken, scope, "class", {
        detail: `class ${nameToken.value}${bases.length > 0 ? `(${bases.join(", ")})` : ""}`,
        fullStart: token.offset,
        fullEnd: endOffset,
        bases,
        decorated: pendingDecorators > 0,
        doc: openBrace >= 0 ? docstringAfter(openBrace) : void 0
      });
      classScope.owner = symbol;
      for (const typeParam of classTypeParams) declare(typeParam, moduleLevelOf(scope, classScope), "parameter", { detail: `type parameter ${typeParam.value}` });
      pendingDecorators = 0;
      if (openBrace >= 0) {
        frames.push({ scope: classScope, closeIndex: closeIdx });
        index = openBrace + 1;
      } else index = cursor;
      continue;
    }
    if (isKw(index, "global") || isKw(index, "nonlocal")) {
      const which = token.value;
      let k = index + 1;
      while (isIdent(k)) {
        const nameToken = tokens[k];
        (which === "global" ? scope.globals : scope.nonlocals).add(nameToken.value);
        const occurrence = addOccurrence(nameToken, scope, {});
        void occurrence;
        k++;
        if (isOp(k, ",")) k++;
      }
      index = k;
      continue;
    }
    if (isKw(index, "import") && (isIdent(index + 1) || tokens[index + 1]?.kind === "keyword")) {
      let k = index + 1;
      for (; ; ) {
        const first = tokens[k];
        if (first === void 0 || first.kind !== "identifier" && first.kind !== "keyword") break;
        let dotted = first.value;
        let last = k;
        while (isOp(last + 1, ".") && tokens[last + 2] && tokens[last + 2].kind !== "newline") {
          dotted += `.${tokens[last + 2].value}`;
          last += 2;
        }
        let alias;
        if (isKw(last + 1, "as") && isIdent(last + 2)) {
          alias = tokens[last + 2];
          last += 2;
        }
        const bindToken = alias ?? first;
        const sym = declare(
          { ...bindToken, value: alias ? alias.value : first.value },
          scope,
          "import",
          { detail: `import ${dotted}${alias ? ` as ${alias.value}` : ""}`, module: dotted }
        );
        void sym;
        imports.push({
          module: dotted,
          alias: alias?.value,
          members: [],
          fromImport: false,
          line: first.line,
          column: first.column,
          offset: first.offset,
          moduleOffset: first.offset,
          moduleLength: tokens[last].offset + tokens[last].length - first.offset,
          endOffset: tokens[last].offset + tokens[last].length
        });
        k = last + 1;
        if (isOp(k, ",")) {
          k++;
          continue;
        }
        break;
      }
      index = k;
      continue;
    }
    if (isKw(index, "from") && (tokens[index + 1]?.kind === "identifier" || isOp(index + 1, "."))) {
      let k = index + 1;
      let dotted = "";
      const moduleStart = tokens[k];
      while (k < tokens.length && (isOp(k, ".") || isIdent(k) || tokens[k].kind === "keyword") && !isKw(k, "import")) {
        dotted += tokens[k].value;
        k++;
      }
      if (isKw(k, "import")) {
        const record = {
          module: dotted,
          members: [],
          fromImport: true,
          line: token.line,
          column: token.column,
          offset: token.offset,
          moduleOffset: moduleStart.offset,
          moduleLength: Math.max(1, dotted.length),
          endOffset: token.offset
        };
        k++;
        const parens = isOp(k, "(");
        if (parens) k++;
        for (; ; ) {
          k = skipNl(k);
          const memberToken = tokens[k];
          if (memberToken === void 0) break;
          if (isOp(k, "*")) {
            record.star = true;
            k++;
            continue;
          }
          if (memberToken.kind !== "identifier" && memberToken.kind !== "keyword") break;
          let alias;
          let end = k;
          if (isKw(k + 1, "as") && isIdent(k + 2)) {
            alias = tokens[k + 2];
            end = k + 2;
          }
          const bindToken = alias ?? memberToken;
          declare(bindToken, scope, "importMember", {
            detail: `from ${dotted} import ${memberToken.value}${alias ? ` as ${alias.value}` : ""}`,
            module: dotted,
            member: memberToken.value
          });
          record.members.push({
            name: memberToken.value,
            alias: alias?.value,
            offset: memberToken.offset,
            length: memberToken.length,
            line: memberToken.line,
            column: memberToken.column
          });
          k = end + 1;
          if (isOp(k, ",")) {
            k++;
            continue;
          }
          break;
        }
        if (parens && isOp(skipNl(k), ")")) k = skipNl(k) + 1;
        record.endOffset = tokens[Math.max(0, k - 1)].offset + tokens[Math.max(0, k - 1)].length;
        imports.push(record);
        index = k;
        continue;
      }
    }
    if (isKw(index, "for")) {
      const inBrackets = insideBracketExpression(index);
      let k = index + 1;
      const targetTokens = [];
      let depth = 0;
      while (k < tokens.length && !(depth === 0 && isKw(k, "in"))) {
        if (tokens[k].kind === "newline" && depth === 0) break;
        if (isOp(k, "(") || isOp(k, "[")) depth++;
        if (isOp(k, ")") || isOp(k, "]")) depth--;
        if (isIdent(k) && !isOp(k - 1, ".")) targetTokens.push(k);
        k++;
      }
      let targetScope = scope;
      if (inBrackets) {
        const bracket = enclosingBracket(index);
        const top = comprehensionStack[comprehensionStack.length - 1];
        if (top !== void 0 && top.closeIndex === bracket.close) {
          targetScope = top.scope;
        } else {
          const compScope = openScope(
            "comprehension",
            scope,
            tokens[bracket.open].offset,
            tokens[bracket.close].offset + 1
          );
          comprehensionStack.push({ scope: compScope, closeIndex: bracket.close });
          frames.push({ scope: compScope, closeIndex: bracket.close });
          targetScope = compScope;
          comprehensionScopes.push({ scope: compScope, openOffset: tokens[bracket.open].offset, forOffset: token.offset });
        }
      }
      for (const t of targetTokens) declare(tokens[t], targetScope, "variable");
      index = k;
      continue;
    }
    if (isKw(index, "lambda")) {
      const end = lambdaEnd(index + 1);
      const lamScope = openScope("lambda", scope, token.offset, tokens[Math.min(end, tokens.length - 1)].offset);
      const parsed = parseParams(index + 1, lamScope, scope, true);
      frames.push({ scope: lamScope, closeIndex: Number.MAX_SAFE_INTEGER });
      lambdaStack.push({ scope: lamScope, stopDepthIndex: parsed.end, endIndex: end });
      index = parsed.end + 1;
      continue;
    }
    if (isKw(index, "as") && isIdent(index + 1) && lastExceptDepth !== -1 && isInExceptHeader(index)) {
      declare(tokens[index + 1], scope, "exception");
      index += 2;
      continue;
    }
    if (isKw(index, "except")) lastExceptDepth = index;
    if (isOp(index, ".") && isIdent(index + 1)) {
      const prev = tokens[index - 1];
      const receiver = prev?.kind === "identifier" ? prev.value : prev?.value === "self" ? "self" : void 0;
      const member = tokens[index + 1];
      if (receiver === "self" && isOp(index + 2, "=") && !isOp(index + 3, "=")) {
        const owner = enclosingClass(scope);
        if (owner !== void 0) {
          const existing = owner.symbols.get(member.value);
          if (existing === void 0) {
            const sym = {
              name: member.value,
              kind: "property",
              scope: owner,
              line: member.line,
              column: member.column,
              offset: member.offset,
              length: member.length,
              occurrences: [],
              detail: `(property) ${member.value}`
            };
            owner.symbols.set(member.value, sym);
            symbols.push(sym);
            const occ = addOccurrence(member, scope, { attr: true, write: true, decl: true, receiver });
            occ.symbol = sym;
            sym.occurrences.push(occ);
          } else {
            const occ = addOccurrence(member, scope, { attr: true, write: true, receiver });
            occ.symbol = existing;
            existing.occurrences.push(occ);
          }
          index += 2;
          continue;
        }
      }
      addOccurrence(member, scope, { attr: true, receiver });
      index += 2;
      continue;
    }
    if (token.kind === "identifier") {
      const prev = tokens[index - 1];
      const next = tokens[index + 1];
      const atStatementStart = index === 0 || prev.kind === "newline" || isOp(index - 1, ";") || isOp(index - 1, "}") || isOp(index - 1, "{") && isBlockBrace(index - 1);
      const isKwArg = isOp(index + 1, "=") && !isOp(index + 2, "=") && inCallParens(index) && (isOp(index - 1, "(") || isOp(index - 1, ","));
      if (isKwArg) {
        const bracket = enclosingBracket(index);
        const calleeToken = tokens[bracket.open - 1];
        const occ = addOccurrence(token, scope, {});
        occ.isKeywordArg = true;
        occ.callee = calleeToken?.kind === "identifier" ? calleeToken.value : void 0;
        keywordArgs.add(token.offset);
        index++;
        continue;
      }
      const augmentedOrAssign = next !== void 0 && next.kind === "operator" && (next.value === "=" || next.value.length >= 2 && next.value.endsWith("=") && !["==", "!=", "<=", ">="].includes(next.value) || next.value === ":=");
      const annotatedDecl = atStatementStart && isOp(index + 1, ":") && scope.kind !== "lambda";
      const tupleTarget = isTupleTargetStart(index, atStatementStart);
      if (augmentedOrAssign || annotatedDecl || tupleTarget) {
        if (annotatedDecl) {
          const parsed = annotationText(index + 2, /* @__PURE__ */ new Set(["="]));
          for (let k = index + 2; k < parsed.end; k++)
            if (tokens[k].kind === "identifier" && !isOp(k - 1, ".")) referenceName(k, scope, true);
          const sym = declare(token, scope, "variable", { annotation: parsed.text });
          if (sym.annotation === void 0) sym.annotation = parsed.text;
          index = parsed.end;
          continue;
        }
        const isPlainAssign = next?.value === "=" || next?.value === ":=";
        declare(token, scope, "variable");
        if (!isPlainAssign && augmentedOrAssign) {
          addOccurrence(token, scope, {}).symbol = void 0;
        }
        index++;
        continue;
      }
      referenceName(index, scope);
      index++;
      continue;
    }
    index++;
  }
  popFinished();
  function insideBracketExpression(at) {
    const bracket = enclosingBracket(at);
    if (bracket === void 0) return false;
    if (bracket.open < 0) return false;
    if (tokens[bracket.open].value === "{") return looksLikeCollectionBrace(bracket.open, at);
    return true;
  }
  function isBlockBrace(open) {
    let k = open - 1;
    while (k >= 0 && tokens[k].kind === "newline") k--;
    const before = tokens[k];
    if (before === void 0) return false;
    if (before.kind === "operator") return before.value === ")" || before.value === "]";
    if (before.kind === "keyword") return ["else", "try", "finally"].includes(before.value);
    return before.kind === "identifier" || before.kind === "number" || before.kind === "string";
  }
  function looksLikeCollectionBrace(open, forIndex) {
    void forIndex;
    return !isBlockBrace(open);
  }
  function enclosingBracket(at) {
    let depth = 0;
    for (let i = at - 1; i >= 0; i--) {
      const t = tokens[i];
      if (t.kind !== "operator") continue;
      if (t.value === ")" || t.value === "]" || t.value === "}") depth++;
      else if (t.value === "(" || t.value === "[" || t.value === "{") {
        if (depth === 0) return { open: i, close: match.get(i) ?? tokens.length - 1 };
        depth--;
      }
    }
    return { open: -1, close: -1 };
  }
  function inCallParens(at) {
    const bracket = enclosingBracket(at);
    return bracket.open >= 0 && tokens[bracket.open].value === "(";
  }
  function isTupleTargetStart(at, statementStart) {
    if (!statementStart) return false;
    let k = at;
    let seenComma = false;
    while (isIdent(k) || isOp(k, ",") || isOp(k, "(") || isOp(k, ")") || isOp(k, "*")) {
      if (isOp(k, ",")) seenComma = true;
      k++;
    }
    return seenComma && isOp(k, "=") && !isOp(k + 1, "=");
  }
  function isInExceptHeader(at) {
    for (let i = at - 1; i >= 0; i--) {
      if (isKw(i, "except")) return true;
      if (isOp(i, "{") || isOp(i, "}") || tokens[i].kind === "newline") return false;
    }
    return false;
  }
  function enclosingClass(scope) {
    let cursor = scope;
    while (cursor !== void 0) {
      if (cursor.kind === "function" && cursor.parent?.kind === "class") return cursor.parent;
      cursor = cursor.parent;
    }
    return void 0;
  }
  resolveAll();
  const unresolved = occurrences.filter(
    (occurrence) => occurrence.symbol === void 0 && !occurrence.isAttribute && !occurrence.isKeywordArg
  );
  const folds = computeFolds(source, tokens, blocks);
  {
    let runStart = -1;
    let runEnd = -1;
    for (const comment of comments) {
      if (comment.line === runEnd + 1 && runStart !== -1) runEnd = comment.line;
      else {
        if (runStart !== -1 && runEnd > runStart) folds.push({ startLine: runStart, endLine: runEnd, kind: "comment" });
        runStart = comment.line;
        runEnd = comment.line;
      }
    }
    if (runStart !== -1 && runEnd > runStart) folds.push({ startLine: runStart, endLine: runEnd, kind: "comment" });
  }
  return { tokens, module: moduleScope, scopes, symbols, occurrences, imports, folds, blocks, comments, unresolved };
  function resolveAll() {
    for (const comp of comprehensionScopes) {
      for (const occurrence of occurrences) {
        if (occurrence.scope.kind !== "comprehension" && occurrence.offset > comp.openOffset && occurrence.offset < comp.forOffset && occurrence.scope === comp.scope.parent) occurrence.scope = comp.scope;
      }
    }
    for (const occurrence of occurrences) {
      if (occurrence.symbol !== void 0 || occurrence.isKeywordArg) continue;
      if (occurrence.isAttribute) {
        if (occurrence.receiver === "self" || occurrence.receiver === "cls") {
          const owner = enclosingClass(occurrence.scope);
          const member = owner === void 0 ? void 0 : findMemberIn(owner, occurrence.name, /* @__PURE__ */ new Set());
          if (member !== void 0) {
            occurrence.symbol = member;
            member.occurrences.push(occurrence);
          }
        }
        continue;
      }
      const symbol = lookup(occurrence.scope, occurrence.name);
      if (symbol !== void 0) {
        occurrence.symbol = symbol;
        symbol.occurrences.push(occurrence);
      }
    }
    for (const symbol of symbols) symbol.occurrences.sort((a, b) => a.offset - b.offset);
  }
  function findMemberIn(classScope, name, seen) {
    if (seen.has(classScope)) return void 0;
    seen.add(classScope);
    const direct = classScope.symbols.get(name);
    if (direct !== void 0) return direct;
    for (const base of classScope.owner?.bases ?? []) {
      const baseSym = lookup(classScope.parent ?? moduleScope, base);
      const baseScope = baseSym === void 0 ? void 0 : scopes.find((candidate) => candidate.owner === baseSym && candidate.kind === "class");
      if (baseScope !== void 0) {
        const found = findMemberIn(baseScope, name, seen);
        if (found !== void 0) return found;
      }
    }
    return void 0;
  }
  function lookup(from, name) {
    let scope = from;
    if (from.globals.has(name)) return moduleScope.symbols.get(name);
    let first = true;
    while (scope !== void 0) {
      if (scope.kind !== "class" || first) {
        const found = scope.symbols.get(name);
        if (found !== void 0) return found;
      }
      first = false;
      scope = scope.parent;
    }
    return void 0;
  }
}
var comprehensionScopes = [];
var keywordArgs = /* @__PURE__ */ new Set();
var lastExceptDepth = -1;
function bindDocument(source) {
  comprehensionScopes.length = 0;
  keywordArgs.clear();
  lastExceptDepth = -1;
  return bind(source);
}
function pairBrackets(tokens) {
  const stack = [];
  const pairs = /* @__PURE__ */ new Map();
  const closers = { ")": "(", "]": "[", "}": "{" };
  tokens.forEach((token, index) => {
    if (token.kind !== "operator") return;
    if (token.value === "(" || token.value === "[" || token.value === "{") stack.push(index);
    else if (token.value in closers) {
      for (let s = stack.length - 1; s >= 0; s--) {
        if (tokens[stack[s]].value === closers[token.value]) {
          const open = stack[s];
          stack.length = s;
          pairs.set(open, index);
          break;
        }
      }
    }
  });
  for (const open of stack) pairs.set(open, tokens.length - 1);
  return pairs;
}
function computeFolds(source, tokens, blocks) {
  const folds = [];
  const lineOf = (offset) => {
    let line = 0;
    for (let i = 0; i < offset && i < source.length; i++) if (source.charCodeAt(i) === 10) line++;
    return line;
  };
  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source.charCodeAt(i) === 10) starts.push(i + 1);
  const fastLine = (offset) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) {
      const mid = lo + hi + 1 >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  void lineOf;
  for (const block of blocks) {
    const startLine = fastLine(block.open);
    const endLine = fastLine(block.close);
    if (endLine > startLine) folds.push({ startLine, endLine: endLine - 1 });
  }
  const stack = [];
  for (const token of tokens) {
    if (token.kind !== "operator") continue;
    if (token.value === "(" || token.value === "[") stack.push(token);
    else if ((token.value === ")" || token.value === "]") && stack.length > 0) {
      const open = stack.pop();
      if (token.line > open.line) folds.push({ startLine: open.line, endLine: token.line - 1 });
    }
  }
  let runStart = -1;
  let runEnd = -1;
  const importLines = /* @__PURE__ */ new Set();
  for (const token of tokens) if (token.kind === "keyword" && (token.value === "import" || token.value === "from") && token.column === 0) importLines.add(token.line);
  const sorted = [...importLines].sort((a, b) => a - b);
  for (const line of sorted) {
    if (runStart === -1) {
      runStart = line;
      runEnd = line;
    } else if (line === runEnd + 1) runEnd = line;
    else {
      if (runEnd > runStart) folds.push({ startLine: runStart, endLine: runEnd, kind: "imports" });
      runStart = line;
      runEnd = line;
    }
  }
  if (runStart !== -1 && runEnd > runStart) folds.push({ startLine: runStart, endLine: runEnd, kind: "imports" });
  return dedupeFolds(folds);
}
function dedupeFolds(folds) {
  const seen = /* @__PURE__ */ new Set();
  return folds.filter((fold) => {
    const key = `${fold.startLine}:${fold.endLine}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return fold.endLine > fold.startLine - 0 && fold.endLine >= fold.startLine;
  });
}

// src/workspace.ts
var Workspace = class {
  documents = /* @__PURE__ */ new Map();
  /** Roots used for resolving `import name` — the cwd and lib/ beneath it. */
  rootDirs = [];
  setRoot(rootUri) {
    this.setRoots([rootUri]);
  }
  /** Configure all workspace folders (multi-root aware). */
  setRoots(rootUris) {
    const folders = rootUris.filter((uri) => uri.startsWith("file://")).map(uriToPath);
    this.folders = folders;
    this.rootDirs = folders.flatMap((folder) => [folder, path.join(folder, "lib")]);
    if (this.rootFromCwd === void 0 && folders.length > 0) this.rootFromCwd = folders[0];
    this.diskCache.clear();
    this.fileListCache = void 0;
  }
  rootFromCwd;
  folders = [];
  diskCache = /* @__PURE__ */ new Map();
  fileListCache;
  workspaceFolders() {
    return this.folders.length > 0 ? this.folders : [process.cwd()];
  }
  invalidateFiles() {
    this.fileListCache = void 0;
    this.diskCache.clear();
  }
  /** Every .thm file under the workspace folders (cached for a few seconds). */
  listThmFiles(limit = 4e3) {
    const now = Date.now();
    if (this.fileListCache !== void 0 && now - this.fileListCache.at < 5e3) return this.fileListCache.files;
    const files = [];
    const skip = /* @__PURE__ */ new Set(["node_modules", ".git", "out", "build", "dist", ".venv", "__pycache__"]);
    const walk = (directory, depth) => {
      if (files.length >= limit || depth > 12) return;
      let entries;
      try {
        entries = fs.readdirSync(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith(".") && entry.name !== ".") continue;
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (!skip.has(entry.name)) walk(full, depth + 1);
        } else if (entry.name.endsWith(".thm")) files.push(full);
      }
    };
    for (const folder of this.workspaceFolders()) walk(folder, 0);
    this.fileListCache = { at: now, files };
    return files;
  }
  /** Open document by path if open, otherwise parse (and cache) the file on disk. */
  loadByPath(filePath) {
    for (const document of this.documents.values()) if (document.filePath === filePath) return document;
    try {
      const mtime = fs.statSync(filePath).mtimeMs;
      const cached = this.diskCache.get(filePath);
      if (cached !== void 0 && cached.mtime === mtime) return cached.doc;
      const text = fs.readFileSync(filePath, "utf8");
      const doc = this.build(pathToUri(filePath), text, 0);
      this.diskCache.set(filePath, { mtime, doc });
      return doc;
    } catch {
      return void 0;
    }
  }
  /** Resolve `import a.b` to a file, looking beside the importer, then the roots. */
  resolveModuleFile(moduleName, fromFile) {
    if (moduleName === "") return void 0;
    const leading = /^\.+/.exec(moduleName)?.[0].length ?? 0;
    const parts = moduleName.slice(leading).split(".").filter((part) => part !== "");
    const roots = [];
    if (fromFile !== void 0 && fromFile !== "") {
      let base = path.dirname(fromFile);
      for (let i = 1; i < leading; i++) base = path.dirname(base);
      roots.push(base);
    }
    if (leading === 0) roots.push(...this.rootDirs);
    if (roots.length === 0) roots.push(process.cwd());
    for (const root of roots) {
      const dir = path.join(root, ...parts);
      const init = path.join(dir, "__init__.thm");
      if (fs.existsSync(init)) return init;
      if (parts.length > 0 && fs.existsSync(`${dir}.thm`)) return `${dir}.thm`;
      if (parts.length === 0 && leading > 0 && fs.existsSync(init)) return init;
    }
    return void 0;
  }
  open(uri, text, version) {
    const document = this.build(uri, text, version);
    this.documents.set(uri, document);
    return document;
  }
  build(uri, text, version) {
    const document = {
      uri,
      filePath: uriToPath(uri),
      text,
      version,
      definitions: analyze(text).definitions.filter(
        (definition) => definition.container === void 0
      ),
      isUntitled: uri.startsWith("untitled:"),
      lines: new LineIndex(text),
      binding: bindDocument(text)
    };
    return document;
  }
  update(uri, text, version) {
    return this.open(uri, text, version);
  }
  close(uri) {
    this.documents.delete(uri);
  }
  get(uri) {
    return this.documents.get(uri);
  }
  /**
   * Find a definition for `name` in the open documents, preferring the same
   * file, then functions/classes, then variables.
   */
  findDefinition(name, preferredUri) {
    const results = [];
    const addFrom = (uri, definitions) => {
      for (const definition of definitions) {
        if (definition.name === name && definition.kind !== "variable") {
          results.push({ uri, definition });
        }
      }
    };
    addFrom(preferredUri, this.documents.get(preferredUri)?.definitions ?? []);
    for (const [uri, document] of this.documents) {
      if (uri !== preferredUri) addFrom(uri, document.definitions);
    }
    if (results.length === 0) {
      for (const [uri, document] of this.documents) {
        for (const definition of analyze(document.text).definitions) {
          if (definition.name === name && (definition.kind === "variable" || definition.kind === "parameter")) {
            results.push({ uri, definition });
          }
        }
      }
    }
    return results;
  }
  /** Resolve the possible source files for `import name`. */
  resolveModule(name) {
    const dotted = name.split(".");
    const candidateRoots = [...this.rootDirs];
    if (candidateRoots.length === 0 && process.cwd())
      candidateRoots.push(process.cwd());
    const direct = this.moduleFileCandidates(candidateRoots, dotted);
    if (direct === void 0) return this.virtualModule(name);
    const members = this.readModuleMembers(direct.path);
    return {
      name,
      kind: direct.isPackage ? "package" : "module",
      path: direct.path,
      members
    };
  }
  /** All importable module names visible from the workspace roots. */
  discoverModules() {
    const surfaces = [];
    const seen = /* @__PURE__ */ new Set();
    for (const root of this.rootDirs.length > 0 ? this.rootDirs : [process.cwd()]) {
      for (const entry of safeReaddir(root)) {
        if (entry.endsWith(".thm")) {
          const name = entry.slice(0, -4);
          if (!seen.has(name)) {
            seen.add(name);
            surfaces.push({
              name,
              kind: "module",
              path: path.join(root, entry),
              members: this.readModuleMembers(path.join(root, entry))
            });
          }
        } else if (fs.statSync(path.join(root, entry)).isDirectory() && fs.existsSync(path.join(root, entry, "__init__.thm"))) {
          if (!seen.has(entry)) {
            seen.add(entry);
            surfaces.push({
              name: entry,
              kind: "package",
              path: path.join(root, entry, "__init__.thm"),
              members: this.readModuleMembers(
                path.join(root, entry, "__init__.thm")
              )
            });
          }
        }
      }
    }
    return surfaces;
  }
  /** Built-in modules always resolve, even though they have no source file. */
  virtualModule(name) {
    if (isBuiltinModuleName(name)) {
      return { name, kind: "module", path: `<builtin:${name}>`, members: [] };
    }
    return void 0;
  }
  moduleFileCandidates(roots, parts) {
    for (const root of roots) {
      const packageDirectory = path.join(root, ...parts);
      const initFile = path.join(packageDirectory, "__init__.thm");
      if (fs.existsSync(initFile)) return { path: initFile, isPackage: true };
      const moduleFile = `${path.join(root, ...parts)}.thm`;
      if (fs.existsSync(moduleFile))
        return { path: moduleFile, isPackage: false };
    }
    return void 0;
  }
  /** Top-level definitions of a module source file (parsed fresh, uncached). */
  readModuleMembers(filePath) {
    if (filePath.startsWith("<builtin:")) return [];
    try {
      const text = fs.readFileSync(filePath, "utf8");
      return analyze(text).definitions.filter(
        (definition) => definition.container === void 0 && definition.kind !== "variable"
      ).map((definition) => ({
        name: definition.name,
        kind: definition.kind,
        detail: definition.detail
      }));
    } catch {
      return [];
    }
  }
};
function isBuiltinModuleName(name) {
  return [
    "math",
    "os",
    "random",
    "sys",
    "bytes",
    "requests",
    "test_sbk"
  ].includes(name);
}
function safeReaddir(directory) {
  try {
    return fs.readdirSync(directory).filter((entry) => !entry.startsWith("."));
  } catch {
    return [];
  }
}
function uriToPath(uri) {
  if (!uri.startsWith("file://")) return uri;
  let decoded = decodeURIComponent(uri.replace(/^file:\/\/(localhost)?/, ""));
  if (/^\/[A-Za-z]:/.test(decoded)) {
    decoded = decoded.slice(1);
    decoded = decoded[0].toUpperCase() + decoded.slice(1);
    return path.win32.normalize(decoded);
  }
  return decoded;
}
function pathToUri(filePath) {
  const normalized = filePath.replace(/\\/g, "/");
  const drive = /^([A-Za-z]):(\/.*)?$/.exec(normalized);
  if (drive !== null) {
    const rest = (drive[2] ?? "/").split("/").map(encodeURIComponent).join("/");
    return `file:///${drive[1].toLowerCase()}%3A${rest}`;
  }
  const withSlash = normalized.startsWith("/") ? normalized : `/${normalized}`;
  return `file://${withSlash.split("/").map(encodeURIComponent).join("/")}`;
}

// src/features.ts
var COMPLETION_KIND = {
  Text: 1,
  Method: 2,
  Function: 3,
  Constructor: 4,
  Field: 5,
  Variable: 6,
  Class: 7,
  Module: 9,
  Property: 10,
  Unit: 11,
  Value: 12,
  Enum: 13,
  Keyword: 14,
  Snippet: 15,
  Struct: 22,
  Event: 23,
  Operator: 24,
  TypeParameter: 25
};
var FeatureProvider = class {
  constructor(workspace) {
    this.workspace = workspace;
  }
  workspace;
  // ------------------------------------------------------------------ helpers
  analysisOf(uri) {
    const document = this.workspace.get(uri);
    const text = document?.text ?? "";
    return { text, analysis: analyze(text) };
  }
  /** Word at an offset, plus whether the cursor sits inside its trailing space. */
  wordAt(text, offset) {
    const isWordChar = (ch) => /[A-Za-z0-9_]/.test(ch);
    let start = Math.min(offset, text.length);
    while (start > 0 && isWordChar(text[start - 1])) start--;
    let end = offset;
    while (end < text.length && isWordChar(text[end])) end++;
    return { word: text.slice(start, end), start, end };
  }
  /** Get the dotted receiver chain ending at the token before `offset`. */
  receiverChain(text, offset) {
    const before = text.slice(0, offset);
    const match = /([A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)*)\.(\w*)$/.exec(before);
    if (match === null) return [];
    return match[1].split(".").map((part) => part.trim());
  }
  /**
   * Get the receiver chain when cursor is in a member access (e.g., typing `m.sqrt|`).
   * Finds the last dot before the cursor and returns the receiver parts.
   */
  receiverChainAtDot(text, offset) {
    const before = text.slice(0, offset);
    const lastDotIndex = before.lastIndexOf(".");
    if (lastDotIndex === -1) return null;
    const beforeDot = before.slice(0, lastDotIndex);
    const match = /([A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)*)$/.exec(beforeDot);
    if (match === null) return null;
    const parts = match[1].split(".").map((part) => part.trim());
    const partialMember = before.slice(lastDotIndex + 1);
    return { parts, partialMember };
  }
  /** True when offset is directly after `from <module> import ` (or partially typed member). */
  importMemberContext(text, offset) {
    const before = text.slice(0, offset);
    const match = /(?:^|\n)\s*from\s+([A-Za-z_.][\w.]*)\s+import\s+(?:as\s+)?([\w, ]*)$/.exec(
      before
    );
    if (match === null) return void 0;
    return match[1];
  }
  /** True when offset is directly after `import `. */
  importModuleContext(text, offset) {
    const before = text.slice(0, offset);
    return /(?:^|\n)\s*(?:import\s+|from\s+)[\w.]*$/.test(before);
  }
  /** Locate an enclosing call `callee(...<CURSOR>` and count prior arguments. */
  enclosingCall(text, offset) {
    const before = text.slice(0, offset);
    let depth = 0;
    let calleeStart = -1;
    let calleeEnd = -1;
    let inString = false;
    let stringQuote = "";
    let escapeNext = false;
    for (let i = before.length - 1; i >= 0; i--) {
      const ch = before[i];
      const nextCh = before[i + 1] ?? "";
      if (!inString && (ch === '"' || ch === "'")) {
        if (i >= 2 && before[i - 2] === ch && before[i - 1] === ch) {
          inString = true;
          stringQuote = ch.repeat(3);
          i -= 2;
        } else {
          inString = true;
          stringQuote = ch;
        }
        continue;
      }
      if (inString) {
        if (escapeNext) {
          escapeNext = false;
        } else if (ch === "\\") {
          escapeNext = true;
        } else if (stringQuote.length === 1 && ch === stringQuote || stringQuote.length === 3 && i >= 2 && before[i - 2] === ch && before[i - 1] === ch && ch === stringQuote[0]) {
          inString = false;
          if (stringQuote.length === 3) i -= 2;
        }
        continue;
      }
      if (ch === ")" || ch === "]" || ch === "}") {
        depth++;
      } else if (ch === "(" || ch === "[" || ch === "{") {
        depth--;
        if (depth === 0) {
          let j = i - 1;
          while (j >= 0 && /\s/.test(before[j])) j--;
          calleeEnd = j + 1;
          while (j >= 0 && /[A-Za-z0-9_.]/.test(before[j])) j--;
          calleeStart = j + 1;
          break;
        }
      }
    }
    if (calleeStart === -1 || calleeEnd === -1) return void 0;
    const callee = before.slice(calleeStart, calleeEnd);
    const argumentPart = before.slice(calleeEnd + 1);
    let argDepth = 0;
    let argumentIndex = 0;
    let inStr = false;
    let strQuote = "";
    let escNext = false;
    for (const ch of argumentPart) {
      if (!inStr && (ch === '"' || ch === "'")) {
        inStr = true;
        strQuote = ch;
        continue;
      }
      if (inStr) {
        if (escNext) escNext = false;
        else if (ch === "\\") escNext = true;
        else if (ch === strQuote) inStr = false;
        continue;
      }
      if (ch === "(" || ch === "[" || ch === "{") argDepth++;
      else if (ch === ")" || ch === "]" || ch === "}") argDepth--;
      else if (ch === "," && argDepth === 0) argumentIndex++;
    }
    return { callee, argumentIndex };
  }
  // --------------------------------------------------------------- completion
  /** Build editor-friendly call snippets while preserving optional/variadic args. */
  functionSnippet(name, parameters) {
    if (!parameters || parameters.length === 0) return `${name}($0)`;
    const required = parameters.filter((p) => !p.hasDefault && p.kind !== "kwarg");
    const chosen = required.length > 0 ? required : parameters.slice(0, 1);
    const args2 = chosen.map((p, i) => {
      const label = p.kind === "vararg" ? `*${p.name}` : p.kind === "kwarg" ? `**${p.name}` : p.name;
      return `\${${i + 1}:${label}}`;
    });
    return `${name}(${args2.join(", ")})$0`;
  }
  completion(uri, line, character) {
    const { text } = this.analysisOf(uri);
    const { lineText } = this.lineAt(text, line);
    const offset = this.offsetAt(text, line, character);
    const items = [];
    const memberOf = this.importMemberContext(text, offset);
    if (memberOf !== void 0) {
      return this.completionForModuleMembers(memberOf);
    }
    if (this.importModuleContext(text, offset)) {
      return this.completionForModules();
    }
    const receiverParts = this.receiverChain(text, offset);
    if (receiverParts.length > 0) {
      return this.completionForMember(receiverParts, uri);
    }
    const prefix = this.wordAt(text, offset).word;
    for (const keyword of KEYWORDS) {
      items.push({
        label: keyword,
        kind: COMPLETION_KIND.Keyword,
        detail: KEYWORD_HELP[keyword],
        documentation: KEYWORD_HELP[keyword],
        sortText: `3_${keyword}`
      });
    }
    for (const literal of ["true", "false", "none"]) {
      items.push({
        label: literal,
        kind: COMPLETION_KIND.Keyword,
        sortText: `3_${literal}`
      });
    }
    for (const [name, signature] of Object.entries(GLOBAL_FUNCTIONS)) {
      items.push({
        label: name,
        kind: COMPLETION_KIND.Function,
        detail: signature.split("\u2014")[0].trim(),
        documentation: signature,
        insertText: name,
        insertTextFormat: 1,
        sortText: `1_${name}`
      });
    }
    for (const [name, doc] of Object.entries(GLOBAL_TYPES)) {
      items.push({
        label: name,
        kind: COMPLETION_KIND.Class,
        detail: doc,
        documentation: doc,
        sortText: `1_${name}`
      });
    }
    for (const moduleName of Object.keys(BUILTIN_MODULES)) {
      items.push({
        label: moduleName,
        kind: COMPLETION_KIND.Module,
        detail: MODULE_DESCRIPTIONS[moduleName] ?? "",
        documentation: MODULE_DESCRIPTIONS[moduleName] ?? "",
        sortText: `2_${moduleName}`
      });
    }
    const { analysis } = this.analysisOf(uri);
    const seen = /* @__PURE__ */ new Set();
    const pushSymbol = (definition, originUri) => {
      if (seen.has(definition.name)) return;
      seen.add(definition.name);
      items.push({
        label: definition.name,
        kind: definition.kind === "function" ? COMPLETION_KIND.Function : definition.kind === "class" ? COMPLETION_KIND.Class : definition.kind === "variable" ? COMPLETION_KIND.Variable : COMPLETION_KIND.Struct,
        detail: definition.detail ?? (definition.container !== void 0 ? `${definition.container} member` : definition.kind),
        documentation: definition.detail,
        sortText: `0_${definition.name}`,
        data: { name: definition.name, origin: originUri },
        filterText: definition.name,
        insertText: definition.kind === "function" ? this.functionSnippet(definition.name, definition.parameters) : definition.name,
        insertTextFormat: definition.kind === "function" ? 2 : 1,
        commitCharacters: definition.kind === "function" ? ["("] : ["."]
      });
    };
    for (const definition of analysis.definitions) pushSymbol(definition, uri);
    for (const imported of analysis.imports) {
      const surface = this.workspace.resolveModule(imported.module);
      const moduleUri = surface !== void 0 && !surface.path.startsWith("<") ? pathToUri(surface.path) : uri;
      if (imported.members.length > 0) {
        for (const member of imported.members) {
          const found = this.findMemberDefinition(surface, member.name);
          pushSymbol(
            {
              kind: found?.kind ?? "function",
              name: member.alias ?? member.name,
              line: member.column,
              column: member.column,
              length: member.name.length,
              detail: found?.detail ?? `${imported.module}.${member.name}`
            },
            moduleUri
          );
        }
      } else {
        const aliasName = imported.alias ?? imported.module.split(".")[0];
        const selfDefinition = {
          kind: "import",
          name: aliasName,
          line: imported.line,
          column: 0,
          length: aliasName.length,
          detail: imported.fromImport ? `from ${imported.module}` : `import ${imported.module}`
        };
        pushSymbol(selfDefinition, moduleUri);
      }
    }
    for (const [uriOther, document] of this.workspace.documents) {
      if (uriOther === uri) continue;
      for (const definition of document.definitions) {
        if (definition.container === void 0)
          pushSymbol(definition, uriOther);
      }
    }
    void lineText;
    if (prefix.length > 0) {
      for (const [moduleName, members] of Object.entries(BUILTIN_MODULES)) {
        if (moduleName.startsWith(prefix)) continue;
        for (const memberName of Object.keys(members)) {
          if (!memberName.startsWith(prefix)) continue;
          items.push({
            label: memberName,
            kind: COMPLETION_KIND.Function,
            detail: members[memberName],
            documentation: members[memberName],
            sortText: `4_${memberName}`
          });
        }
      }
    }
    return items;
  }
  findMemberDefinition(surface, memberName) {
    if (surface === void 0) return void 0;
    const member = surface.members.find(
      (candidate) => candidate.name === memberName
    );
    if (member === void 0) return void 0;
    return {
      kind: member.kind,
      name: member.name,
      line: 0,
      column: 0,
      length: member.name.length,
      detail: member.detail
    };
  }
  /** Members of a built-in or workspace module after `from module import `. */
  completionForModuleMembers(moduleName) {
    const items = [];
    const surface = this.workspace.resolveModule(moduleName);
    if (surface !== void 0) {
      for (const member of surface.members) {
        items.push({
          label: member.name,
          kind: member.kind === "class" ? COMPLETION_KIND.Class : member.kind === "function" ? COMPLETION_KIND.Function : COMPLETION_KIND.Value,
          detail: member.detail ?? member.kind,
          sortText: `0_${member.name}`
        });
      }
    }
    const builtinMembers = BUILTIN_MODULES[moduleName.split(".")[0]];
    if (builtinMembers !== void 0) {
      for (const [memberName, doc] of Object.entries(builtinMembers)) {
        if (items.some((item) => item.label === memberName)) continue;
        const isValue = !doc.includes("(");
        items.push({
          label: memberName,
          kind: isValue ? COMPLETION_KIND.Value : COMPLETION_KIND.Function,
          detail: doc,
          documentation: doc,
          sortText: `0_${memberName}`
        });
      }
    }
    return items;
  }
  /** All importable modules for `import <CURSOR>` contexts. */
  completionForModules() {
    const items = [];
    for (const [moduleName, description] of Object.entries(
      MODULE_DESCRIPTIONS
    )) {
      items.push({
        label: moduleName,
        kind: COMPLETION_KIND.Module,
        detail: `[built-in] ${description}`,
        documentation: description,
        sortText: `0_${moduleName}`
      });
    }
    for (const surface of this.workspace.discoverModules()) {
      if (MODULE_DESCRIPTIONS[surface.name] !== void 0) continue;
      items.push({
        label: surface.name,
        kind: COMPLETION_KIND.Module,
        detail: surface.kind === "package" ? `[package] ${surface.path}` : `[module] ${surface.path}`,
        documentation: surface.members.map((member) => member.name).join(", "),
        sortText: `1_${surface.name}`
      });
    }
    return items;
  }
  /** Members after a `.` — based on the receiver chain. */
  completionForMember(receiverParts, uri) {
    const items = [];
    const addMember = (name, doc, kind) => {
      if (items.some((item) => item.label === name)) return;
      items.push({
        label: name,
        kind,
        detail: doc,
        documentation: doc,
        sortText: `0_${name}`
      });
    };
    const receiverName = receiverParts[receiverParts.length - 1];
    const { analysis } = this.analysisOf(uri);
    const imported = analysis.imports.find(
      (entry) => (entry.alias ?? entry.module.split(".")[0]) === receiverName
    );
    if (imported !== void 0) {
      this.completionForModuleMembers(imported.module).forEach(
        (item) => items.push(item)
      );
      const surface = this.workspace.resolveModule(imported.module);
      if (surface !== void 0) {
        for (const member of surface.members) {
          addMember(
            member.name,
            member.detail ?? member.kind,
            member.kind === "class" ? COMPLETION_KIND.Class : COMPLETION_KIND.Function
          );
        }
      }
      return items;
    }
    for (const typeName of Object.keys(TYPE_MEMBERS)) {
      if (typeName === receiverName) {
        for (const [memberName, doc] of Object.entries(
          TYPE_MEMBERS[typeName]
        )) {
          addMember(memberName, doc, COMPLETION_KIND.Method);
        }
      }
    }
    const { text } = this.analysisOf(uri);
    const constructorCall = /(\w+)\s*=\s*([A-Z]\w*)\s*\(/.exec(text);
    if (constructorCall !== null && constructorCall[1] === receiverName) {
      const typeName = constructorCall[2];
      for (const [memberName, doc] of Object.entries(
        TYPE_MEMBERS[typeName] ?? {}
      )) {
        addMember(memberName, doc, COMPLETION_KIND.Method);
      }
      for (const [, document] of this.workspace.documents) {
        const classPattern = new RegExp(
          `class\\s+${typeName}\\b[\\s\\S]*?(?=\\nclass\\b|$)`,
          "m"
        );
        const match = classPattern.exec(document.text);
        if (match === null) continue;
        const methodPattern = /def\s+(\w+)\s*\(([^)]*)\)/g;
        let methodMatch;
        while ((methodMatch = methodPattern.exec(match[0])) !== null) {
          if (methodMatch[1] === "__init__") continue;
          const parameters = methodMatch[2].split(",").map((parameter) => parameter.trim()).filter(Boolean).slice(1);
          addMember(
            methodMatch[1],
            `${methodMatch[1]}(${parameters.join(", ")}) \u2014 method of ${typeName}`,
            COMPLETION_KIND.Method
          );
        }
      }
      return items;
    }
    for (const [, document] of this.workspace.documents) {
      const classPattern = new RegExp(
        `class\\s+${receiverName}\\b[\\s\\S]*?(?=\\nclass\\b|$)`,
        "m"
      );
      const match = classPattern.exec(document.text);
      if (match === null) continue;
      const methodPattern = /def\s+(\w+)\s*\(([^)]*)\)/g;
      let methodMatch;
      while ((methodMatch = methodPattern.exec(match[0])) !== null) {
        const parameters = methodMatch[2].split(",").map((parameter) => parameter.trim()).filter(Boolean);
        addMember(
          methodMatch[1],
          `${methodMatch[1]}(${parameters.join(", ")})`,
          COMPLETION_KIND.Method
        );
      }
    }
    const builtin = BUILTIN_MODULES[receiverName];
    if (builtin !== void 0) {
      for (const [memberName, doc] of Object.entries(builtin))
        addMember(memberName, doc, COMPLETION_KIND.Function);
    }
    return items;
  }
  // -------------------------------------------------------------- goto/refs
  /** Resolve the definition location for the symbol at the position. */
  definition(uri, line, character) {
    const { text, analysis } = this.analysisOf(uri);
    const offset = this.offsetAt(text, line, character);
    const { word, start } = this.wordAt(text, offset);
    if (word === "") return [];
    const receiverChain = this.receiverChain(text, start + word.length + 1);
    if (receiverChain.length > 0) {
      const aliasName = receiverChain[0];
      const imported = analysis.imports.find(
        (entry) => (entry.alias ?? entry.module.split(".")[0]) === aliasName
      );
      if (imported !== void 0) {
        const surface = this.workspace.resolveModule(imported.module);
        const found = this.findMemberDefinition(surface, word);
        if (found !== void 0 && surface !== void 0 && !surface.path.startsWith("<")) {
          return [{ uri: pathToUri(surface.path), line: 0, character: 0 }];
        }
      }
    }
    const local = analysis.definitions.find(
      (definition) => definition.name === word && definition.kind !== "variable"
    );
    if (local !== void 0) {
      return [{ uri, line: local.line, character: local.column }];
    }
    for (const imported of analysis.imports) {
      if (imported.members.some(
        (member) => (member.alias ?? member.name) === word
      )) {
        const surface = this.workspace.resolveModule(imported.module);
        if (surface !== void 0 && !surface.path.startsWith("<")) {
          return [{ uri: pathToUri(surface.path), line: 0, character: 0 }];
        }
      }
      if ((imported.alias ?? imported.module.split(".")[0]) === word) {
        const surface = this.workspace.resolveModule(imported.module);
        if (surface !== void 0 && !surface.path.startsWith("<")) {
          return [{ uri: pathToUri(surface.path), line: 0, character: 0 }];
        }
      }
    }
    const matches = this.workspace.findDefinition(word, uri);
    return matches.map((match) => ({
      uri: match.uri,
      line: match.definition.line,
      character: match.definition.column
    }));
  }
  /** All references to the symbol, optionally including its declaration. */
  references(uri, line, character, includeDeclaration) {
    const { text, analysis } = this.analysisOf(uri);
    const offset = this.offsetAt(text, line, character);
    const { word } = this.wordAt(text, offset);
    if (word === "") return [];
    const results = [];
    if (includeDeclaration) {
      const declaration = analysis.definitions.find(
        (definition) => definition.name === word
      );
      if (declaration !== void 0)
        results.push({
          uri,
          line: declaration.line,
          character: declaration.column
        });
    }
    for (const reference of analysis.references) {
      if (reference.name === word)
        results.push({
          uri,
          line: reference.line,
          character: reference.column
        });
    }
    for (const [otherUri, document] of this.workspace.documents) {
      if (otherUri === uri) continue;
      const other = analyze(document.text);
      for (const reference of other.references) {
        if (reference.name === word)
          results.push({
            uri: otherUri,
            line: reference.line,
            character: reference.column
          });
      }
    }
    return results;
  }
  /** Rename: workspace edits covering declaration and references in-file. */
  rename(uri, line, character, newName) {
    if (!/^[A-Za-z_]\w*$/.test(newName)) return null;
    const locations = this.references(uri, line, character, true);
    if (locations.length === 0) return null;
    const changes = {};
    for (const location of locations) {
      const entry = {
        line: location.line,
        character: location.character,
        newLine: location.line,
        newCharacter: location.character
      };
      (changes[location.uri] ??= []).push(entry);
    }
    return { changes };
  }
  // ------------------------------------------------------------------- hover
  hover(uri, line, character) {
    const { text, analysis } = this.analysisOf(uri);
    const offset = this.offsetAt(text, line, character);
    const { word, start } = this.wordAt(text, offset);
    if (word === "") return null;
    const local = analysis.definitions.find(
      (definition) => definition.name === word && definition.kind !== "variable"
    );
    if (local !== void 0) {
      const header = local.detail ?? `${local.kind} ${word}`;
      return {
        contents: `thm
${header}${local.container !== void 0 ? `
(in ${local.container})` : ""}`
      };
    }
    const imported = analysis.imports.find(
      (entry) => (entry.alias ?? entry.module.split(".")[0]) === word
    );
    if (imported !== void 0) {
      const surface = this.workspace.resolveModule(imported.module);
      const memberList = surface !== void 0 ? surface.members.map((member) => member.name).join(", ") : "";
      const description = MODULE_DESCRIPTIONS[word] ?? (memberList !== "" ? `Members: ${memberList}` : imported.module);
      return { contents: `thm
module ${imported.module}
${description}` };
    }
    if (GLOBAL_FUNCTIONS[word] !== void 0)
      return { contents: `thm
${GLOBAL_FUNCTIONS[word]}` };
    if (GLOBAL_TYPES[word] !== void 0)
      return { contents: `thm
${GLOBAL_TYPES[word]}` };
    if (KEYWORD_HELP[word] !== void 0)
      return { contents: `thm
keyword ${word}
${KEYWORD_HELP[word]}` };
    if (BUILTIN_MODULES[word] !== void 0) {
      return {
        contents: `thm
module ${word}
${MODULE_DESCRIPTIONS[word] ?? ""}`
      };
    }
    void start;
    return null;
  }
  // ----------------------------------------------------------------- symbols
  documentSymbols(uri) {
    const { analysis } = this.analysisOf(uri);
    const kindFor = (definition) => {
      switch (definition.kind) {
        case "function":
          return 12;
        // Function
        case "class":
          return 5;
        // Class
        case "variable":
          return 13;
        // Variable
        case "import":
        case "importMember":
          return 9;
        // Module
        default:
          return 13;
      }
    };
    return analysis.definitions.map((definition) => ({
      name: definition.name,
      kind: kindFor(definition),
      range: { line: definition.line, character: definition.column },
      container: definition.container,
      detail: definition.detail
    }));
  }
  /** Flat search across open documents. */
  workspaceSymbols(query) {
    const results = [];
    const lowerQuery = query.toLowerCase();
    for (const [uri, document] of this.workspace.documents) {
      for (const symbol of this.documentSymbols(uri)) {
        if (lowerQuery === "" || symbol.name.toLowerCase().includes(lowerQuery)) {
          results.push({
            uri,
            name: symbol.name,
            kind: symbol.kind,
            line: symbol.range.line,
            character: symbol.range.character
          });
        }
      }
      void document;
    }
    return results;
  }
  // --------------------------------------------------------- signature help
  signatureHelp(uri, line, character) {
    const { text, analysis } = this.analysisOf(uri);
    const offset = this.offsetAt(text, line, character);
    if (offset < text.length && text[offset] === "(") {
      const beforeParen = text.slice(0, offset);
      const match = /([A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)*)\s*$/.exec(beforeParen);
      if (match !== null) {
        const callee = match[1].trim();
        return this.buildSignatureHelp({ callee, argumentIndex: 0 }, text, offset, analysis);
      }
    }
    const memberAccess = this.memberAccessAtCursor(text, offset);
    if (memberAccess !== null) {
      const { receiverParts, memberName } = memberAccess;
      if (receiverParts.length > 0) {
        const receiverName = receiverParts[receiverParts.length - 1];
        const imported = analysis.imports.find(
          (entry) => (entry.alias ?? entry.module.split(".")[0]) === receiverName
        );
        if (imported !== void 0) {
          const surface = this.workspace.resolveModule(imported.module);
          if (surface !== void 0) {
            const member = surface.members.find((m) => m.name === memberName);
            if (member !== void 0) {
              return this.signatureForMember(member, memberName);
            }
          }
          const builtinMembers = BUILTIN_MODULES[imported.module.split(".")[0]];
          if (builtinMembers !== void 0 && builtinMembers[memberName] !== void 0) {
            return this.signatureForBuiltinMember(memberName, builtinMembers[memberName]);
          }
        }
        const typeMembers = TYPE_MEMBERS[receiverName];
        if (typeMembers !== void 0 && typeMembers[memberName] !== void 0) {
          return this.signatureForBuiltinMember(memberName, typeMembers[memberName]);
        }
      }
    }
    const call = this.enclosingCall(text, offset);
    if (call !== void 0) {
      return this.buildSignatureHelp(call, text, offset, analysis);
    }
    const { word } = this.wordAt(text, offset);
    if (word !== "") {
      const builtin = GLOBAL_SIGNATURES[word];
      if (builtin !== void 0) {
        return {
          activeSignature: 0,
          activeParameter: 0,
          signature: {
            label: builtin.label,
            parameters: builtin.parameters.map((parameter) => ({
              label: parameter.label
            })),
            documentation: builtin.documentation
          }
        };
      }
      const userFunction = analysis.definitions.find(
        (definition) => definition.name === word && definition.parameters !== void 0
      );
      if (userFunction?.parameters !== void 0) {
        const labels = userFunction.parameters.map(
          (parameter) => parameter.kind === "vararg" ? `*${parameter.name}` : parameter.kind === "kwarg" ? `**${parameter.name}` : parameter.hasDefault ? `${parameter.name}=...` : parameter.name
        );
        return {
          activeSignature: 0,
          activeParameter: 0,
          signature: {
            label: `${word}(${labels.join(", ")})`,
            parameters: labels.map((label) => ({ label })),
            documentation: userFunction.container !== void 0 ? `method of ${userFunction.container}` : ""
          }
        };
      }
    }
    return { activeSignature: 0, activeParameter: 0, signature: null };
  }
  /**
   * Check if cursor is on a member access pattern (receiver.member|).
   * Returns the receiver parts and member name being typed.
   */
  memberAccessAtCursor(text, offset) {
    const before = text.slice(0, offset);
    const lastDotIndex = before.lastIndexOf(".");
    if (lastDotIndex === -1) return null;
    const beforeDot = before.slice(0, lastDotIndex);
    const match = /([A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)*)$/.exec(beforeDot);
    if (match === null) return null;
    const receiverParts = match[1].split(".").map((part) => part.trim());
    const { word } = this.wordAt(text, offset);
    if (word === "") return null;
    return { receiverParts, memberName: word };
  }
  buildSignatureHelp(call, text, offset, analysis) {
    const builtin = GLOBAL_SIGNATURES[call.callee];
    if (builtin !== void 0) {
      return {
        activeSignature: 0,
        activeParameter: Math.min(
          call.argumentIndex,
          Math.max(0, builtin.parameters.length - 1)
        ),
        signature: {
          label: builtin.label,
          parameters: builtin.parameters.map((parameter) => ({
            label: parameter.label
          })),
          documentation: builtin.documentation
        }
      };
    }
    const userFunction = analysis.definitions.find(
      (definition) => definition.name === call.callee && definition.parameters !== void 0
    );
    if (userFunction?.parameters !== void 0) {
      const labels = userFunction.parameters.map(
        (parameter) => parameter.kind === "vararg" ? `*${parameter.name}` : parameter.kind === "kwarg" ? `**${parameter.name}` : parameter.hasDefault ? `${parameter.name}=...` : parameter.name
      );
      const keywordNames = this.keywordArgumentsBefore(text, offset);
      let activeParameter = Math.min(
        call.argumentIndex,
        Math.max(0, labels.length - 1)
      );
      const typedName = keywordNames[keywordNames.length - 1];
      if (typedName !== void 0) {
        const match = labels.findIndex(
          (label) => label.replace(/^\*+|=...$/, "") === typedName
        );
        if (match >= 0) activeParameter = match;
      }
      return {
        activeSignature: 0,
        activeParameter,
        signature: {
          label: `${call.callee}(${labels.join(", ")})`,
          parameters: labels.map((label) => ({ label })),
          documentation: userFunction.container !== void 0 ? `method of ${userFunction.container}` : ""
        }
      };
    }
    return {
      activeSignature: 0,
      activeParameter: call.argumentIndex,
      signature: null
    };
  }
  signatureForMember(member, name) {
    return {
      activeSignature: 0,
      activeParameter: 0,
      signature: {
        label: `${name}()`,
        parameters: [],
        documentation: member.detail ?? member.kind
      }
    };
  }
  signatureForBuiltinMember(name, doc) {
    const open = doc.indexOf("(");
    const close = doc.indexOf(")", open);
    const parameterText = open >= 0 && close > open ? doc.slice(open + 1, close) : "";
    const label = doc.split("\u2014")[0].trim();
    return {
      activeSignature: 0,
      activeParameter: 0,
      signature: {
        label,
        parameters: parameterText.split(",").map((part) => part.trim()).filter((part) => part !== "").map((part) => ({
          label: part.replace(/^\*\*/, "**").replace(/^\*/, "*")
        })),
        documentation: doc.slice(doc.indexOf("\u2014") + 1).trim() || doc
      }
    };
  }
  keywordArgumentsBefore(text, offset) {
    const before = text.slice(0, offset);
    let depth = 0;
    let calleeStart = -1;
    let calleeEnd = -1;
    let inString = false;
    let stringQuote = "";
    let escapeNext = false;
    for (let i = before.length - 1; i >= 0; i--) {
      const ch = before[i];
      const nextCh = before[i + 1] ?? "";
      if (!inString && (ch === '"' || ch === "'")) {
        if (i >= 2 && before[i - 2] === ch && before[i - 1] === ch) {
          inString = true;
          stringQuote = ch.repeat(3);
          i -= 2;
        } else {
          inString = true;
          stringQuote = ch;
        }
        continue;
      }
      if (inString) {
        if (escapeNext) {
          escapeNext = false;
        } else if (ch === "\\") {
          escapeNext = true;
        } else if (stringQuote.length === 1 && ch === stringQuote || stringQuote.length === 3 && i >= 2 && before[i - 2] === ch && before[i - 1] === ch && ch === stringQuote[0]) {
          inString = false;
          if (stringQuote.length === 3) i -= 2;
        }
        continue;
      }
      if (ch === ")" || ch === "]" || ch === "}") {
        depth++;
      } else if (ch === "(" || ch === "[" || ch === "{") {
        depth--;
        if (depth === 0) {
          let j = i - 1;
          while (j >= 0 && /\s/.test(before[j])) j--;
          calleeEnd = j + 1;
          while (j >= 0 && /[A-Za-z0-9_.]/.test(before[j])) j--;
          calleeStart = j + 1;
          break;
        }
      }
    }
    if (calleeStart === -1 || calleeEnd === -1) return [];
    const argumentPart = before.slice(calleeEnd + 1);
    const names = [];
    let argDepth = 0;
    let inStr = false;
    let strQuote = "";
    let escNext = false;
    let currentToken = "";
    let inKeyword = false;
    for (const ch of argumentPart) {
      if (!inStr && (ch === '"' || ch === "'")) {
        inStr = true;
        strQuote = ch;
        continue;
      }
      if (inStr) {
        if (escNext) escNext = false;
        else if (ch === "\\") escNext = true;
        else if (ch === strQuote) inStr = false;
        continue;
      }
      if (ch === "(" || ch === "[" || ch === "{") argDepth++;
      else if (ch === ")" || ch === "]" || ch === "}") argDepth--;
      if (argDepth === 0) {
        if (/[A-Za-z0-9_]/.test(ch)) {
          currentToken += ch;
          inKeyword = true;
        } else if (ch === "=" && inKeyword && currentToken.length > 0) {
          names.push(currentToken);
          currentToken = "";
          inKeyword = false;
        } else if (ch === ",") {
          currentToken = "";
          inKeyword = false;
        } else if (!/\s/.test(ch)) {
          currentToken = "";
          inKeyword = false;
        }
      }
    }
    return names;
  }
  /**
   * Kwarg-specific suggestions for a call: parameter names of the target
   * function that have not been used yet.
   */
  kwargSuggestions(uri, line, character) {
    const { text, analysis } = this.analysisOf(uri);
    const offset = this.offsetAt(text, line, character);
    const call = this.enclosingCall(text, offset);
    if (call === void 0) return [];
    const used = new Set(this.keywordArgumentsBefore(text, offset));
    const target = analysis.definitions.find(
      (definition) => definition.name === call.callee && definition.parameters !== void 0
    );
    const suggestions = [];
    if (target?.parameters !== void 0) {
      for (const parameter of target.parameters) {
        if (parameter.kind === "kwarg" || parameter.kind === "vararg") continue;
        if (!used.has(parameter.name)) suggestions.push(`${parameter.name}=`);
      }
    }
    for (const name of Object.keys(
      GLOBAL_SIGNATURES[call.callee]?.parameters ?? {}
    ).length > 0 ? GLOBAL_SIGNATURES[call.callee].parameters.map(
      (parameter) => parameter.label.replace(/=.*/, "")
    ) : []) {
      if (!used.has(name)) suggestions.push(`${name}=`);
    }
    return suggestions;
  }
  // ------------------------------------------------------------- diagnostics
  diagnose(uri) {
    const { text } = this.analysisOf(uri);
    const diagnostics = [];
    const tokens = tokenize(text);
    for (const token of tokens) {
      if (token.kind === "error") {
        diagnostics.push({
          line: token.line,
          character: token.column,
          message: token.value.startsWith('"') || token.value.startsWith("'") ? "Unterminated string literal" : `Unexpected character '${token.value}'`,
          severity: 1
        });
      }
    }
    let depth = 0;
    for (const token of tokens) {
      if (token.kind !== "operator") continue;
      if ("([{".includes(token.value)) depth++;
      if (")]}".includes(token.value)) depth--;
      if (depth < 0) {
        diagnostics.push({
          line: token.line,
          character: token.column,
          message: "Unmatched closing bracket",
          severity: 1
        });
        depth = 0;
      }
    }
    if (depth > 0) {
      const last = tokens[tokens.length - 1];
      diagnostics.push({
        line: last.line,
        character: last.column,
        message: `${depth} unclosed bracket(s) at end of file`,
        severity: 1
      });
    }
    const lines = text.split("\n");
    lines.forEach((lineText, index) => {
      const assertMatch = /^\s*assert\s+(.+)$/.exec(lineText);
      if (assertMatch !== null) {
        const condition = assertMatch[1].split(",")[0].trim();
        if (/^[A-Z]\w*(Error)?\s*\(/.test(condition)) {
          diagnostics.push({
            line: index,
            character: lineText.indexOf("assert"),
            message: `assert '${condition}...' constructs an exception object (always truthy) \u2014 use 'raise' to throw, or assert a boolean condition`,
            severity: 2
          });
        }
      }
    });
    const { analysis } = { analysis: analyze(text) };
    for (const imported of analysis.imports) {
      const root = imported.module.split(".")[0];
      if (BUILTIN_MODULES[root] !== void 0) continue;
      if (this.workspace.resolveModule(imported.module) !== void 0) continue;
      if (this.resolvableAsLocalFile(root)) continue;
      diagnostics.push({
        line: imported.line,
        character: 0,
        message: `Cannot resolve module '${imported.module}'`,
        severity: 2
      });
    }
    return diagnostics;
  }
  resolvableAsLocalFile(name) {
    try {
      return (0, import_fs.existsSync)(`${name}.thm`);
    } catch {
      return false;
    }
  }
  // ---------------------------------------------------------------- position
  lineAt(text, line) {
    const lines = text.split("\n");
    return { lineText: lines[line] ?? "" };
  }
  offsetAt(text, line, character) {
    return offsetToPosition(text, line, character).offset;
  }
};

// src/semantic.ts
var fs2 = __toESM(require("fs"));

// src/type-system.ts
var ANY = { kind: "any" };
var NEVER = { kind: "never" };
var NONE = { kind: "none" };
var primitive = (name) => ({ kind: "primitive", name });
var T = (name) => ({ kind: "variable", name });
function unionType(...types) {
  const flat = [];
  for (const t of types) for (const x of t.kind === "union" ? t.items : [t]) {
    if (x.kind === "never") continue;
    if (x.kind === "any") return ANY;
    if (!flat.some((y) => typeToString(y) === typeToString(x))) flat.push(x);
  }
  if (!flat.length) return NEVER;
  if (flat.length === 1) return flat[0];
  return { kind: "union", items: flat };
}
var optionalType = (t) => unionType(t, NONE);
function typeToString(t) {
  switch (t.kind) {
    case "any":
      return "Any";
    case "never":
      return "Never";
    case "none":
      return "None";
    case "primitive":
      return t.name;
    case "literal":
      return `Literal[${JSON.stringify(t.value)}]`;
    case "variable":
      return t.name;
    case "generic":
      return `${t.name}[${t.args.map(typeToString).join(", ")}]`;
    case "protocol":
      return t.name;
    case "union":
      return t.items.map(typeToString).join(" | ");
  }
}
function isSubtype(a, b) {
  if (a.kind === "never" || b.kind === "any" || a.kind === "any") return true;
  if (b.kind === "union") return b.items.some((x) => isSubtype(a, x));
  if (a.kind === "union") return a.items.every((x) => isSubtype(x, b));
  if (a.kind === "literal") return isSubtype(primitive(a.base), b);
  if (a.kind === "none") return b.kind === "none";
  if (a.kind === "primitive" && b.kind === "primitive") {
    if (a.name === b.name) return true;
    return a.name === "bool" && b.name === "int";
  }
  if (a.kind === "generic" && b.kind === "generic" && a.name === b.name)
    return a.args.length === b.args.length && a.args.every((x, i) => isSubtype(x, b.args[i]));
  if (b.kind === "protocol" && a.kind === "protocol")
    return Object.entries(b.members).every(([k, v]) => a.members[k] && isSubtype(a.members[k], v));
  return false;
}
function assignable(actual, expected) {
  return isSubtype(actual, expected);
}
var TYPE_NAMES = /* @__PURE__ */ new Set(["Any", "Never", "None", "int", "float", "str", "bool", "bytes", "object", "list", "dict", "tuple", "set", "type", "complex"]);
function parseType(raw) {
  const s = raw.trim();
  if (!s || s === "Any" || s === "any") return ANY;
  if (s === "Never" || s === "NoReturn") return NEVER;
  if (s === "None" || s === "NoneType") return NONE;
  if (s.includes("|")) return unionType(...splitTop(s, "|").map(parseType));
  const m = /^([A-Za-z_]\w*)\[(.*)\]$/.exec(s);
  if (m) {
    const args2 = splitTop(m[2], ",").map(parseType);
    if (m[1] === "Optional") return optionalType(args2[0] ?? ANY);
    if (m[1] === "Union") return unionType(...args2);
    if (m[1] === "Literal") return { kind: "union", items: splitTop(m[2], ",").map((v) => literalType(v.trim())) };
    return { kind: "generic", name: m[1], args: args2 };
  }
  if (/^[A-Z]\w*$/.test(s) && !TYPE_NAMES.has(s)) return T(s);
  return primitive(s);
}
function splitTop(s, sep) {
  const out = [];
  let depth = 0, quote = "", start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote && s[i - 1] !== "\\\\") quote = "";
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if ("[({".includes(c)) depth++;
    else if ("])}".includes(c)) depth--;
    if (depth === 0 && s.startsWith(sep, i)) {
      out.push(s.slice(start, i));
      start = i + sep.length;
      i += sep.length - 1;
    }
  }
  out.push(s.slice(start));
  return out;
}
function literalType(raw) {
  if (raw === "True" || raw === "False") return { kind: "literal", value: raw === "True", base: "bool" };
  if (raw === "None") return NONE;
  if (/^['"]/.test(raw)) return { kind: "literal", value: raw.slice(1, -1), base: "str" };
  const n = Number(raw);
  if (Number.isFinite(n)) return { kind: "literal", value: n, base: Number.isInteger(n) ? "int" : "float" };
  return ANY;
}
function parseExpr(raw) {
  const s = raw.trim();
  if (!s) return { kind: "unknown", children: [] };
  if (/^(True|False|None|-?\d+(?:\.\d+)?)$/.test(s) || /^['"]/.test(s)) return { kind: "literal", value: s, children: [] };
  if (/^[A-Za-z_]\w*$/.test(s)) return { kind: "name", value: s, children: [] };
  const call = /^([A-Za-z_]\w*)\((.*)\)$/.exec(s);
  if (call) return { kind: "call", value: call[1], children: splitTop(call[2], ",").map(parseExpr) };
  const member = /^(.+)\.([A-Za-z_]\w*)$/.exec(s);
  if (member) return { kind: "member", value: member[2], children: [parseExpr(member[1])] };
  const index = /^(.+)\[(.*)\]$/.exec(s);
  if (index) return { kind: "index", children: [parseExpr(index[1]), parseExpr(index[2])] };
  if (s.startsWith("[") && s.endsWith("]")) return { kind: "list", children: splitTop(s.slice(1, -1), ",").filter(Boolean).map(parseExpr) };
  if (s.startsWith("{") && s.endsWith("}")) return { kind: "dict", children: splitTop(s.slice(1, -1), ",").filter(Boolean).map((x) => parseExpr(x.split(":").slice(1).join(":"))) };
  for (const op of [" is not ", " is ", " == ", " != ", " >= ", " <= ", " + ", " - ", " * ", " / ", " // ", " % ", " and ", " or "]) {
    const p = splitTop(s, op.trim());
    if (p.length > 1) return { kind: "binary", value: op.trim(), children: p.map(parseExpr) };
  }
  return { kind: "unknown", value: s, children: [] };
}
function inferExpr(e, env) {
  switch (e.kind) {
    case "literal":
      return literalType(e.value ?? "");
    case "name":
      return env.get(e.value ?? "") ?? ANY;
    case "list":
      return { kind: "generic", name: "list", args: [unionType(...e.children.map((x) => inferExpr(x, env)))] };
    case "dict":
      return { kind: "generic", name: "dict", args: [ANY, unionType(...e.children.map((x) => inferExpr(x, env)))] };
    case "member":
      return ANY;
    case "index": {
      const base = inferExpr(e.children[0], env);
      return base.kind === "generic" ? base.name === "dict" ? base.args[1] ?? ANY : base.args[0] ?? ANY : ANY;
    }
    case "call": {
      const args2 = e.children.map((x) => inferExpr(x, env));
      const n = e.value ?? "";
      if (n === "int" || n === "float" || n === "str" || n === "bool" || n === "bytes") return primitive(n);
      if (n === "list") return { kind: "generic", name: "list", args: [args2[0] ?? ANY] };
      if (n === "dict") return { kind: "generic", name: "dict", args: [ANY, ANY] };
      if (n === "len" || n === "ord" || n === "hash" || n === "id") return primitive("int");
      if (n === "str" || n === "repr") return primitive("str");
      if (n === "isinstance") return primitive("bool");
      if (n === "range") return { kind: "generic", name: "range", args: [primitive("int")] };
      if (n === "open") return primitive("File");
      return ANY;
    }
    case "binary": {
      const ts = e.children.map((x) => inferExpr(x, env));
      if (["==", "!=", "is", "is not", ">=", "<=", "and", "or"].includes(e.value ?? "")) return primitive("bool");
      if (ts.some((t) => typeToString(t) === "str")) return primitive("str");
      if (ts.every((t) => isSubtype(t, primitive("int")))) return primitive("int");
      if (ts.some((t) => isSubtype(t, primitive("float")))) return primitive("float");
      return ANY;
    }
    default:
      return ANY;
  }
}
function parseAst(source) {
  const lines = source.split(/\r\n|\n|\r/);
  const root = [];
  const stack = [];
  let braceDepth = 0;
  for (let line = 0; line < lines.length; line++) {
    const raw = lines[line], trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;
    while (stack.length && indent <= stack[stack.length - 1].indent && braceDepth === 0) stack.pop();
    const parent = stack[stack.length - 1]?.node;
    const body = parent?.children ?? root;
    const mk = (kind, name, annotation, expression) => ({ kind, line, column: indent, endColumn: raw.length, indent, name, annotation, expression, raw, children: [] });
    let node;
    let m;
    if (m = /^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/.exec(trimmed)) node = mk("def", m[1]);
    else if (m = /^class\s+([A-Za-z_]\w*)/.exec(trimmed)) node = mk("class", m[1]);
    else if (m = /^(if|elif|while)\s+(.+?)\s*(?:do)?\s*\{?$/.exec(trimmed)) {
      node = mk(m[1]);
      node.condition = parseExpr(m[2]);
    } else if (/^(else)\s*(?:do)?\s*\{?$/.test(trimmed)) node = mk("else");
    else if (m = /^for\s+([A-Za-z_]\w*)\s+in\s+(.+?)\s*(?:do)?\s*\{?$/.exec(trimmed)) {
      node = mk("for", m[1], void 0, parseExpr(m[2]));
    } else if (m = /^return(?:\s+(.+))?$/.exec(trimmed)) node = mk("return", void 0, void 0, parseExpr(m[1] ?? ""));
    else if (m = /^raise(?:\s+(.+))?$/.exec(trimmed)) node = mk("raise", void 0, void 0, parseExpr(m[1] ?? ""));
    else if (m = /^([A-Za-z_]\w*)\s*:\s*([^=]+?)(?:\s*=\s*(.+))?$/.exec(trimmed)) node = mk("annotate", m[1], parseType(m[2]), m[3] ? parseExpr(m[3]) : void 0);
    else if (m = /^([A-Za-z_]\w*)\s*(?:\+=|-=|\*=|\/=|=)\s*(.+)$/.exec(trimmed)) node = mk("assign", m[1], void 0, parseExpr(m[2]));
    else if (trimmed === "pass") node = mk("pass");
    else node = mk("expr", void 0, void 0, parseExpr(trimmed.replace(/[;{}]+$/g, "")));
    body.push(node);
    if (/[{:]$/.test(trimmed) || ["if", "elif", "else", "while", "for", "def", "class"].includes(node.kind)) stack.push({ indent, node });
    const opens = (trimmed.match(/{/g) || []).length, closes = (trimmed.match(/}/g) || []).length;
    braceDepth = Math.max(0, braceDepth + opens - closes);
    if (closes > 0) {
      while (stack.length && braceDepth === 0) stack.pop();
    }
  }
  return { kind: "module", body: root };
}
function buildCfg(ast) {
  const blocks = [{ id: 0, successors: [], predecessors: [] }];
  let current = 0;
  const add = (statement) => {
    const b = { id: blocks.length, statement, successors: [], predecessors: [] };
    blocks.push(b);
    blocks[current].successors.push(b.id);
    b.predecessors.push(current);
    current = b.id;
    return b.id;
  };
  const walk = (items) => {
    for (const st of items) {
      const id = add(st);
      if (st.kind === "if" || st.kind === "while" || st.kind === "for") {
        const branchStart = current;
        walk(st.children);
        const join2 = blocks.length;
        const j = { id: join2, successors: [], predecessors: [] };
        blocks.push(j);
        blocks[branchStart].successors.push(join2);
        j.predecessors.push(branchStart);
        if (current !== branchStart) {
          blocks[current].successors.push(join2);
          j.predecessors.push(current);
        }
        current = join2;
      } else if (st.children.length) walk(st.children);
    }
  };
  walk(ast.body);
  const exit = add();
  return { entry: 0, exit, blocks };
}
function checkTypes(source) {
  const ast = parseAst(source), cfg = buildCfg(ast), diagnostics = [];
  const env = /* @__PURE__ */ new Map(), annotations = /* @__PURE__ */ new Map(), returns = [];
  const report = (st, msg, code) => diagnostics.push({ line: st.line, start: st.column, end: Math.max(st.column + 1, st.endColumn), message: msg, code });
  const visit = (items, local) => {
    for (const st of items) {
      if (st.kind === "annotate" && st.name && st.annotation) {
        annotations.set(st.name, st.annotation);
        if (st.expression) {
          const actual = inferExpr(st.expression, local);
          if (!assignable(actual, st.annotation)) report(st, `Type '${typeToString(actual)}' is not assignable to '${typeToString(st.annotation)}'`, "type-mismatch");
          local.set(st.name, st.annotation);
        } else local.set(st.name, st.annotation);
      } else if (st.kind === "assign" && st.name && st.expression) {
        const actual = inferExpr(st.expression, local), expected = annotations.get(st.name);
        if (expected && !assignable(actual, expected)) report(st, `Type '${typeToString(actual)}' is not assignable to '${typeToString(expected)}'`, "type-mismatch");
        local.set(st.name, expected ?? actual);
      } else if (st.kind === "return" && st.expression) returns.push(inferExpr(st.expression, local));
      else if (st.kind === "for" && st.name) {
        local.set(st.name, primitive("int"));
        visit(st.children, new Map(local));
      } else if (st.kind === "if" || st.kind === "elif" || st.kind === "while") {
        const branch = new Map(local);
        const cond = st.condition;
        if (cond?.kind === "binary" && cond.value === "is not" && cond.children[0]?.kind === "name" && cond.children[1]?.value === "None") {
          const n = cond.children[0].value;
          const old = branch.get(n);
          if (old?.kind === "union") branch.set(n, unionType(...old.items.filter((x) => x.kind !== "none")));
        }
        visit(st.children, branch);
        for (const [k, v] of branch) local.set(k, unionType(local.get(k) ?? v, v));
      } else if (st.children.length) visit(st.children, new Map(local));
    }
  };
  visit(ast.body, env);
  const inStates = /* @__PURE__ */ new Map([[cfg.entry, /* @__PURE__ */ new Map()]]);
  for (let pass = 0; pass < Math.min(32, cfg.blocks.length * 2); pass++) {
    let changed = false;
    for (const block of cfg.blocks) {
      const incoming = block.predecessors.map((p) => inStates.get(p)).filter((x) => !!x);
      const merged = /* @__PURE__ */ new Map();
      for (const state of incoming) for (const [k, v] of state) merged.set(k, unionType(merged.get(k) ?? v, v));
      if (block.statement?.kind === "assign" && block.statement.name && block.statement.expression) merged.set(block.statement.name, inferExpr(block.statement.expression, merged));
      const prev = inStates.get(block.id);
      const signature = (m) => [...m].map(([k, v]) => k + ":" + typeToString(v)).sort().join("|");
      if (!prev || signature(prev) !== signature(merged)) {
        inStates.set(block.id, merged);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return { ast, cfg, diagnostics, types: env };
}

// src/semantic.ts
var LspError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
  code;
};
var SEMANTIC_TOKEN_TYPES = [
  "namespace",
  "class",
  "function",
  "method",
  "property",
  "variable",
  "parameter",
  "type",
  "decorator"
];
var SEMANTIC_TOKEN_MODIFIERS = [
  "declaration",
  "readonly",
  "defaultLibrary",
  "async"
];
var SYMBOL_KIND = {
  Module: 2,
  Class: 5,
  Method: 6,
  Property: 7,
  Field: 8,
  Constructor: 9,
  Function: 12,
  Variable: 13,
  Constant: 14
};
var IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
var SemanticProvider = class {
  constructor(workspace) {
    this.workspace = workspace;
  }
  workspace;
  sortedCache = /* @__PURE__ */ new WeakMap();
  tokenIndexCache = /* @__PURE__ */ new WeakMap();
  // ------------------------------------------------------------------ basics
  docOf(uri) {
    const open = this.workspace.get(uri);
    if (open !== void 0) return open;
    if (!uri.startsWith("file://")) return void 0;
    return this.workspace.loadByPath(uriToPath(uri));
  }
  sorted(binding) {
    let list = this.sortedCache.get(binding);
    if (list === void 0) {
      list = [...binding.occurrences].sort((a, b) => a.offset - b.offset);
      this.sortedCache.set(binding, list);
    }
    return list;
  }
  occurrenceAt(doc, offset) {
    const list = this.sorted(doc.binding);
    let lo = 0;
    let hi = list.length - 1;
    let found;
    while (lo <= hi) {
      const mid = lo + hi >> 1;
      if (list[mid].offset <= offset) {
        found = list[mid];
        lo = mid + 1;
      } else hi = mid - 1;
    }
    for (let i = lo - 1; i >= Math.max(0, lo - 3); i--) {
      const candidate = list[i];
      if (offset >= candidate.offset && offset <= candidate.offset + candidate.length) return candidate;
    }
    void found;
    return void 0;
  }
  rangeOfOcc(doc, occurrence) {
    return doc.lines.rangeOf(occurrence.offset, occurrence.length);
  }
  locationOfSym(doc, sym) {
    return { uri: doc.uri, range: doc.lines.rangeOf(sym.offset, sym.length) };
  }
  lookup(scope, name, moduleScope) {
    if (scope.globals.has(name)) return moduleScope.symbols.get(name);
    let cursor = scope;
    let first = true;
    while (cursor !== void 0) {
      if (cursor.kind !== "class" || first) {
        const found = cursor.symbols.get(name);
        if (found !== void 0) return found;
      }
      first = false;
      cursor = cursor.parent;
    }
    return void 0;
  }
  documentForSymbol(sym, fallback) {
    if (fallback.binding.symbols.includes(sym)) return fallback;
    for (const open of this.workspace.documents.values()) if (open.binding.symbols.includes(sym)) return open;
    for (const file of this.workspace.listThmFiles()) {
      const candidate = this.workspace.loadByPath(file);
      if (candidate?.binding.symbols.includes(sym)) return candidate;
    }
    return fallback;
  }
  resolveClassName(doc, scope, name) {
    const found = this.lookup(scope, name, doc.binding.module);
    if (found?.kind === "class") return found;
    if (found?.kind === "importMember" && found.module !== void 0) {
      const file = this.workspace.resolveModuleFile(found.module, doc.filePath);
      if (file !== void 0) {
        const exported = this.exportedSymbol(file, found.member ?? name);
        if (exported?.sym.kind === "class") return exported.sym;
      }
    }
    return void 0;
  }
  classScopeOf(doc, classSym) {
    return doc.binding.scopes.find((scope) => scope.kind === "class" && scope.owner === classSym);
  }
  /** C3 linearization, matching Python's deterministic multiple-inheritance MRO. */
  classMro(doc, cls, active = /* @__PURE__ */ new Set()) {
    if (active.has(cls)) return [cls];
    const nextActive = new Set(active);
    nextActive.add(cls);
    const ownerDoc = this.documentForSymbol(cls, doc);
    const bases = (cls.bases ?? []).map((baseName) => this.resolveClassName(ownerDoc, cls.scope, baseName)).filter((base) => base?.kind === "class");
    if (bases.length === 0) return [cls];
    const sequences = bases.map((base) => this.classMro(doc, base, nextActive));
    sequences.push([...bases]);
    const result = [cls];
    while (sequences.some((sequence) => sequence.length > 0)) {
      let candidate;
      for (const sequence of sequences) {
        const head = sequence[0];
        if (head !== void 0 && !sequences.some((other) => other.slice(1).includes(head))) {
          candidate = head;
          break;
        }
      }
      if (candidate === void 0) {
        for (const sequence of sequences) for (const item of sequence)
          if (!result.includes(item)) result.push(item);
        break;
      }
      if (!result.includes(candidate)) result.push(candidate);
      for (const sequence of sequences) if (sequence[0] === candidate) sequence.shift();
    }
    return result;
  }
  memberOfClass(doc, classSym, name) {
    for (const current of this.classMro(doc, classSym)) {
      const ownerDoc = this.documentForSymbol(current, doc);
      const direct = this.classScopeOf(ownerDoc, current)?.symbols.get(name);
      if (direct !== void 0) return direct;
    }
    return void 0;
  }
  tokenIndex(binding) {
    let map = this.tokenIndexCache.get(binding);
    if (map === void 0) {
      map = /* @__PURE__ */ new Map();
      binding.tokens.forEach((token, index) => map.set(token.offset, index));
      this.tokenIndexCache.set(binding, map);
    }
    return map;
  }
  /** Very small type inference: `x = Foo(...)`, `x: Foo`, `self`. */
  inferClass(doc, sym, atOffset = Number.POSITIVE_INFINITY) {
    if (sym.kind === "class") return sym;
    if (sym.kind === "parameter" && (sym.name === "self" || sym.name === "cls")) {
      const owner = sym.scope.owner;
      const classScope = owner?.scope;
      if (classScope?.kind === "class") return classScope.owner;
    }
    if (sym.annotation !== void 0) {
      const bare = /^[A-Za-z_]\w*/.exec(sym.annotation)?.[0];
      if (bare !== void 0) {
        const found = this.resolveClassName(doc, sym.scope, bare);
        if (found?.kind === "class") return found;
      }
    }
    if (sym.kind === "variable" || sym.kind === "parameter") {
      const writes = sym.occurrences.filter((occurrence) => occurrence.isWrite && occurrence.offset <= atOffset).sort((a, b) => b.offset - a.offset);
      const tokens = doc.binding.tokens;
      for (const write of writes) {
        const index = this.tokenIndex(doc.binding).get(write.offset);
        if (index === void 0) continue;
        let k = index + 1;
        if (tokens[k]?.value === ":") {
          const annStart = k + 1;
          const ann = tokens[annStart];
          if (ann?.kind === "identifier") {
            const found = this.resolveClassName(doc, write.scope, ann.value);
            if (found?.kind === "class") return found;
          }
          while (k < tokens.length && tokens[k].value !== "=" && tokens[k].kind !== "newline") k++;
        }
        if (tokens[k]?.value !== "=") continue;
        const rhs = tokens[k + 1];
        if (rhs?.kind === "identifier" && tokens[k + 2]?.value === "(") {
          const callee = this.resolveClassName(doc, write.scope, rhs.value);
          if (callee?.kind === "class") return callee;
        }
        if (rhs?.kind === "identifier") {
          const source = this.lookup(write.scope, rhs.value, doc.binding.module);
          if (source !== void 0 && source !== sym) {
            const inferred = this.inferClass(doc, source, write.offset);
            if (inferred !== void 0) return inferred;
          }
        }
      }
    }
    return void 0;
  }
  /** Resolve what an occurrence refers to (including attributes). */
  resolveOccurrence(doc, occurrence) {
    const moduleScope = doc.binding.module;
    if (occurrence.symbol !== void 0) return { doc, sym: occurrence.symbol };
    if (occurrence.isKeywordArg && occurrence.callee !== void 0) {
      const fn = this.lookup(occurrence.scope, occurrence.callee, moduleScope);
      const target = fn?.kind === "class" ? this.memberOfClass(doc, fn, "__init__") : fn;
      const params = target === void 0 ? void 0 : this.paramSymbols(doc, target);
      const param = params?.get(occurrence.name);
      if (param !== void 0) return { doc, sym: param };
      return void 0;
    }
    if (occurrence.isAttribute && occurrence.receiver !== void 0) {
      const receiverSym = this.lookup(occurrence.scope, occurrence.receiver, moduleScope);
      if (receiverSym === void 0) return void 0;
      if (receiverSym.kind === "import" && receiverSym.module !== void 0) {
        const file = this.workspace.resolveModuleFile(receiverSym.module, doc.filePath);
        if (file !== void 0) {
          const member = this.exportedSymbol(file, occurrence.name);
          if (member !== void 0) return member;
        }
        return void 0;
      }
      const cls = this.inferClass(doc, receiverSym, occurrence.offset);
      if (cls !== void 0) {
        const member = this.memberOfClass(doc, cls, occurrence.name);
        if (member !== void 0) return { doc, sym: member };
      }
    }
    return void 0;
  }
  paramSymbols(doc, fn) {
    const scope = doc.binding.scopes.find((candidate) => candidate.owner === fn && candidate.kind === "function");
    if (scope === void 0) return void 0;
    const result = /* @__PURE__ */ new Map();
    for (const [name, sym] of scope.symbols) if (sym.kind === "parameter") result.set(name, sym);
    return result;
  }
  /** Top-level symbol exported by a file, following one level of re-export. */
  exportedSymbol(filePath, name, depth = 0) {
    const target = this.workspace.loadByPath(filePath);
    if (target === void 0) return void 0;
    const sym = target.binding.module.symbols.get(name);
    if (sym === void 0) return void 0;
    if (sym.kind === "importMember" && sym.module !== void 0 && depth < 4) {
      const next = this.workspace.resolveModuleFile(sym.module, target.filePath);
      if (next !== void 0) {
        const inner = this.exportedSymbol(next, sym.member ?? name, depth + 1);
        if (inner !== void 0) return inner;
      }
    }
    return { doc: target, sym };
  }
  // -------------------------------------------------------------- navigation
  definition(uri, position) {
    const doc = this.docOf(uri);
    if (doc === void 0) return [];
    const offset = doc.lines.offsetAt(position.line, position.character);
    const importRecord = doc.binding.imports.find(
      (record) => offset >= record.moduleOffset && offset <= record.moduleOffset + record.moduleLength
    );
    if (importRecord !== void 0) {
      const file = this.workspace.resolveModuleFile(importRecord.module, doc.filePath);
      return file === void 0 ? [] : [fileStart(file)];
    }
    const occurrence = this.occurrenceAt(doc, offset);
    if (occurrence === void 0) return [];
    const resolved = this.resolveOccurrence(doc, occurrence);
    if (resolved === void 0) return [];
    const { sym } = resolved;
    if ((sym.kind === "importMember" || sym.kind === "import") && sym.module !== void 0) {
      const file = this.workspace.resolveModuleFile(sym.module, resolved.doc.filePath);
      if (file !== void 0) {
        if (sym.kind === "importMember") {
          const exported = this.exportedSymbol(file, sym.member ?? sym.name);
          if (exported !== void 0) return [this.locationOfSym(exported.doc, exported.sym)];
        }
        return [fileStart(file)];
      }
    }
    return [this.locationOfSym(resolved.doc, sym)];
  }
  // -------------------------------------------------------------- references
  /** All places that refer to `sym` (same-file + cross-file through imports). */
  collect(doc, sym) {
    const out = [];
    const seen = /* @__PURE__ */ new Set();
    const add = (d, occ, decl, write) => {
      const key = `${d.uri}:${occ.offset}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ doc: d, offset: occ.offset, length: occ.length, decl, write });
    };
    let ownerDoc = doc;
    let owner = sym;
    if (sym.kind === "importMember" && sym.module !== void 0 && sym.member === sym.name) {
      const file = this.workspace.resolveModuleFile(sym.module, doc.filePath);
      const exported = file === void 0 ? void 0 : this.exportedSymbol(file, sym.member ?? sym.name);
      if (exported !== void 0) {
        ownerDoc = exported.doc;
        owner = exported.sym;
      }
    }
    for (const occurrence of owner.occurrences) add(ownerDoc, occurrence, occurrence.isDeclaration, occurrence.isWrite);
    if (owner.kind === "parameter") {
      const fn = owner.scope.owner;
      if (fn !== void 0) {
        const calleeNames = /* @__PURE__ */ new Set([fn.name]);
        if (fn.name === "__init__" && fn.scope.owner !== void 0) calleeNames.add(fn.scope.owner.name);
        for (const occ of ownerDoc.binding.occurrences) {
          if (occ.isKeywordArg && occ.name === owner.name && occ.callee !== void 0 && calleeNames.has(occ.callee))
            add(ownerDoc, occ, false, false);
        }
      }
    }
    const isMember = owner.kind === "method" || owner.kind === "property" || owner.scope.kind === "class" && owner.kind === "variable";
    if (isMember) {
      for (const occ of ownerDoc.binding.occurrences) {
        if (occ.isAttribute && occ.name === owner.name) add(ownerDoc, occ, false, occ.isWrite);
      }
    }
    if (owner.scope.kind === "module" || isMember) {
      this.forEachOtherDoc(ownerDoc, (other) => {
        const moduleScope = other.binding.module;
        for (const record of other.binding.imports) {
          const file = this.workspace.resolveModuleFile(record.module, other.filePath);
          if (file === void 0 || file !== ownerDoc.filePath) continue;
          if (record.fromImport) {
            for (const member of record.members) {
              if (member.name !== owner.name) continue;
              const local = moduleScope.symbols.get(member.alias ?? member.name);
              if (member.alias === void 0 && local !== void 0) {
                for (const occurrence of local.occurrences) add(other, occurrence, occurrence.isDeclaration, occurrence.isWrite);
              } else add(other, member, false, false);
            }
          } else {
            const alias = record.alias ?? record.module.split(".")[0];
            for (const occ of other.binding.occurrences) {
              if (occ.isAttribute && occ.receiver === alias && occ.name === owner.name) add(other, occ, false, false);
            }
          }
        }
      });
    }
    out.sort((a, b) => a.doc.uri === b.doc.uri ? a.offset - b.offset : a.doc.uri < b.doc.uri ? -1 : 1);
    return out;
  }
  forEachOtherDoc(except, visit) {
    const visited = /* @__PURE__ */ new Set([except.filePath]);
    for (const document of this.workspace.documents.values()) {
      if (document.filePath === except.filePath) continue;
      visited.add(document.filePath);
      visit(document);
    }
    for (const file of this.workspace.listThmFiles()) {
      if (visited.has(file)) continue;
      visited.add(file);
      const loaded = this.workspace.loadByPath(file);
      if (loaded !== void 0) visit(loaded);
    }
  }
  references(uri, position, includeDeclaration) {
    const doc = this.docOf(uri);
    if (doc === void 0) return [];
    const occurrence = this.occurrenceAt(doc, doc.lines.offsetAt(position.line, position.character));
    if (occurrence === void 0) return [];
    const resolved = this.resolveOccurrence(doc, occurrence);
    if (resolved === void 0) {
      return doc.binding.occurrences.filter((o) => o.name === occurrence.name && o.isAttribute === occurrence.isAttribute).map((o) => ({ uri: doc.uri, range: this.rangeOfOcc(doc, o) }));
    }
    return this.collect(resolved.doc, resolved.sym).filter((entry) => includeDeclaration || !entry.decl).map((entry) => ({ uri: entry.doc.uri, range: entry.doc.lines.rangeOf(entry.offset, entry.length) }));
  }
  documentHighlights(uri, position) {
    const doc = this.docOf(uri);
    if (doc === void 0) return [];
    const occurrence = this.occurrenceAt(doc, doc.lines.offsetAt(position.line, position.character));
    if (occurrence === void 0) return [];
    const resolved = this.resolveOccurrence(doc, occurrence);
    if (resolved === void 0) {
      return doc.binding.occurrences.filter((o) => o.name === occurrence.name && o.isAttribute === occurrence.isAttribute).map((o) => ({ range: this.rangeOfOcc(doc, o), kind: 1 }));
    }
    return this.collect(resolved.doc, resolved.sym).filter((entry) => entry.doc.uri === doc.uri).map((entry) => ({
      range: doc.lines.rangeOf(entry.offset, entry.length),
      kind: entry.write ? 3 : 2
    }));
  }
  // ------------------------------------------------------------------ rename
  prepareRename(uri, position) {
    const doc = this.docOf(uri);
    if (doc === void 0) return null;
    const occurrence = this.occurrenceAt(doc, doc.lines.offsetAt(position.line, position.character));
    if (occurrence === void 0) return null;
    const resolved = this.resolveOccurrence(doc, occurrence);
    if (resolved === void 0) {
      throw new LspError(-32803, `Cannot rename '${occurrence.name}': it is not defined in this workspace`);
    }
    if (resolved.doc.binding !== doc.binding && resolved.doc.filePath.startsWith("<")) return null;
    return { range: this.rangeOfOcc(doc, occurrence), placeholder: occurrence.name };
  }
  rename(uri, position, newName) {
    if (!IDENT.test(newName) || isKeyword(newName))
      throw new LspError(-32602, `'${newName}' is not a valid identifier`);
    const doc = this.docOf(uri);
    if (doc === void 0) throw new LspError(-32602, "Unknown document");
    const occurrence = this.occurrenceAt(doc, doc.lines.offsetAt(position.line, position.character));
    if (occurrence === void 0) throw new LspError(-32803, "Nothing to rename at this position");
    const resolved = this.resolveOccurrence(doc, occurrence);
    if (resolved === void 0)
      throw new LspError(-32803, `Cannot rename '${occurrence.name}': it is not defined in this workspace`);
    const clash = resolved.sym.scope.symbols.get(newName);
    if (clash !== void 0 && clash !== resolved.sym)
      throw new LspError(-32602, `'${newName}' is already defined in this scope`);
    const changes = {};
    for (const entry of this.collect(resolved.doc, resolved.sym)) {
      (changes[entry.doc.uri] ??= []).push({
        range: entry.doc.lines.rangeOf(entry.offset, entry.length),
        newText: newName
      });
    }
    return { changes };
  }
  // ------------------------------------------------------------------- hover
  hover(uri, position) {
    const doc = this.docOf(uri);
    if (doc === void 0) return null;
    const occurrence = this.occurrenceAt(doc, doc.lines.offsetAt(position.line, position.character));
    if (occurrence === void 0) return null;
    const resolved = this.resolveOccurrence(doc, occurrence);
    if (resolved === void 0) return null;
    const { sym } = resolved;
    const lines = [];
    let header;
    switch (sym.kind) {
      case "function":
      case "method":
        header = sym.detail ?? `def ${sym.name}()`;
        break;
      case "class":
        header = sym.detail ?? `class ${sym.name}`;
        break;
      case "parameter":
        header = `(parameter) ${sym.name}${sym.annotation ? `: ${sym.annotation}` : ""}`;
        break;
      case "import":
        header = `(module) ${sym.module ?? sym.name}`;
        break;
      case "importMember":
        header = `(imported) ${sym.detail ?? sym.name}`;
        break;
      case "property":
        header = `(property) ${sym.name}`;
        break;
      case "exception":
        header = `(exception) ${sym.name}`;
        break;
      default: {
        const cls = this.inferClass(resolved.doc, sym);
        const type = sym.annotation ?? (cls !== void 0 ? cls.name : void 0);
        header = `(${sym.scope.kind === "module" ? "variable" : sym.scope.kind === "class" ? "attribute" : "local variable"}) ${sym.name}${type ? `: ${type}` : ""}`;
      }
    }
    lines.push("```thm\n" + header + "\n```");
    if (sym.doc) lines.push(sym.doc);
    if ((sym.kind === "importMember" || sym.kind === "import") && sym.module !== void 0) {
      const file = this.workspace.resolveModuleFile(sym.module, resolved.doc.filePath);
      if (file !== void 0) {
        const exported = sym.kind === "importMember" ? this.exportedSymbol(file, sym.member ?? sym.name) : void 0;
        if (exported?.sym.detail) lines.push("```thm\n" + exported.sym.detail + "\n```");
        if (exported?.sym.doc) lines.push(exported.sym.doc);
      }
    }
    return { contents: lines.join("\n\n"), range: this.rangeOfOcc(doc, occurrence) };
  }
  // ----------------------------------------------------------------- symbols
  documentSymbols(uri) {
    const doc = this.docOf(uri);
    if (doc === void 0) return [];
    const { binding, lines } = doc;
    const nodes = /* @__PURE__ */ new Map();
    const roots = [];
    const wanted = binding.symbols.filter((sym) => {
      if (sym.kind === "parameter") return false;
      if (sym.kind === "exception") return false;
      const scopeKind = sym.scope.kind;
      if (scopeKind === "module" || scopeKind === "class") return true;
      return (sym.kind === "function" || sym.kind === "class" || sym.kind === "method") && scopeKind === "function";
    }).sort((a, b) => a.offset - b.offset);
    for (const sym of wanted) {
      const isScoped = sym.fullStart !== void 0 && sym.fullEnd !== void 0;
      const range = isScoped ? lines.rangeOf(sym.fullStart, Math.max(sym.fullEnd - sym.fullStart, 1)) : lines.rangeOf(sym.offset, sym.length);
      const selection = lines.rangeOf(sym.offset, sym.length);
      const upper = sym.name === sym.name.toUpperCase() && /[A-Z]/.test(sym.name);
      let kind;
      switch (sym.kind) {
        case "class":
          kind = SYMBOL_KIND.Class;
          break;
        case "method":
          kind = sym.name === "__init__" ? SYMBOL_KIND.Constructor : SYMBOL_KIND.Method;
          break;
        case "function":
          kind = SYMBOL_KIND.Function;
          break;
        case "import":
        case "importMember":
          kind = SYMBOL_KIND.Module;
          break;
        case "property":
          kind = SYMBOL_KIND.Property;
          break;
        default:
          kind = sym.scope.kind === "class" ? SYMBOL_KIND.Field : upper ? SYMBOL_KIND.Constant : SYMBOL_KIND.Variable;
      }
      const node = { name: sym.name, detail: sym.detail, kind, range, selectionRange: selection, children: [] };
      nodes.set(sym, node);
      const owner = sym.scope.owner;
      const parent = owner !== void 0 ? nodes.get(owner) : void 0;
      if (parent !== void 0) parent.children.push(node);
      else roots.push(node);
    }
    return roots;
  }
  workspaceSymbols(query) {
    const results = [];
    const lower = query.toLowerCase();
    const matches = (name) => {
      if (lower === "") return true;
      const target = name.toLowerCase();
      let at = 0;
      for (const ch of lower) {
        at = target.indexOf(ch, at);
        if (at < 0) return false;
        at++;
      }
      return true;
    };
    const visit = (doc) => {
      for (const sym of doc.binding.symbols) {
        if (results.length >= 300) return;
        if (sym.kind === "parameter" || sym.kind === "exception" || sym.kind === "import" || sym.kind === "importMember") continue;
        if (sym.scope.kind === "function" || sym.scope.kind === "lambda" || sym.scope.kind === "comprehension") continue;
        if (!matches(sym.name)) continue;
        results.push({
          name: sym.name,
          kind: sym.kind === "class" ? SYMBOL_KIND.Class : sym.kind === "method" ? SYMBOL_KIND.Method : sym.kind === "function" ? SYMBOL_KIND.Function : sym.kind === "property" ? SYMBOL_KIND.Property : SYMBOL_KIND.Variable,
          containerName: sym.scope.owner?.name,
          location: this.locationOfSym(doc, sym)
        });
      }
    };
    const seen = /* @__PURE__ */ new Set();
    for (const doc of this.workspace.documents.values()) {
      seen.add(doc.filePath);
      visit(doc);
    }
    for (const file of this.workspace.listThmFiles()) {
      if (seen.has(file)) continue;
      const doc = this.workspace.loadByPath(file);
      if (doc !== void 0) visit(doc);
    }
    return results;
  }
  // ----------------------------------------------------------- editor sugar
  foldingRanges(uri) {
    const doc = this.docOf(uri);
    if (doc === void 0) return [];
    return doc.binding.folds.map((fold) => ({
      startLine: fold.startLine,
      endLine: fold.endLine,
      ...fold.kind !== void 0 ? { kind: fold.kind } : {}
    }));
  }
  selectionRanges(uri, positions) {
    const doc = this.docOf(uri);
    if (doc === void 0) return positions.map(() => null);
    const { lines, text, binding } = doc;
    return positions.map((position) => {
      const offset = lines.offsetAt(position.line, position.character);
      const chain = [];
      let ws = offset;
      let we = offset;
      while (ws > 0 && /\w/.test(text[ws - 1])) ws--;
      while (we < text.length && /\w/.test(text[we])) we++;
      if (we > ws) chain.push([ws, we]);
      const pairs = [];
      const stack = [];
      for (const token of binding.tokens) {
        if (token.kind !== "operator") continue;
        if ("([{".includes(token.value)) stack.push(token.offset);
        else if (")]}".includes(token.value) && stack.length > 0) {
          const open = stack.pop();
          if (open < offset && token.offset >= offset) pairs.push([open + 1, token.offset]);
          if (open <= offset && token.offset + 1 >= offset) pairs.push([open, token.offset + 1]);
        }
      }
      pairs.sort((a, b) => a[1] - a[0] - (b[1] - b[0]));
      const lineStart = lines.lineStart(position.line);
      const lineEnd = lines.lineEnd(position.line);
      const firstNonSpace = lineStart + (/^\s*/.exec(text.slice(lineStart, lineEnd))?.[0].length ?? 0);
      const all = [...chain, ...pairs, [firstNonSpace, lineEnd], [0, text.length]].filter(([a, b]) => a <= offset && b >= offset && b > a).sort((x, y) => x[1] - x[0] - (y[1] - y[0]));
      let result;
      let last;
      for (let i = all.length - 1; i >= 0; i--) {
        const [a, b] = all[i];
        if (last !== void 0 && last[0] === a && last[1] === b) continue;
        result = { range: lines.rangeOf(a, b - a), ...result !== void 0 ? { parent: result } : {} };
        last = [a, b];
      }
      return result ?? { range: lines.rangeOf(offset, 0) };
    });
  }
  documentLinks(uri) {
    const doc = this.docOf(uri);
    if (doc === void 0) return [];
    const links = [];
    for (const record of doc.binding.imports) {
      const file = this.workspace.resolveModuleFile(record.module, doc.filePath);
      if (file === void 0) continue;
      links.push({
        range: doc.lines.rangeOf(record.moduleOffset, record.moduleLength),
        target: pathToUri(file),
        tooltip: file
      });
    }
    return links;
  }
  // ---------------------------------------------------------- semantic tokens
  semanticTokens(uri, range) {
    const doc = this.docOf(uri);
    if (doc === void 0) return { data: [] };
    const { lines, binding } = doc;
    const typeIndex = (name) => SEMANTIC_TOKEN_TYPES.indexOf(name);
    const modBit = (name) => 1 << SEMANTIC_TOKEN_MODIFIERS.indexOf(name);
    const startOffset = range === void 0 ? 0 : lines.offsetAt(range.start.line, range.start.character);
    const endOffset = range === void 0 ? doc.text.length : lines.offsetAt(range.end.line, range.end.character);
    const entries = [];
    for (const occurrence of this.sorted(binding)) {
      if (occurrence.offset < startOffset || occurrence.offset > endOffset) continue;
      let type = -1;
      let mods = occurrence.isDeclaration ? modBit("declaration") : 0;
      const resolved = occurrence.isKeywordArg || occurrence.isAttribute || occurrence.symbol === void 0 ? this.resolveOccurrence(doc, occurrence) : { doc, sym: occurrence.symbol };
      if (occurrence.isKeywordArg) type = typeIndex("parameter");
      else if (resolved !== void 0) {
        const sym = resolved.sym;
        switch (sym.kind) {
          case "class":
            type = typeIndex("class");
            break;
          case "function":
            type = typeIndex("function");
            break;
          case "method":
            type = typeIndex("method");
            break;
          case "property":
            type = typeIndex("property");
            break;
          case "parameter":
            type = sym.detail?.startsWith("type parameter") ? typeIndex("type") : typeIndex("parameter");
            break;
          case "import":
            type = typeIndex("namespace");
            break;
          case "importMember": {
            const file = sym.module === void 0 ? void 0 : this.workspace.resolveModuleFile(sym.module, resolved.doc.filePath);
            const exported = file === void 0 ? void 0 : this.exportedSymbol(file, sym.member ?? sym.name);
            type = exported?.sym.kind === "class" ? typeIndex("class") : exported?.sym.kind === "function" ? typeIndex("function") : typeIndex("variable");
            break;
          }
          default:
            type = sym.scope.kind === "class" ? typeIndex("property") : typeIndex("variable");
        }
        if (sym.isAsync) mods |= modBit("async");
        if (sym.kind === "variable" && /^[A-Z][A-Z0-9_]*$/.test(sym.name)) mods |= modBit("readonly");
      } else if (occurrence.isAttribute) {
        type = typeIndex("property");
      } else if (GLOBAL_TYPES[occurrence.name] !== void 0) {
        type = typeIndex("class");
        mods |= modBit("defaultLibrary");
      } else if (GLOBAL_FUNCTIONS[occurrence.name] !== void 0) {
        type = typeIndex("function");
        mods |= modBit("defaultLibrary");
      } else if (occurrence.name === "true" || occurrence.name === "false" || occurrence.name === "none") {
        continue;
      }
      if (type >= 0) entries.push({ offset: occurrence.offset, length: occurrence.length, type, mods });
    }
    entries.sort((a, b) => a.offset - b.offset);
    const data = [];
    let prevLine = 0;
    let prevChar = 0;
    let lastOffset = -1;
    for (const entry of entries) {
      if (entry.offset === lastOffset) continue;
      lastOffset = entry.offset;
      const pos = lines.positionAt(entry.offset);
      const deltaLine = pos.line - prevLine;
      const deltaChar = deltaLine === 0 ? pos.character - prevChar : pos.character;
      data.push(deltaLine, deltaChar, entry.length, entry.type, entry.mods);
      prevLine = pos.line;
      prevChar = pos.character;
    }
    return { data };
  }
  // ------------------------------------------------------------ call analysis
  callSites(doc) {
    const { binding } = doc;
    const tokens = binding.tokens;
    const index = this.tokenIndex(binding);
    const sites = [];
    for (const occurrence of binding.occurrences) {
      if (occurrence.isAttribute || occurrence.isKeywordArg || occurrence.isAnnotation) continue;
      if (occurrence.isDeclaration || occurrence.symbol === void 0) continue;
      let sym = occurrence.symbol;
      let symDoc = doc;
      if (sym.rebound) continue;
      if (sym.kind === "importMember" && sym.module !== void 0) {
        const file = this.workspace.resolveModuleFile(sym.module, doc.filePath);
        const exported = file === void 0 ? void 0 : this.exportedSymbol(file, sym.member ?? sym.name);
        if (exported === void 0 || exported.sym.rebound) continue;
        sym = exported.sym;
        symDoc = exported.doc;
      }
      if (sym.decorated) continue;
      let target;
      if (sym.kind === "function") target = sym;
      else if (sym.kind === "class") target = this.memberOfClass(symDoc, sym, "__init__");
      if (target === void 0 || target.parameters === void 0) continue;
      if (sym.kind === "class" && (sym.decorated || (sym.bases ?? []).some((base) => this.lookup(sym.scope, base, symDoc.binding.module) === void 0)))
        continue;
      const at = index.get(occurrence.offset);
      if (at === void 0) continue;
      const open = tokens[at + 1];
      if (open === void 0 || open.kind !== "operator" || open.value !== "(") continue;
      const prev = tokens[at - 1];
      if (prev !== void 0 && prev.kind === "keyword" && (prev.value === "def" || prev.value === "class")) continue;
      const args2 = [];
      let depth = 0;
      let k = at + 2;
      let argStart = k;
      let closeOffset = open.offset + 1;
      let hasClose = false;
      const flush = (end) => {
        const slice = tokens.slice(argStart, end).filter((t) => t.kind !== "newline");
        if (slice.length === 0) return;
        const first = slice[0];
        const entry = { startOffset: first.offset, star: false, doubleStar: false };
        if (first.kind === "operator" && first.value === "*") entry.star = true;
        else if (first.kind === "operator" && first.value === "**") entry.doubleStar = true;
        else if (first.kind === "identifier" && slice[1]?.value === "=" && slice[1].kind === "operator") entry.keyword = first.value;
        args2.push(entry);
      };
      for (; k < tokens.length; k++) {
        const t = tokens[k];
        if (t.kind === "eof") break;
        if (t.kind === "operator") {
          if ("([{".includes(t.value)) depth++;
          else if (")]}".includes(t.value)) {
            if (depth === 0) {
              flush(k);
              closeOffset = t.offset;
              hasClose = t.value === ")";
              break;
            }
            depth--;
          } else if (t.value === "," && depth === 0) {
            flush(k);
            argStart = k + 1;
          }
        }
      }
      sites.push({ nameOcc: occurrence, target, openOffset: open.offset, closeOffset, args: args2, hasClose });
    }
    return sites;
  }
  inferredType(doc, sym, atOffset) {
    if (sym.annotation !== void 0) return sym.annotation;
    if (sym.kind === "class") return "type";
    if (sym.kind === "function" || sym.kind === "method") return "Callable";
    const writes = sym.occurrences.filter((o) => o.isWrite && o.offset <= atOffset).sort((a, b) => b.offset - a.offset);
    for (const write of writes) {
      const index = this.tokenIndex(doc.binding).get(write.offset);
      if (index === void 0) continue;
      const tokens = doc.binding.tokens;
      let k = index + 1;
      while (k < tokens.length && tokens[k].value !== "=" && tokens[k].kind !== "newline") k++;
      if (tokens[k]?.value !== "=") continue;
      const rhs = tokens[k + 1];
      if (rhs === void 0) continue;
      if (rhs.kind === "string") return "str";
      if (rhs.kind === "number") return rhs.value.includes(".") ? "float" : "int";
      if (["true", "false"].includes(rhs.value)) return "bool";
      if (rhs.value === "none") return "None";
      if (rhs.value === "[") return "list";
      if (rhs.value === "{") return "dict";
      if (rhs.value === "(") return "tuple";
      if (rhs.kind === "identifier") {
        const called = tokens[k + 2]?.value === "(" ? this.lookup(write.scope, rhs.value, doc.binding.module) : void 0;
        if (called?.kind === "class") return called.name;
        if (called?.kind === "function" || called?.kind === "method") return called.returnAnnotation ?? "Any";
        const source = this.lookup(write.scope, rhs.value, doc.binding.module);
        if (source !== void 0 && source !== sym) return this.inferredType(doc, source, write.offset);
      }
    }
    return void 0;
  }
  inlayHints(uri, range) {
    const doc = this.docOf(uri);
    if (doc === void 0) return [];
    const startOffset = doc.lines.offsetAt(range.start.line, range.start.character);
    const endOffset = doc.lines.offsetAt(range.end.line, range.end.character);
    const hints = [];
    for (const site of this.callSites(doc)) {
      if (site.openOffset < startOffset || site.openOffset > endOffset) continue;
      const params = (site.target.parameters ?? []).filter((p, i) => !(i === 0 && (p.name === "self" || p.name === "cls") && site.target.scope.kind === "class"));
      let positional = 0;
      for (const arg of site.args) {
        if (arg.keyword !== void 0 || arg.star || arg.doubleStar) {
          if (arg.star) break;
          continue;
        }
        const param = params[positional++];
        if (param === void 0 || param.kind === "vararg" || param.kind === "kwarg") break;
        const text = doc.text.slice(arg.startOffset, arg.startOffset + param.name.length);
        if (text === param.name && !/\w/.test(doc.text[arg.startOffset + param.name.length] ?? "")) continue;
        hints.push({
          position: doc.lines.positionAt(arg.startOffset),
          label: `${param.name}:`,
          kind: 2,
          paddingRight: true
        });
      }
    }
    for (const sym of doc.binding.symbols) {
      if (sym.kind !== "variable" || sym.annotation !== void 0) continue;
      const declaration = sym.occurrences.find((o) => o.isDeclaration);
      if (declaration === void 0) continue;
      const type = this.inferredType(doc, sym, endOffset);
      if (type === void 0 || type === "Any") continue;
      const position = doc.lines.positionAt(declaration.offset + declaration.length);
      if (declaration.offset < startOffset || declaration.offset > endOffset) continue;
      hints.push({ position, label: `: ${type}`, kind: 1, paddingLeft: true });
    }
    return hints;
  }
  // ------------------------------------------------------------- diagnostics
  diagnostics(uri) {
    const doc = this.docOf(uri);
    if (doc === void 0) return [];
    const { binding, lines, text } = doc;
    const out = [];
    const push2 = (offset, length, severity, message, code, extra = {}) => {
      out.push({ range: lines.rangeOf(offset, Math.max(length, 1)), severity, message, source: "thm", code, ...extra });
    };
    const typeResult = checkTypes(text);
    for (const diagnostic of typeResult.diagnostics) {
      const lineStart = lines.lineStart(diagnostic.line);
      push2(
        lineStart + diagnostic.start,
        diagnostic.end - diagnostic.start,
        1,
        diagnostic.message,
        diagnostic.code
      );
    }
    for (const token of binding.tokens) {
      if (token.kind !== "error") continue;
      const unterminated = token.value.startsWith('"') || token.value.startsWith("'") || /^[rbf]{1,2}["']/i.test(token.value);
      push2(
        token.offset,
        token.length,
        1,
        unterminated ? "Unterminated string literal" : `Unexpected character '${token.value}'`,
        unterminated ? "unterminated-string" : "unexpected-character"
      );
    }
    const closers = { ")": "(", "]": "[", "}": "{" };
    const stack = [];
    for (const token of binding.tokens) {
      if (token.kind !== "operator") continue;
      if (token.value === "(" || token.value === "[" || token.value === "{") stack.push(token);
      else if (token.value in closers) {
        const top = stack[stack.length - 1];
        if (top !== void 0 && top.value === closers[token.value]) stack.pop();
        else push2(token.offset, 1, 1, `Unmatched '${token.value}'`, "unmatched-bracket", { data: { removeUnexpectedToken: true } });
      }
    }
    const matchingCloser = { "(": ")", "[": "]", "{": "}" };
    for (const open of stack) push2(open.offset, 1, 1, `'${open.value}' was never closed`, "unclosed-bracket", { data: { insertText: matchingCloser[open.value] } });
    this.checkBlockHeaders(doc, push2);
    this.checkStatements(doc, push2);
    this.checkImports(doc, push2);
    const hasStar = binding.imports.some((record) => record.star === true);
    if (!hasStar) {
      for (const occurrence of binding.unresolved) {
        if (occurrence.isAnnotation) continue;
        const name = occurrence.name;
        if (PRELUDE_NAMES.has(name) || GLOBAL_FUNCTIONS[name] !== void 0 || GLOBAL_TYPES[name] !== void 0) continue;
        if (KEYWORDS.includes(name) || KEYWORD_HELP[name] !== void 0) continue;
        const builtinSuggestion = BUILTIN_MODULES[name] !== void 0 && !this.isShadowed(binding, name);
        const workspaceSuggestion = builtinSuggestion ? void 0 : this.findWorkspaceExport(name, doc);
        push2(occurrence.offset, occurrence.length, 2, `Undefined name '${name}'`, "undefined-name", {
          ...builtinSuggestion ? { data: { importModule: name } } : workspaceSuggestion ? { data: { importModule: workspaceSuggestion.module, importMember: name } } : {}
        });
      }
    }
    for (const sym of binding.symbols) {
      if (sym.kind !== "import" && sym.kind !== "importMember" || sym.scope.kind !== "module") continue;
      const used = sym.occurrences.some((o) => !o.isDeclaration);
      const isInit = doc.filePath.endsWith("__init__.thm");
      if (!used && !isInit && !sym.name.startsWith("_"))
        push2(sym.offset, sym.length, 4, `'${sym.name}' is imported but never used`, "unused-import", {
          tags: [1],
          data: { unusedImport: sym.name }
        });
    }
    for (const scope of binding.scopes) {
      if (scope.kind !== "function" || scope.owner === void 0) continue;
      const seenDefault = { value: false };
      const names = /* @__PURE__ */ new Map();
      const owner = scope.owner;
      for (const occurrence of owner.occurrences) void occurrence;
      const params = [...scope.symbols.values()].filter((sym) => sym.kind === "parameter" && !sym.detail?.startsWith("type parameter"));
      const info = owner.parameters ?? [];
      params.forEach((param, i) => {
        const spec = info[i];
        names.set(param.name, (names.get(param.name) ?? 0) + 1);
        if (spec === void 0) return;
        if (spec.kind === "positional") {
          if (spec.hasDefault) seenDefault.value = true;
          else if (seenDefault.value)
            push2(param.offset, param.length, 1, "Non-default parameter follows default parameter", "param-order");
        }
      });
      const dup = /* @__PURE__ */ new Set();
      for (const spec of info) {
        if (dup.has(spec.name)) {
          const at = scope.symbols.get(spec.name);
          if (at !== void 0) push2(at.offset, at.length, 1, `Duplicate parameter '${spec.name}'`, "duplicate-param");
        }
        dup.add(spec.name);
      }
    }
    for (const site of this.callSites(doc)) {
      const target = site.target;
      const sym = target.scope.kind === "class" ? target.scope.owner ?? target : target;
      const params = (target.parameters ?? []).filter(
        (p, i) => !(i === 0 && (sym.kind === "class" || target.scope.kind === "class") && (p.name === "self" || p.name === "cls"))
      );
      const hasVarargs = params.some((p) => p.kind === "vararg");
      const hasKwargs = params.some((p) => p.kind === "kwarg");
      const positionalParams = params.filter((p) => p.kind === "positional");
      const keywordNames = new Set(params.filter((p) => p.kind !== "vararg" && p.kind !== "kwarg").map((p) => p.name));
      const anyStar = site.args.some((a) => a.star);
      const anyDoubleStar = site.args.some((a) => a.doubleStar);
      let positionalCount = 0;
      const seenKeywords = /* @__PURE__ */ new Set();
      const nameOff = site.nameOcc.offset;
      const nameLen = site.nameOcc.length;
      for (const arg of site.args) {
        if (arg.keyword !== void 0) {
          if (!keywordNames.has(arg.keyword) && !hasKwargs)
            push2(arg.startOffset, arg.keyword.length, 1, `Unexpected keyword argument '${arg.keyword}'`, "unexpected-keyword");
          if (seenKeywords.has(arg.keyword))
            push2(arg.startOffset, arg.keyword.length, 1, `Duplicate keyword argument '${arg.keyword}'`, "duplicate-keyword");
          seenKeywords.add(arg.keyword);
        } else if (!arg.star && !arg.doubleStar) positionalCount++;
      }
      if (!anyStar && !hasVarargs && positionalCount > positionalParams.length) {
        const extra = site.args.filter((a) => a.keyword === void 0 && !a.star && !a.doubleStar)[positionalParams.length];
        push2(
          extra?.startOffset ?? nameOff,
          extra === void 0 ? nameLen : 1,
          1,
          `'${sym.name}' takes ${positionalParams.length} positional argument${positionalParams.length === 1 ? "" : "s"} but ${positionalCount} ${positionalCount === 1 ? "was" : "were"} given`,
          "too-many-arguments"
        );
      }
      if (!anyStar && !anyDoubleStar && site.hasClose) {
        const missing = positionalParams.filter(
          (p, i) => !p.hasDefault && i >= positionalCount && !seenKeywords.has(p.name)
        );
        const missingKwOnly = params.filter((p) => p.kind === "keywordOnly" && !p.hasDefault && !seenKeywords.has(p.name));
        const all = [...missing, ...missingKwOnly];
        if (all.length > 0)
          push2(
            nameOff,
            nameLen,
            1,
            `Missing required argument${all.length === 1 ? "" : "s"}: ${all.map((p) => `'${p.name}'`).join(", ")}`,
            "missing-argument"
          );
      }
    }
    doc.text.split("\n").forEach((lineText, line) => {
      const m = /^(\s*)assert\s+([A-Z]\w*(?:Error|Exception)?\s*\([^)]*\))/.exec(lineText);
      if (m !== null) {
        const startChar = m[1].length;
        const offset = lines.lineStart(line) + startChar;
        push2(
          offset,
          "assert".length,
          2,
          "assert on an exception object is always true \u2014 use 'raise' to throw, or assert a boolean condition",
          "assert-always-true"
        );
      }
    });
    void text;
    return out;
  }
  isShadowed(binding, name) {
    return binding.module.symbols.has(name);
  }
  checkBlockHeaders(doc, push2) {
    const tokens = doc.binding.tokens;
    const headerKeywords = /* @__PURE__ */ new Set(["if", "elif", "while", "for", "else", "try", "finally", "except", "class", "def", "switch"]);
    const clauseKeywords = /* @__PURE__ */ new Set(["case", "default"]);
    let i = 0;
    let atLineStart = true;
    let depth = 0;
    let insideSwitch = false;
    let switchDepth = -1;
    while (i < tokens.length) {
      const token = tokens[i];
      if (token.kind === "eof") break;
      if (token.kind === "newline") {
        atLineStart = true;
        i++;
        continue;
      }
      if (token.kind === "keyword" && token.value === "switch" && depth === switchDepth) {
        insideSwitch = false;
      }
      if (token.kind === "keyword" && token.value === "switch") {
        switchDepth = depth;
        insideSwitch = true;
      }
      const statementStart = atLineStart || token.kind === "operator" && false;
      const prev = tokens[i - 1];
      const afterBrace = prev !== void 0 && prev.kind === "operator" && (prev.value === "{" || prev.value === "}");
      const isStart = statementStart || afterBrace;
      atLineStart = false;
      const isHeaderKeyword = token.kind === "keyword" && (headerKeywords.has(token.value) || clauseKeywords.has(token.value)) || token.kind === "keyword" && token.value === "async" && tokens[i + 1]?.value === "def";
      if (isStart && isHeaderKeyword && depth === 0 && !insideSwitch) {
        let k = i + 1;
        let d = 0;
        let foundBrace = false;
        let lastToken = token;
        while (k < tokens.length) {
          const t = tokens[k];
          if (t.kind === "eof") break;
          if (t.kind === "newline" && d === 0) break;
          if (t.kind === "operator") {
            if (t.value === "(" || t.value === "[") d++;
            else if (t.value === ")" || t.value === "]") d = Math.max(0, d - 1);
            else if (t.value === "{" && d === 0) {
              foundBrace = true;
              break;
            }
          }
          lastToken = t;
          k++;
        }
        if (foundBrace && clauseKeywords.has(token.value)) {
          insideSwitch = true;
        } else if (!foundBrace && !(token.kind === "keyword" && token.value === "case" && tokens.slice(i + 1, k).some((t) => t.kind === "operator" && t.value === ":"))) {
          let n = k;
          while (tokens[n]?.kind === "newline") n++;
          const next = tokens[n];
          if (!(next?.kind === "operator" && next.value === "{")) {
            const hint = token.value === "else" && tokens[i + 1]?.value === "if" ? " (use 'elif')" : "";
            push2(
              lastToken.offset,
              Math.max(lastToken.length, 1),
              1,
              `Expected '{' to begin block after '${token.value}'${hint}`,
              "missing-block"
            );
          }
        }
      }
      if (token.kind === "operator" && (token.value === "(" || token.value === "[")) depth++;
      if (token.kind === "operator" && (token.value === ")" || token.value === "]")) depth = Math.max(0, depth - 1);
      if (insideSwitch && depth <= switchDepth && !(token.kind === "operator" && token.value === "{"))
        insideSwitch = false;
      i++;
    }
  }
  checkStatements(doc, push2) {
    const { binding } = doc;
    const scopeAt = (offset) => {
      let best = binding.module;
      for (const scope of binding.scopes) {
        if (scope.kind === "module") continue;
        if (offset >= scope.start && offset < scope.end && scope.start >= best.start) best = scope;
      }
      return best;
    };
    const loopBlocks = [];
    const tokens = binding.tokens;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.kind === "keyword" && (t.value === "for" || t.value === "while")) {
        let d = 0;
        for (let k = i + 1; k < tokens.length; k++) {
          const u = tokens[k];
          if (u.kind === "operator") {
            if (u.value === "(" || u.value === "[") d++;
            else if (u.value === ")" || u.value === "]") d--;
            else if (u.value === "{" && d <= 0) {
              const block = binding.blocks.find((b) => b.open === u.offset);
              if (block !== void 0) loopBlocks.push({ start: block.open, end: block.close });
              break;
            }
          }
          if (u.kind === "newline" && d <= 0) break;
        }
      }
    }
    for (const t of tokens) {
      if (t.kind !== "keyword") continue;
      if (t.value === "return" || t.value === "yield") {
        const scope = scopeAt(t.offset);
        if (scope.kind === "module" || scope.kind === "class")
          push2(t.offset, t.length, 1, `'${t.value}' outside function`, "return-outside-function");
      } else if (t.value === "await") {
      } else if (t.value === "break" || t.value === "continue") {
        const scope = scopeAt(t.offset);
        const inLoop = loopBlocks.some(
          (loop) => t.offset > loop.start && t.offset < loop.end && loop.start >= scope.start
        );
        if (!inLoop) push2(t.offset, t.length, 1, `'${t.value}' outside loop`, "break-outside-loop");
      }
    }
  }
  checkImports(doc, push2) {
    for (const record of doc.binding.imports) {
      const root = record.module.split(".")[0];
      const isBuiltin = BUILTIN_MODULES[record.module] !== void 0 || BUILTIN_MODULES[root] !== void 0;
      const file = this.workspace.resolveModuleFile(record.module, doc.filePath);
      if (!isBuiltin && file === void 0 && this.workspace.resolveModule(record.module) === void 0) {
        push2(record.moduleOffset, record.moduleLength, 1, `Cannot resolve module '${record.module}'`, "unresolved-import");
        continue;
      }
      if (!record.fromImport) continue;
      if (BUILTIN_MODULES[record.module] !== void 0) {
        const known = BUILTIN_MODULES[record.module];
        for (const member of record.members) {
          if (known[member.name] === void 0)
            push2(member.offset, member.length, 2, `'${member.name}' is not a member of module '${record.module}'`, "unknown-member");
        }
      } else if (file !== void 0) {
        const target = this.workspace.loadByPath(file);
        if (target === void 0) continue;
        for (const member of record.members) {
          const sym = target.binding.module.symbols.get(member.name);
          if (sym === void 0 && !fs2.existsSync(file.replace(/__init__\.thm$/, `${member.name}.thm`)) && !target.binding.imports.some((r) => r.star))
            push2(member.offset, member.length, 2, `'${member.name}' is not defined in module '${record.module}'`, "unknown-member");
        }
      }
    }
  }
  // ------------------------------------------------------------ code actions
  /** Find an exported workspace symbol for auto-import without loading arbitrary files. */
  findWorkspaceExport(name, current) {
    for (const file of this.workspace.listThmFiles()) {
      if (file === current.filePath || file.endsWith("/__init__.thm")) continue;
      const target = this.workspace.loadByPath(file);
      if (target === void 0) continue;
      const sym = target.binding.module.symbols.get(name);
      if (sym === void 0 || sym.name.startsWith("_") || !["function", "class", "variable"].includes(sym.kind)) continue;
      const relative = file.slice(file.lastIndexOf("/") + 1).replace(/\.thm$/, "");
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(relative)) continue;
      return { module: relative };
    }
    return void 0;
  }
  codeActions(uri, range, diagnostics) {
    const doc = this.docOf(uri);
    if (doc === void 0) return [];
    const actions = [];
    const wanted = diagnostics.length > 0 ? diagnostics : this.diagnostics(uri).filter((d) => overlaps(d.range, range));
    for (const diagnostic of wanted) {
      const data = diagnostic.data;
      if (data?.importModule !== void 0) {
        const statement = data.importMember !== void 0 ? `from ${data.importModule} import ${data.importMember}
` : `import ${data.importModule}
`;
        actions.push({
          title: data.importMember !== void 0 ? `Import '${data.importMember}' from '${data.importModule}'` : `Add 'import ${data.importModule}'`,
          kind: "quickfix",
          diagnostics: [diagnostic],
          isPreferred: true,
          edit: { changes: { [doc.uri]: [{ range: this.importInsertRange(doc), newText: statement }] } }
        });
      }
      if (data?.insertText !== void 0) {
        actions.push({
          title: `Insert '${data.insertText}'`,
          kind: "quickfix",
          diagnostics: [diagnostic],
          isPreferred: true,
          edit: { changes: { [doc.uri]: [{ range: { start: diagnostic.range.end, end: diagnostic.range.end }, newText: data.insertText }] } }
        });
      }
      if (data?.removeUnexpectedToken) {
        actions.push({
          title: "Remove unexpected bracket",
          kind: "quickfix",
          diagnostics: [diagnostic],
          edit: { changes: { [doc.uri]: [{ range: diagnostic.range, newText: "" }] } }
        });
      }
      if (data?.unusedImport !== void 0) {
        const edit = this.removeImportEdit(doc, data.unusedImport);
        if (edit !== void 0)
          actions.push({
            title: `Remove unused import '${data.unusedImport}'`,
            kind: "quickfix",
            diagnostics: [diagnostic],
            edit: { changes: { [doc.uri]: [edit] } }
          });
      }
      if (diagnostic.code === "unused-import") continue;
    }
    const unused = this.diagnostics(uri).filter((d) => d.code === "unused-import");
    if (unused.length > 1) {
      const edits = unused.map((d) => this.removeImportEdit(doc, d.data.unusedImport)).filter((e) => e !== void 0);
      if (edits.length > 0)
        actions.push({
          title: "Remove all unused imports",
          kind: "source.organizeImports",
          edit: { changes: { [doc.uri]: edits } }
        });
    }
    const startOffset = doc.lines.offsetAt(range.start.line, range.start.character);
    const endOffset = doc.lines.offsetAt(range.end.line, range.end.character);
    if (endOffset > startOffset) {
      const selected = doc.text.slice(startOffset, endOffset);
      const lineStart = doc.text.lastIndexOf("\n", Math.max(0, startOffset - 1)) + 1;
      const prefix = doc.text.slice(lineStart, startOffset);
      const indent = /^[ \t]*/.exec(doc.text.slice(lineStart))?.[0] ?? "";
      if (!selected.includes("\n") && !selected.trim().endsWith(";") && !/^\s*$/.test(selected)) {
        const name = "extracted_value";
        actions.push({
          title: "Extract Variable",
          kind: "refactor.extract",
          edit: { changes: { [doc.uri]: [
            { range, newText: name },
            { range: doc.lines.rangeOf(lineStart, lineStart), newText: `${indent}${name} = ${selected}
` }
          ] } }
        });
      }
      if (selected.includes("\n") && /^\s*$/.test(prefix)) {
        const bodyIndent = /^[ \t]*/.exec(selected)?.[0] ?? "";
        const body = selected.split("\n").map((line) => line.startsWith(bodyIndent) ? line.slice(bodyIndent.length) : line).join("\n");
        const fnName = "extracted_function";
        actions.push({
          title: "Extract Function",
          kind: "refactor.extract",
          edit: { changes: { [doc.uri]: [
            { range, newText: `${fnName}()` },
            { range: doc.lines.rangeOf(lineStart, lineStart), newText: `${indent}def ${fnName}() do{
${body}
${indent}}
` }
          ] } }
        });
      }
    }
    return actions;
  }
  importInsertRange(doc) {
    const last = [...doc.binding.imports].sort((a, b) => b.offset - a.offset)[0];
    const line = last === void 0 ? 0 : doc.lines.positionAt(last.endOffset).line + 1;
    return { start: { line, character: 0 }, end: { line, character: 0 } };
  }
  removeImportEdit(doc, name) {
    const record = doc.binding.imports.find(
      (candidate) => candidate.fromImport ? candidate.members.some((m) => (m.alias ?? m.name) === name) : (candidate.alias ?? candidate.module.split(".")[0]) === name
    );
    if (record === void 0) return void 0;
    const startLine = doc.lines.positionAt(record.offset).line;
    const endLine = doc.lines.positionAt(record.endOffset).line;
    if (record.fromImport && record.members.length > 1) {
      const member = record.members.find((m) => (m.alias ?? m.name) === name);
      let start = member.offset;
      let end = member.offset + member.length;
      const after = /^\s*as\s+\w+/.exec(doc.text.slice(end));
      if (after !== null) end += after[0].length;
      const trailing = /^\s*,\s*/.exec(doc.text.slice(end));
      if (trailing !== null) end += trailing[0].length;
      else {
        const leading = /,\s*$/.exec(doc.text.slice(0, start));
        if (leading !== null) start -= leading[0].length;
      }
      return { range: doc.lines.rangeOf(start, end - start), newText: "" };
    }
    return {
      range: { start: { line: startLine, character: 0 }, end: { line: endLine + 1, character: 0 } },
      newText: ""
    };
  }
  // -------------------------------------------------------- completion helpers
  /** Symbols visible at a position (innermost scope first), for completion. */
  visibleSymbols(uri, position) {
    const doc = this.docOf(uri);
    if (doc === void 0) return [];
    const offset = doc.lines.offsetAt(position.line, position.character);
    let scope = doc.binding.module;
    for (const candidate of doc.binding.scopes) {
      if (candidate.kind === "module") continue;
      if (offset > candidate.start && offset <= candidate.end && candidate.start >= scope.start) scope = candidate;
    }
    const out = [];
    const seen = /* @__PURE__ */ new Set();
    let cursor = scope;
    let first = true;
    while (cursor !== void 0) {
      if (cursor.kind !== "class" || first) {
        for (const sym of cursor.symbols.values()) {
          if (seen.has(sym.name)) continue;
          seen.add(sym.name);
          out.push(sym);
        }
      }
      first = false;
      cursor = cursor.parent;
    }
    return out;
  }
  autoImportPosition(uri) {
    const doc = this.docOf(uri);
    if (doc === void 0) return { line: 0, character: 0 };
    const last = [...doc.binding.imports].sort((a, b) => b.offset - a.offset)[0];
    const line = last === void 0 ? 0 : doc.lines.positionAt(last.endOffset).line + 1;
    return { line, character: 0 };
  }
  /** Workspace exports suitable for completion with an import text edit. */
  autoImportCompletions(prefix, currentUri) {
    const current = this.docOf(currentUri);
    if (current === void 0) return [];
    const results = [];
    const seen = /* @__PURE__ */ new Set();
    for (const file of this.workspace.listThmFiles()) {
      if (file === current.filePath || file.endsWith("/__init__.thm")) continue;
      const target = this.workspace.loadByPath(file);
      if (target === void 0) continue;
      const module2 = file.slice(file.lastIndexOf("/") + 1).replace(/\.thm$/, "");
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(module2)) continue;
      for (const sym of target.binding.module.symbols.values()) {
        if (sym.name.startsWith("_") || !sym.name.toLowerCase().startsWith(prefix.toLowerCase())) continue;
        if (!["function", "class", "variable"].includes(sym.kind) || seen.has(sym.name)) continue;
        seen.add(sym.name);
        results.push({ name: sym.name, module: module2, kind: sym.kind, detail: sym.detail ?? sym.annotation });
        if (results.length >= 80) return results;
      }
    }
    return results;
  }
  /** Members completable after `receiver.` — class members or module exports. */
  membersOf(uri, position, receiver) {
    const doc = this.docOf(uri);
    if (doc === void 0) return void 0;
    const offset = doc.lines.offsetAt(position.line, position.character);
    let scope = doc.binding.module;
    for (const candidate of doc.binding.scopes) {
      if (candidate.kind === "module") continue;
      if (offset > candidate.start && offset <= candidate.end && candidate.start >= scope.start) scope = candidate;
    }
    const sym = this.lookup(scope, receiver, doc.binding.module);
    if (sym === void 0) return void 0;
    if (sym.kind === "import" && sym.module !== void 0) {
      const file = this.workspace.resolveModuleFile(sym.module, doc.filePath);
      if (file === void 0) return void 0;
      const target = this.workspace.loadByPath(file);
      if (target === void 0) return void 0;
      return [...target.binding.module.symbols.values()].filter((s) => !s.name.startsWith("_") && s.kind !== "parameter").map((s) => ({ name: s.name, kind: s.kind, detail: s.detail, doc: s.doc }));
    }
    const cls = this.inferClass(doc, sym, offset);
    if (cls === void 0) return void 0;
    const members = [];
    const seen = /* @__PURE__ */ new Set();
    for (const current of this.classMro(doc, cls)) {
      const classScope = this.classScopeOf(this.documentForSymbol(current, doc), current);
      for (const member of classScope?.symbols.values() ?? []) {
        if (seen.has(member.name)) continue;
        seen.add(member.name);
        members.push({ name: member.name, kind: member.kind, detail: member.detail, doc: member.doc });
      }
    }
    return members;
  }
};
function fileStart(file) {
  return { uri: pathToUri(file), range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } };
}
function overlaps(a, b) {
  const before = (x, y) => x.line < y.line || x.line === y.line && x.character <= y.character;
  return before(a.start, b.end) && before(b.start, a.end);
}

// src/server.ts
var SERVER_VERSION = "0.3.0";
var ERR = {
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InternalError: -32603,
  ServerNotInitialized: -32002
};
var MethodNotFound = class extends Error {
};
var ThmLanguageServer = class {
  workspace = new Workspace();
  features;
  semantic;
  send;
  log;
  initialized = false;
  shuttingDown = false;
  clientCaps = {};
  nextRequestId = 1;
  currentFolders = [];
  timers = /* @__PURE__ */ new Map();
  globalTimer;
  published = /* @__PURE__ */ new Set();
  constructor(options) {
    this.send = options.send;
    this.log = options.log;
    this.features = new FeatureProvider(this.workspace);
    this.semantic = new SemanticProvider(this.workspace);
  }
  // ------------------------------------------------------------------ routing
  handleMessage(message) {
    const { id, method, params } = message;
    if (method === void 0) return;
    if (id === void 0) {
      try {
        this.handleNotification(method, params);
      } catch (error) {
        this.log(`error in notification ${method}: ${error instanceof Error ? error.stack : String(error)}`);
      }
      return;
    }
    if (!this.initialized && method !== "initialize") {
      return this.fail(id, ERR.ServerNotInitialized, "Server not initialized");
    }
    if (this.shuttingDown && method !== "shutdown") {
      return this.fail(id, ERR.InvalidRequest, "Server is shutting down");
    }
    try {
      const result = this.handleRequest(method, params);
      this.send({ jsonrpc: "2.0", id, result: result === void 0 ? null : result });
    } catch (error) {
      if (error instanceof LspError) return this.fail(id, error.code, error.message);
      if (error instanceof MethodNotFound) return this.fail(id, ERR.MethodNotFound, error.message);
      this.log(`error handling ${method}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
      this.fail(id, ERR.InternalError, String(error instanceof Error ? error.message : error));
    }
  }
  fail(id, code, message) {
    this.send({ jsonrpc: "2.0", id, error: { code, message } });
  }
  // ------------------------------------------------------------ notifications
  handleNotification(method, params) {
    switch (method) {
      case "initialized":
        this.registerWatchers();
        this.scheduleAll();
        return;
      case "exit":
        process.exit(this.shuttingDown ? 0 : 1);
        return;
      case "textDocument/didOpen": {
        const { uri, text, version } = params.textDocument;
        this.workspace.open(uri, text, version ?? 0);
        this.publishNow(uri);
        this.scheduleAll(uri);
        return;
      }
      case "textDocument/didChange": {
        const { uri, version } = params.textDocument;
        const current = this.workspace.get(uri);
        let text = current?.text ?? "";
        for (const change of params.contentChanges ?? []) {
          if (change.range !== void 0) {
            const index = new LineIndex(text);
            const start = index.offsetAt(change.range.start.line, change.range.start.character);
            const end = index.offsetAt(change.range.end.line, change.range.end.character);
            text = text.slice(0, start) + change.text + text.slice(end);
          } else {
            text = change.text;
          }
        }
        this.workspace.update(uri, text, version ?? (current?.version ?? 0) + 1);
        this.schedule(uri, 120);
        this.scheduleAll(uri);
        return;
      }
      case "textDocument/didSave": {
        const uri = params.textDocument.uri;
        if (typeof params.text === "string")
          this.workspace.update(uri, params.text, this.workspace.get(uri)?.version ?? 0);
        this.workspace.invalidateFiles();
        this.publishNow(uri);
        this.scheduleAll(uri);
        return;
      }
      case "textDocument/didClose": {
        const uri = params.textDocument.uri;
        this.workspace.close(uri);
        const timer = this.timers.get(uri);
        if (timer !== void 0) clearTimeout(timer);
        this.timers.delete(uri);
        this.clearDiagnostics(uri);
        return;
      }
      case "workspace/didChangeWatchedFiles":
        this.workspace.invalidateFiles();
        this.scheduleAll();
        return;
      case "workspace/didChangeWorkspaceFolders": {
        const removed = new Set((params?.event?.removed ?? []).map((f) => f.uri));
        const added = (params?.event?.added ?? []).map((f) => f.uri);
        this.currentFolders = [...this.currentFolders.filter((uri) => !removed.has(uri)), ...added];
        this.workspace.setRoots(this.currentFolders);
        this.scheduleAll();
        return;
      }
      case "workspace/didChangeConfiguration":
      case "$/setTrace":
      case "$/cancelRequest":
      case "$/progress":
        return;
      default:
        if (!method.startsWith("$/")) this.log(`unhandled notification ${method}`);
    }
  }
  registerWatchers() {
    const dynamic = this.clientCaps?.workspace?.didChangeWatchedFiles?.dynamicRegistration === true;
    if (!dynamic) return;
    this.send({
      jsonrpc: "2.0",
      id: `reg-${this.nextRequestId++}`,
      method: "client/registerCapability",
      params: {
        registrations: [
          {
            id: "thm-watch",
            method: "workspace/didChangeWatchedFiles",
            registerOptions: { watchers: [{ globPattern: "**/*.thm" }] }
          }
        ]
      }
    });
  }
  // -------------------------------------------------------------- diagnostics
  schedule(uri, delay) {
    const existing = this.timers.get(uri);
    if (existing !== void 0) clearTimeout(existing);
    this.timers.set(
      uri,
      setTimeout(() => {
        this.timers.delete(uri);
        this.publishNow(uri);
      }, delay)
    );
  }
  /** Re-diagnose the other open documents (imports may have changed). */
  scheduleAll(except) {
    if (this.globalTimer !== void 0) clearTimeout(this.globalTimer);
    this.globalTimer = setTimeout(() => {
      this.globalTimer = void 0;
      let count = 0;
      for (const uri of this.workspace.documents.keys()) {
        if (uri === except || count++ > 30) continue;
        this.publishNow(uri);
      }
    }, 400);
  }
  publishNow(uri) {
    const document = this.workspace.get(uri);
    if (document === void 0) return;
    let diagnostics = [];
    try {
      diagnostics = this.semantic.diagnostics(uri);
    } catch (error) {
      this.log(`diagnostics failed for ${uri}: ${error instanceof Error ? error.stack : String(error)}`);
    }
    this.published.add(uri);
    this.send({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: { uri, version: document.version, diagnostics }
    });
  }
  clearDiagnostics(uri) {
    if (!this.published.delete(uri)) return;
    this.send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, diagnostics: [] } });
  }
  // ----------------------------------------------------------------- requests
  handleRequest(method, params) {
    const uri = params?.textDocument?.uri ?? "";
    const position = params?.position ?? { line: 0, character: 0 };
    switch (method) {
      case "initialize": {
        this.clientCaps = params?.capabilities ?? {};
        const folders = [];
        for (const folder of params?.workspaceFolders ?? [])
          if (typeof folder?.uri === "string") folders.push(folder.uri);
        if (folders.length === 0 && typeof params?.rootUri === "string") folders.push(params.rootUri);
        if (folders.length === 0 && typeof params?.rootPath === "string") folders.push(pathToUri(params.rootPath));
        this.currentFolders = folders;
        this.workspace.setRoots(folders);
        this.initialized = true;
        return {
          capabilities: {
            textDocumentSync: { openClose: true, change: 2, save: { includeText: false } },
            hoverProvider: true,
            definitionProvider: true,
            declarationProvider: true,
            typeDefinitionProvider: true,
            referencesProvider: true,
            documentHighlightProvider: true,
            documentSymbolProvider: true,
            workspaceSymbolProvider: true,
            renameProvider: { prepareProvider: true },
            foldingRangeProvider: true,
            selectionRangeProvider: true,
            documentLinkProvider: { resolveProvider: false },
            inlayHintProvider: { resolveProvider: false },
            completionProvider: { triggerCharacters: [".", "=", " "], resolveProvider: false },
            signatureHelpProvider: { triggerCharacters: ["(", ","], retriggerCharacters: [","] },
            codeActionProvider: { codeActionKinds: ["quickfix", "source.organizeImports", "refactor", "refactor.extract", "refactor.inline", "refactor.rewrite"] },
            semanticTokensProvider: {
              legend: {
                tokenTypes: [...SEMANTIC_TOKEN_TYPES],
                tokenModifiers: [...SEMANTIC_TOKEN_MODIFIERS]
              },
              full: true,
              range: true
            },
            diagnosticProvider: {
              identifier: "thm",
              interFileDependencies: true,
              workspaceDiagnostics: false
            },
            workspace: {
              workspaceFolders: { supported: true, changeNotifications: true }
            }
          },
          serverInfo: { name: "thm-lsp", version: SERVER_VERSION }
        };
      }
      case "shutdown":
        this.shuttingDown = true;
        for (const timer of this.timers.values()) clearTimeout(timer);
        this.timers.clear();
        if (this.globalTimer !== void 0) clearTimeout(this.globalTimer);
        return null;
      case "textDocument/completion":
        return this.completion(uri, position);
      case "completionItem/resolve":
        return params;
      case "textDocument/hover":
        return this.hover(uri, position);
      case "textDocument/definition":
      case "textDocument/declaration":
      case "textDocument/typeDefinition": {
        const locations = this.semantic.definition(uri, position);
        return locations.length === 0 ? null : locations;
      }
      case "textDocument/references":
        return this.semantic.references(uri, position, params?.context?.includeDeclaration ?? true);
      case "textDocument/documentHighlight":
        return this.semantic.documentHighlights(uri, position);
      case "textDocument/prepareRename":
        return this.semantic.prepareRename(uri, position);
      case "textDocument/rename":
        return this.semantic.rename(uri, position, params?.newName ?? "");
      case "textDocument/documentSymbol":
        return this.semantic.documentSymbols(uri);
      case "workspace/symbol":
        return this.semantic.workspaceSymbols(params?.query ?? "");
      case "textDocument/foldingRange":
        return this.semantic.foldingRanges(uri);
      case "textDocument/selectionRange":
        return this.semantic.selectionRanges(uri, params?.positions ?? []);
      case "textDocument/documentLink":
        return this.semantic.documentLinks(uri);
      case "textDocument/inlayHint":
        return this.semantic.inlayHints(uri, params.range);
      case "textDocument/semanticTokens/full":
        return this.semantic.semanticTokens(uri);
      case "textDocument/semanticTokens/range":
        return this.semantic.semanticTokens(uri, params.range);
      case "textDocument/codeAction":
        return this.semantic.codeActions(uri, params.range, params?.context?.diagnostics ?? []);
      case "textDocument/signatureHelp":
        return this.signatureHelp(uri, position);
      case "textDocument/diagnostic":
        return { kind: "full", items: this.semantic.diagnostics(uri) };
      case "workspace/diagnostic":
        return { items: [] };
      case "thm/kwargSuggestions":
        return this.features.kwargSuggestions(uri, position.line, position.character);
      default:
        throw new MethodNotFound(`Method not found: ${method}`);
    }
  }
  // ------------------------------------------------------------------- hover
  hover(uri, position) {
    const semantic = this.semantic.hover(uri, position);
    if (semantic !== null) return { contents: { kind: "markdown", value: semantic.contents }, range: semantic.range };
    const builtin = this.features.hover(uri, position.line, position.character);
    if (builtin === null) return null;
    const document = this.workspace.get(uri);
    const text = builtin.contents.replace(/^thm\n/, "");
    let range;
    if (document !== void 0) {
      const offset = document.lines.offsetAt(position.line, position.character);
      let start = offset;
      let end = offset;
      while (start > 0 && /\w/.test(document.text[start - 1])) start--;
      while (end < document.text.length && /\w/.test(document.text[end])) end++;
      range = document.lines.rangeOf(start, end - start);
    }
    return {
      contents: { kind: "markdown", value: "```thm\n" + text + "\n```" },
      ...range !== void 0 ? { range } : {}
    };
  }
  // ------------------------------------------------------------ signature help
  signatureHelp(uri, position) {
    const help = this.features.signatureHelp(uri, position.line, position.character);
    if (help.signature === null) return null;
    return {
      signatures: [
        {
          label: help.signature.label,
          parameters: help.signature.parameters,
          documentation: help.signature.documentation
        }
      ],
      activeSignature: 0,
      activeParameter: help.activeParameter
    };
  }
  // -------------------------------------------------------------- completion
  completion(uri, position) {
    const document = this.workspace.get(uri);
    if (document === void 0) return { isIncomplete: false, items: [] };
    const offset = document.lines.offsetAt(position.line, position.character);
    const empty = { isIncomplete: false, items: [] };
    for (const comment of document.binding.comments) {
      if (offset > comment.offset && offset <= comment.offset + comment.length) return empty;
    }
    for (const token of document.binding.tokens) {
      if (token.kind !== "string") continue;
      if (/^[rRbB]*[fF]/.test(token.value)) continue;
      const quote = /^[A-Za-z]*("""|'''|"|')/.exec(token.value)?.[0].length ?? 1;
      if (offset >= token.offset + quote && offset < token.offset + token.length) return empty;
    }
    const before = document.text.slice(document.lines.lineStart(position.line), offset);
    const memberMatch = /([A-Za-z_]\w*)\s*\.\s*(\w*)$/.exec(before);
    const isImportLine = /^\s*(import|from)\b/.test(before);
    if (memberMatch !== null && !isImportLine) {
      const members = this.semantic.membersOf(uri, position, memberMatch[1]);
      if (members !== void 0) {
        const items2 = members.filter((member) => member.name !== "__init__").map((member) => ({
          label: member.name,
          kind: member.kind === "method" || member.kind === "function" ? COMPLETION_KIND.Method : member.kind === "class" ? COMPLETION_KIND.Class : member.kind === "property" ? COMPLETION_KIND.Property : COMPLETION_KIND.Variable,
          detail: member.detail,
          documentation: member.doc !== void 0 ? { kind: "markdown", value: member.doc } : void 0,
          sortText: `0_${member.name}`
        }));
        return { isIncomplete: false, items: items2 };
      }
    }
    const items = this.features.completion(uri, position.line, position.character);
    if (memberMatch !== null || isImportLine) return { isIncomplete: false, items };
    const completionByName = new Map(items.map((item) => [item.label, item]));
    const kept = items.filter((item) => !item.sortText?.startsWith("0_"));
    for (const sym of this.semantic.visibleSymbols(uri, position)) {
      const richer = completionByName.get(sym.name);
      if (sym.kind === "exception") continue;
      kept.push({
        label: sym.name,
        kind: sym.kind === "function" ? COMPLETION_KIND.Function : sym.kind === "method" ? COMPLETION_KIND.Method : sym.kind === "class" ? COMPLETION_KIND.Class : sym.kind === "import" ? COMPLETION_KIND.Module : sym.kind === "property" ? COMPLETION_KIND.Property : COMPLETION_KIND.Variable,
        detail: sym.detail ?? sym.annotation ?? sym.kind,
        documentation: sym.doc,
        sortText: `0_${sym.name}`,
        insertText: richer?.insertText ?? sym.name,
        insertTextFormat: richer?.insertTextFormat ?? 1,
        filterText: richer?.filterText ?? sym.name,
        commitCharacters: richer?.commitCharacters
      });
    }
    const word = /[A-Za-z_]\w*$/.exec(before)?.[0] ?? "";
    if (word.length >= 2 && !isImportLine) {
      const importPosition = this.semantic.autoImportPosition(uri);
      for (const candidate of this.semantic.autoImportCompletions(word, uri)) {
        if (completionByName.has(candidate.name)) continue;
        kept.push({
          label: candidate.name,
          kind: candidate.kind === "class" ? COMPLETION_KIND.Class : candidate.kind === "function" ? COMPLETION_KIND.Function : COMPLETION_KIND.Variable,
          detail: `${candidate.detail ?? candidate.kind} \xB7 auto import from ${candidate.module}`,
          sortText: `2_${candidate.name}`,
          filterText: candidate.name,
          additionalTextEdits: [{ range: { start: importPosition, end: importPosition }, newText: `from ${candidate.module} import ${candidate.name}
` }]
        });
      }
    }
    return { isIncomplete: false, items: kept };
  }
};

// src/cli.ts
var args = process.argv.slice(2);
if (args.includes("--version") || args.includes("-v")) {
  process.stdout.write(`thm-lsp ${SERVER_VERSION}
`);
  process.exit(0);
}
if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write("Usage: thm-lsp [--stdio]\nTHM language server (LSP over stdio).\n");
  process.exit(0);
}
var server = new ThmLanguageServer({
  send: (message) => sendMessage(process.stdout, { jsonrpc: "2.0", ...message }),
  log: (line) => console.error(`[thm-lsp] ${line}`)
});
process.on("uncaughtException", (error) => console.error(`[thm-lsp] uncaught: ${error.stack ?? error}`));
process.on("unhandledRejection", (reason) => console.error(`[thm-lsp] unhandled rejection: ${String(reason)}`));
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
serveStdio({ onMessage: (message) => server.handleMessage(message) });
