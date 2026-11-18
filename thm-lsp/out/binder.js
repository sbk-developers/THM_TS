"use strict";
/**
 * Scope-aware binder for THM.
 *
 * Walks the tolerant token stream and builds a scope tree with real symbols
 * and resolved occurrences. This is what makes go-to-definition, references,
 * rename, document highlight, semantic tokens and undefined-name diagnostics
 * accurate (instead of matching identifiers by spelling).
 *
 * Scoping rules mirror THM / Python:
 *   - `def` / `lambda` open function scopes; comprehensions open their own.
 *   - `class` bodies open a class scope that is NOT visible from methods.
 *   - assignment / for-target / import / except-as bind in the current scope.
 *   - `global x` / `nonlocal x` redirect binding.
 *   - names are resolved lazily (after the whole file is bound), so use before
 *     definition inside functions works like the runtime.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.PRELUDE_NAMES = void 0;
exports.bind = bind;
exports.bindDocument = bindDocument;
const lexer_js_1 = require("./lexer.js");
const CONTINUATION_OPENERS = new Set(["(", "[", "{"]);
/** Names always in scope besides the builtins in builtins-info. */
exports.PRELUDE_NAMES = new Set([
    "true", "false", "none", "self", "cls", "super", "__name__", "__file__", "__doc__",
    "bytes", "object", "NotImplemented", "Ellipsis", "gc_collect", "getattr", "hasattr",
    "setattr", "input", "map", "max", "min", "next", "ord", "pow", "repr", "reversed",
    "round", "sorted", "sum", "zip", "exit", "quit", "id", "hash", "hex", "bin", "oct",
    "format", "vars", "dir", "open", "slice", "frozenset", "complex", "bytearray",
]);
function bind(source) {
    const allTokens = (0, lexer_js_1.tokenize)(source);
    const comments = allTokens.filter((token) => token.kind === "comment");
    const tokens = allTokens.filter((token) => token.kind !== "comment" && token.kind !== "indent" && token.kind !== "dedent");
    const moduleScope = newScope("module", undefined, 0, source.length);
    const scopes = [moduleScope];
    const symbols = [];
    const occurrences = [];
    const imports = [];
    const blocks = [];
    // Pair every bracket so block ends are exact.
    const match = pairBrackets(tokens);
    for (const [open, close] of match.entries()) {
        if (tokens[open].value === "{" && close >= 0)
            blocks.push({ open: tokens[open].offset, close: tokens[close].offset });
    }
    const isOp = (index, value) => index >= 0 && index < tokens.length && tokens[index].kind === "operator" && tokens[index].value === value;
    const isKw = (index, value) => index >= 0 && index < tokens.length && tokens[index].kind === "keyword" && tokens[index].value === value;
    const isIdent = (index) => index >= 0 && index < tokens.length && tokens[index].kind === "identifier";
    const skipNl = (index) => {
        while (index < tokens.length && tokens[index].kind === "newline")
            index++;
        return index;
    };
    function newScope(kind, parent, start, end) {
        const scope = {
            kind, parent, start, end,
            symbols: new Map(), children: [],
            globals: new Set(), nonlocals: new Set(),
        };
        parent?.children.push(scope);
        return scope;
    }
    function openScope(kind, parent, start, end) {
        const scope = newScope(kind, parent, start, end);
        scopes.push(scope);
        return scope;
    }
    /** Where does a binding for `name` created in `scope` actually live? */
    function bindingScope(scope, name) {
        if (scope.globals.has(name))
            return moduleScope;
        if (scope.nonlocals.has(name)) {
            let cursor = scope.parent;
            while (cursor !== undefined) {
                if (cursor.kind !== "class" && cursor.kind !== "module" && cursor.symbols.has(name))
                    return cursor;
                cursor = cursor.parent;
            }
        }
        return scope;
    }
    function addOccurrence(token, scope, flags) {
        const occurrence = {
            name: token.value, offset: token.offset, line: token.line, column: token.column,
            length: token.length, isWrite: flags.write ?? false, isDeclaration: flags.decl ?? false,
            isAttribute: flags.attr ?? false, receiver: flags.receiver, scope,
        };
        occurrences.push(occurrence);
        return occurrence;
    }
    function declare(token, scope, kind, extra = {}) {
        const target = kind === "variable" ? bindingScope(scope, token.value) : scope;
        const existing = target.symbols.get(token.value);
        // Re-assignment of an existing variable is just another write occurrence.
        if (existing !== undefined && kind === "variable") {
            if (existing.kind === "function" || existing.kind === "class" || existing.kind === "method" || existing.kind === "import" || existing.kind === "importMember")
                existing.rebound = true;
            const occurrence = addOccurrence(token, scope, { write: true });
            occurrence.symbol = existing;
            existing.occurrences.push(occurrence);
            return existing;
        }
        // Redefinition of a function/class/import: later definition wins but both
        // remain linked to one symbol so rename/references stay coherent.
        if (existing !== undefined && kind !== "variable" && existing.kind !== "parameter") {
            const occurrence = addOccurrence(token, scope, { write: true, decl: true });
            occurrence.symbol = existing;
            existing.occurrences.push(occurrence);
            existing.rebound = true;
            Object.assign(existing, extra, {
                kind, line: token.line, column: token.column, offset: token.offset, length: token.length,
            });
            return existing;
        }
        const symbol = {
            name: token.value, kind, scope: target,
            line: token.line, column: token.column, offset: token.offset, length: token.length,
            occurrences: [], ...extra,
        };
        target.symbols.set(token.value, symbol);
        symbols.push(symbol);
        const occurrence = addOccurrence(token, scope, { write: true, decl: true });
        occurrence.symbol = symbol;
        symbol.occurrences.push(occurrence);
        return symbol;
    }
    /** Collect an annotation's text until a stop token at depth 0. */
    /** Scope that should own class type parameters (the class scope itself). */
    function moduleLevelOf(_outer, classScope) {
        return classScope;
    }
    /** Collect an annotation's text until a stop token at depth 0. */
    function annotationText(from, stops) {
        let depth = 0;
        let index = from;
        const parts = [];
        while (index < tokens.length) {
            const token = tokens[index];
            if (token.kind === "newline" || token.kind === "eof")
                break;
            if (token.kind === "operator") {
                if (depth === 0 && stops.has(token.value))
                    break;
                if (CONTINUATION_OPENERS.has(token.value))
                    depth++;
                else if (token.value === ")" || token.value === "]" || token.value === "}") {
                    if (depth === 0)
                        break;
                    depth--;
                }
            }
            parts.push(token.value);
            index++;
        }
        return { text: parts.join(" ").replace(/ ([\],.)]) /g, "$1 ").replace(/([\[(.]) /g, "$1"), end: index };
    }
    const frames = [{ scope: moduleScope, closeIndex: tokens.length }];
    const current = () => frames[frames.length - 1].scope;
    let index = 0;
    let pendingDecorators = 0;
    // Comprehension scopes: closeIndex = index of matching bracket.
    const comprehensionStack = [];
    // Lambda scopes end at an expression boundary.
    const lambdaStack = [];
    const popFinished = () => {
        while (frames.length > 1 && index >= frames[frames.length - 1].closeIndex)
            frames.pop();
        while (comprehensionStack.length > 0 && index > comprehensionStack[comprehensionStack.length - 1].closeIndex)
            comprehensionStack.pop();
        while (lambdaStack.length > 0 && index >= lambdaStack[lambdaStack.length - 1].endIndex) {
            const done = lambdaStack.pop();
            const at = frames.findIndex((frame) => frame.scope === done.scope);
            if (at > 0)
                frames.splice(at, 1);
        }
    };
    /** Where a lambda body ends: next `,`/closer/newline/`;` at depth 0. */
    function lambdaEnd(from) {
        let depth = 0;
        let i = from;
        while (i < tokens.length) {
            const t = tokens[i];
            if (t.kind === "newline" || t.kind === "eof")
                return i;
            if (t.kind === "operator") {
                if (CONTINUATION_OPENERS.has(t.value))
                    depth++;
                else if (t.value === ")" || t.value === "]" || t.value === "}") {
                    if (depth === 0)
                        return i;
                    depth--;
                }
                else if (depth === 0 && (t.value === "," || t.value === ";"))
                    return i;
            }
            i++;
        }
        return i;
    }
    /** Parse a parameter list starting after `(`; returns params and index of `)`. */
    function parseParams(start, fnScope, outer, isLambda) {
        const params = [];
        let i = start;
        let seenVararg = false;
        let kind = "positional";
        const closer = isLambda ? ":" : ")";
        while (i < tokens.length) {
            i = skipNl(i);
            const token = tokens[i];
            if (token === undefined || token.kind === "eof")
                break;
            if (isOp(i, closer) && !isLambda)
                break;
            if (isLambda && isOp(i, ":"))
                break;
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
                if (star === "**")
                    kind = "kwarg";
                else {
                    kind = "vararg";
                    seenVararg = true;
                }
                if (!isIdent(i))
                    continue; // bare `*` marker
            }
            if (!isIdent(i)) {
                i++;
                continue;
            }
            const nameToken = tokens[i];
            i++;
            let annotation;
            if (isOp(i, ":") && !isLambda) {
                const parsed = annotationText(i + 1, new Set([",", "="]));
                annotation = parsed.text;
                // Annotation names are references in the enclosing scope.
                for (let k = i + 1; k < parsed.end; k++)
                    if (tokens[k].kind === "identifier" && !isOp(k - 1, "."))
                        referenceName(k, outer, true);
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
                        if (depth === 0)
                            break;
                        j++;
                        continue;
                    }
                    if (t.kind === "operator") {
                        if (CONTINUATION_OPENERS.has(t.value))
                            depth++;
                        else if (t.value === ")" || t.value === "]" || t.value === "}") {
                            if (depth === 0)
                                break;
                            depth--;
                        }
                        else if (depth === 0 && (t.value === "," || (isLambda && t.value === ":")))
                            break;
                    }
                    j++;
                }
                defaultText = tokens.slice(startDefault, j).filter((t) => t.kind !== "newline").map((t) => t.value).join("");
                // Default values evaluate in the enclosing scope.
                for (let k = startDefault; k < j; k++)
                    processExpressionToken(k, outer);
                i = j;
            }
            const symbol = declare(nameToken, fnScope, "parameter", { annotation });
            void symbol;
            params.push({ name: nameToken.value, kind, hasDefault, annotation, defaultText });
        }
        return { params, end: i };
    }
    // Lightweight expression walk used for defaults/annotations: record names.
    function processExpressionToken(i, scope) {
        const token = tokens[i];
        if (token.kind !== "identifier")
            return;
        if (isOp(i - 1, ".")) {
            const receiver = isIdent(i - 2) ? tokens[i - 2].value : undefined;
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
        if (token.kind !== "identifier")
            return;
        const occurrence = addOccurrence(token, scope, {});
        if (annotation)
            occurrence.isAnnotation = true;
    }
    function docstringAfter(openIdx) {
        const at = skipNl(openIdx + 1);
        const tok = tokens[at];
        if (tok === undefined || tok.kind !== "string")
            return undefined;
        const after = tokens[at + 1];
        if (after !== undefined && after.kind !== "newline" && !(after.kind === "operator" && after.value === "}"))
            return undefined;
        const m = /^[rRbBfF]*("""|\'\'\'|"|\')([\s\S]*?)\1$/.exec(tok.value);
        if (m === null)
            return undefined;
        const lines = m[2].replace(/^\n/, "").split("\n");
        const indents = lines.slice(1).filter((l) => l.trim() !== "").map((l) => /^\s*/.exec(l)[0].length);
        const strip = indents.length > 0 ? Math.min(...indents) : 0;
        return [lines[0].trim(), ...lines.slice(1).map((l) => l.slice(strip))].join("\n").trim();
    }
    function formatSignature(name, params, returns, isAsync) {
        const rendered = params.map((param) => {
            const prefix = param.kind === "vararg" ? "*" : param.kind === "kwarg" ? "**" : "";
            let text = prefix + param.name;
            if (param.annotation)
                text += `: ${param.annotation}`;
            if (param.hasDefault)
                text += param.annotation ? ` = ${param.defaultText ?? "…"}` : `=${param.defaultText ?? "…"}`;
            return text;
        });
        return `${isAsync ? "async " : ""}def ${name}(${rendered.join(", ")})${returns ? ` -> ${returns}` : ""}`;
    }
    /** Find the `{` that opens a block, starting at `from` (skips newlines). */
    function findBlockOpen(from) {
        const at = skipNl(from);
        return isOp(at, "{") ? at : -1;
    }
    while (index < tokens.length) {
        popFinished();
        const token = tokens[index];
        if (token.kind === "eof")
            break;
        const scope = current();
        // --- decorators --------------------------------------------------------
        if (isOp(index, "@") && (index === 0 || tokens[index - 1].kind === "newline")) {
            pendingDecorators++;
            index++;
            continue;
        }
        // --- def / async def ---------------------------------------------------
        if (isKw(index, "def") || (token.value === "async" && isKw(index + 1, "def"))) {
            const isAsync = token.value === "async";
            const defIndex = isAsync ? index + 1 : index;
            if (isIdent(defIndex + 1)) {
                const nameToken = tokens[defIndex + 1];
                let cursor = defIndex + 2;
                // type parameters:  def f[T](...)
                const fnTypeParams = [];
                if (isOp(cursor, "[")) {
                    const close = match.get(cursor) ?? -1;
                    if (close > 0) {
                        for (let k = cursor + 1; k < close; k++)
                            if (isIdent(k) && (isOp(k - 1, "[") || isOp(k - 1, ",")))
                                fnTypeParams.push(tokens[k]);
                        cursor = close + 1;
                    }
                }
                let params = [];
                let returns;
                let openBrace = -1;
                const methodOwner = scope.kind === "class";
                const fnScope = openScope("function", scope, token.offset, source.length);
                for (const typeParam of fnTypeParams)
                    declare(typeParam, fnScope, "parameter", { detail: `type parameter ${typeParam.value}` });
                if (isOp(cursor, "(")) {
                    const parsed = parseParams(cursor + 1, fnScope, scope, false);
                    params = parsed.params;
                    cursor = parsed.end + 1; // past `)`
                }
                if (isOp(cursor, "->")) {
                    const parsed = annotationText(cursor + 1, new Set(["{"]));
                    returns = parsed.text;
                    for (let k = cursor + 1; k < parsed.end; k++)
                        if (tokens[k].kind === "identifier" && !isOp(k - 1, "."))
                            referenceName(k, scope, true);
                    cursor = parsed.end;
                }
                openBrace = findBlockOpen(cursor);
                const closeIdx = openBrace >= 0 ? (match.get(openBrace) ?? tokens.length - 1) : cursor;
                const endOffset = openBrace >= 0 && closeIdx >= 0 && closeIdx < tokens.length
                    ? tokens[closeIdx].offset + tokens[closeIdx].length
                    : tokens[Math.min(cursor, tokens.length - 1)].offset;
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
                    doc: openBrace >= 0 ? docstringAfter(openBrace) : undefined,
                });
                fnScope.owner = symbol;
                pendingDecorators = 0;
                if (openBrace >= 0) {
                    frames.push({ scope: fnScope, closeIndex: closeIdx });
                    index = openBrace + 1;
                }
                else {
                    index = cursor;
                }
                continue;
            }
        }
        // --- class -------------------------------------------------------------
        if (isKw(index, "class") && isIdent(index + 1)) {
            const nameToken = tokens[index + 1];
            let cursor = index + 2;
            const classTypeParams = [];
            if (isOp(cursor, "[")) {
                const close = match.get(cursor) ?? -1;
                if (close > 0) {
                    for (let k = cursor + 1; k < close; k++)
                        if (isIdent(k) && (isOp(k - 1, "[") || isOp(k - 1, ",")))
                            classTypeParams.push(tokens[k]);
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
                        } // metaclass=
                        referenceName(k, scope);
                        if (!isOp(k - 1, "."))
                            bases.push(tokens[k].value);
                    }
                }
                cursor = close + 1;
            }
            const openBrace = findBlockOpen(cursor);
            const closeIdx = openBrace >= 0 ? (match.get(openBrace) ?? tokens.length - 1) : cursor;
            const endOffset = openBrace >= 0 && closeIdx < tokens.length
                ? tokens[closeIdx].offset + tokens[closeIdx].length
                : tokens[Math.min(cursor, tokens.length - 1)].offset;
            const classScope = openScope("class", scope, openBrace >= 0 ? tokens[openBrace].offset : token.offset, endOffset);
            const symbol = declare(nameToken, scope, "class", {
                detail: `class ${nameToken.value}${bases.length > 0 ? `(${bases.join(", ")})` : ""}`,
                fullStart: token.offset, fullEnd: endOffset, bases,
                decorated: pendingDecorators > 0,
                doc: openBrace >= 0 ? docstringAfter(openBrace) : undefined,
            });
            classScope.owner = symbol;
            // Class type parameters are visible to the class body and its methods.
            for (const typeParam of classTypeParams)
                declare(typeParam, moduleLevelOf(scope, classScope), "parameter", { detail: `type parameter ${typeParam.value}` });
            pendingDecorators = 0;
            if (openBrace >= 0) {
                frames.push({ scope: classScope, closeIndex: closeIdx });
                index = openBrace + 1;
            }
            else
                index = cursor;
            continue;
        }
        // --- global / nonlocal ---------------------------------------------------
        if ((isKw(index, "global") || isKw(index, "nonlocal"))) {
            const which = token.value;
            let k = index + 1;
            while (isIdent(k)) {
                const nameToken = tokens[k];
                (which === "global" ? scope.globals : scope.nonlocals).add(nameToken.value);
                const occurrence = addOccurrence(nameToken, scope, {});
                // Resolved after the walk (needs the full symbol tables).
                void occurrence;
                k++;
                if (isOp(k, ","))
                    k++;
            }
            index = k;
            continue;
        }
        // --- import / from -------------------------------------------------------
        if (isKw(index, "import") && (isIdent(index + 1) || tokens[index + 1]?.kind === "keyword")) {
            let k = index + 1;
            for (;;) {
                const first = tokens[k];
                if (first === undefined || (first.kind !== "identifier" && first.kind !== "keyword"))
                    break;
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
                const sym = declare({ ...bindToken, value: alias ? alias.value : first.value }, scope, "import", { detail: `import ${dotted}${alias ? ` as ${alias.value}` : ""}`, module: dotted });
                void sym;
                imports.push({
                    module: dotted, alias: alias?.value, members: [], fromImport: false,
                    line: first.line, column: first.column, offset: first.offset,
                    moduleOffset: first.offset,
                    moduleLength: tokens[last].offset + tokens[last].length - first.offset,
                    endOffset: tokens[last].offset + tokens[last].length,
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
                    module: dotted, members: [], fromImport: true,
                    line: token.line, column: token.column, offset: token.offset,
                    moduleOffset: moduleStart.offset,
                    moduleLength: Math.max(1, dotted.length),
                    endOffset: token.offset,
                };
                k++;
                const parens = isOp(k, "(");
                if (parens)
                    k++;
                for (;;) {
                    k = skipNl(k);
                    const memberToken = tokens[k];
                    if (memberToken === undefined)
                        break;
                    if (isOp(k, "*")) {
                        record.star = true;
                        k++;
                        continue;
                    }
                    if (memberToken.kind !== "identifier" && memberToken.kind !== "keyword")
                        break;
                    let alias;
                    let end = k;
                    if (isKw(k + 1, "as") && isIdent(k + 2)) {
                        alias = tokens[k + 2];
                        end = k + 2;
                    }
                    const bindToken = alias ?? memberToken;
                    declare(bindToken, scope, "importMember", {
                        detail: `from ${dotted} import ${memberToken.value}${alias ? ` as ${alias.value}` : ""}`,
                        module: dotted, member: memberToken.value,
                    });
                    record.members.push({
                        name: memberToken.value, alias: alias?.value, offset: memberToken.offset,
                        length: memberToken.length, line: memberToken.line, column: memberToken.column,
                    });
                    k = end + 1;
                    if (isOp(k, ",")) {
                        k++;
                        continue;
                    }
                    break;
                }
                if (parens && isOp(skipNl(k), ")"))
                    k = skipNl(k) + 1;
                record.endOffset = tokens[Math.max(0, k - 1)].offset + tokens[Math.max(0, k - 1)].length;
                imports.push(record);
                index = k;
                continue;
            }
        }
        // --- for loops and comprehensions ---------------------------------------
        if (isKw(index, "for")) {
            // Comprehension if we are inside an open ( [ { opened by an expression.
            const inBrackets = insideBracketExpression(index);
            let k = index + 1;
            const targetTokens = [];
            let depth = 0;
            while (k < tokens.length && !(depth === 0 && isKw(k, "in"))) {
                if (tokens[k].kind === "newline" && depth === 0)
                    break;
                if (isOp(k, "(") || isOp(k, "["))
                    depth++;
                if (isOp(k, ")") || isOp(k, "]"))
                    depth--;
                if (isIdent(k) && !isOp(k - 1, "."))
                    targetTokens.push(k);
                k++;
            }
            let targetScope = scope;
            if (inBrackets) {
                const bracket = enclosingBracket(index);
                const top = comprehensionStack[comprehensionStack.length - 1];
                if (top !== undefined && top.closeIndex === bracket.close) {
                    targetScope = top.scope; // further `for` clause of the same comprehension
                }
                else {
                    const compScope = openScope("comprehension", scope, tokens[bracket.open].offset, tokens[bracket.close].offset + 1);
                    // The element expression (before the first `for`) was walked in the
                    // outer scope; resolveAll() re-homes those occurrences.
                    comprehensionStack.push({ scope: compScope, closeIndex: bracket.close });
                    frames.push({ scope: compScope, closeIndex: bracket.close });
                    targetScope = compScope;
                    comprehensionScopes.push({ scope: compScope, openOffset: tokens[bracket.open].offset, forOffset: token.offset });
                }
            }
            for (const t of targetTokens)
                declare(tokens[t], targetScope, "variable");
            index = k; // continue at `in`
            continue;
        }
        // --- lambda ----------------------------------------------------------------
        if (isKw(index, "lambda")) {
            const end = lambdaEnd(index + 1);
            const lamScope = openScope("lambda", scope, token.offset, tokens[Math.min(end, tokens.length - 1)].offset);
            const parsed = parseParams(index + 1, lamScope, scope, true);
            frames.push({ scope: lamScope, closeIndex: Number.MAX_SAFE_INTEGER });
            lambdaStack.push({ scope: lamScope, stopDepthIndex: parsed.end, endIndex: end });
            index = parsed.end + 1;
            continue;
        }
        // --- except ... as name ------------------------------------------------------
        if (isKw(index, "as") && isIdent(index + 1) && lastExceptDepth !== -1 && isInExceptHeader(index)) {
            declare(tokens[index + 1], scope, "exception");
            index += 2;
            continue;
        }
        if (isKw(index, "except"))
            lastExceptDepth = index;
        // --- attribute access -----------------------------------------------------------
        if (isOp(index, ".") && isIdent(index + 1)) {
            const prev = tokens[index - 1];
            const receiver = prev?.kind === "identifier" ? prev.value : prev?.value === "self" ? "self" : undefined;
            const member = tokens[index + 1];
            // self.x = ... defines a property.
            if (receiver === "self" && isOp(index + 2, "=") && !isOp(index + 3, "=")) {
                const owner = enclosingClass(scope);
                if (owner !== undefined) {
                    const existing = owner.symbols.get(member.value);
                    if (existing === undefined) {
                        const sym = {
                            name: member.value, kind: "property", scope: owner,
                            line: member.line, column: member.column, offset: member.offset, length: member.length,
                            occurrences: [], detail: `(property) ${member.value}`,
                        };
                        owner.symbols.set(member.value, sym);
                        symbols.push(sym);
                        const occ = addOccurrence(member, scope, { attr: true, write: true, decl: true, receiver });
                        occ.symbol = sym;
                        sym.occurrences.push(occ);
                    }
                    else {
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
        // --- identifiers: assignment targets vs plain reads -------------------------------
        if (token.kind === "identifier") {
            const prev = tokens[index - 1];
            const next = tokens[index + 1];
            const atStatementStart = index === 0 || prev.kind === "newline" || isOp(index - 1, ";") || isOp(index - 1, "}") ||
                (isOp(index - 1, "{") && isBlockBrace(index - 1));
            const isKwArg = isOp(index + 1, "=") && !isOp(index + 2, "=") && inCallParens(index) && (isOp(index - 1, "(") || isOp(index - 1, ","));
            if (isKwArg) {
                const bracket = enclosingBracket(index);
                const calleeToken = tokens[bracket.open - 1];
                const occ = addOccurrence(token, scope, {});
                occ.isKeywordArg = true;
                occ.callee = calleeToken?.kind === "identifier" ? calleeToken.value : undefined;
                keywordArgs.add(token.offset);
                index++;
                continue;
            }
            const augmentedOrAssign = next !== undefined && next.kind === "operator" &&
                (next.value === "=" || (next.value.length >= 2 && next.value.endsWith("=") && !["==", "!=", "<=", ">="].includes(next.value)) || next.value === ":=");
            // Annotated declaration `x: int = 3` / tuple targets `a, b = ...`.
            const annotatedDecl = atStatementStart && isOp(index + 1, ":") && scope.kind !== "lambda";
            const tupleTarget = isTupleTargetStart(index, atStatementStart);
            if (augmentedOrAssign || annotatedDecl || tupleTarget) {
                if (annotatedDecl) {
                    const parsed = annotationText(index + 2, new Set(["="]));
                    for (let k = index + 2; k < parsed.end; k++)
                        if (tokens[k].kind === "identifier" && !isOp(k - 1, "."))
                            referenceName(k, scope, true);
                    const sym = declare(token, scope, "variable", { annotation: parsed.text });
                    if (sym.annotation === undefined)
                        sym.annotation = parsed.text;
                    index = parsed.end;
                    continue;
                }
                const isPlainAssign = next?.value === "=" || next?.value === ":=";
                declare(token, scope, "variable");
                if (!isPlainAssign && augmentedOrAssign) {
                    // x += 1 reads as well as writes.
                    addOccurrence(token, scope, {}).symbol = undefined;
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
    // ---------- helper closures needing the token array ----------------------------------
    function insideBracketExpression(at) {
        const bracket = enclosingBracket(at);
        if (bracket === undefined)
            return false;
        if (bracket.open < 0)
            return false;
        if (tokens[bracket.open].value === "{")
            return looksLikeCollectionBrace(bracket.open, at);
        return true;
    }
    /** A `{` opens a block when it follows a header (`)`, name, number, else/try/finally). */
    function isBlockBrace(open) {
        let k = open - 1;
        while (k >= 0 && tokens[k].kind === "newline")
            k--;
        const before = tokens[k];
        if (before === undefined)
            return false;
        if (before.kind === "operator")
            return before.value === ")" || before.value === "]";
        if (before.kind === "keyword")
            return ["else", "try", "finally"].includes(before.value);
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
            if (t.kind !== "operator")
                continue;
            if (t.value === ")" || t.value === "]" || t.value === "}")
                depth++;
            else if (t.value === "(" || t.value === "[" || t.value === "{") {
                if (depth === 0)
                    return { open: i, close: match.get(i) ?? tokens.length - 1 };
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
        if (!statementStart)
            return false;
        // a, b = ...  (identifiers separated by commas then `=`)
        let k = at;
        let seenComma = false;
        while (isIdent(k) || isOp(k, ",") || isOp(k, "(") || isOp(k, ")") || isOp(k, "*")) {
            if (isOp(k, ","))
                seenComma = true;
            k++;
        }
        return seenComma && isOp(k, "=") && !isOp(k + 1, "=");
    }
    function isInExceptHeader(at) {
        // `as` belongs to an except header when no `{` appears between `except` and it.
        for (let i = at - 1; i >= 0; i--) {
            if (isKw(i, "except"))
                return true;
            if (isOp(i, "{") || isOp(i, "}") || tokens[i].kind === "newline")
                return false;
        }
        return false;
    }
    function enclosingClass(scope) {
        let cursor = scope;
        while (cursor !== undefined) {
            if (cursor.kind === "function" && cursor.parent?.kind === "class")
                return cursor.parent;
            cursor = cursor.parent;
        }
        return undefined;
    }
    // ---------- resolve every occurrence -----------------------------------------------------
    // (declared after the walk via hoisted function declarations)
    resolveAll();
    const unresolved = occurrences.filter((occurrence) => occurrence.symbol === undefined && !occurrence.isAttribute && !occurrence.isKeywordArg);
    const folds = computeFolds(source, tokens, blocks);
    {
        // Runs of consecutive full-line comments fold as one region.
        let runStart = -1;
        let runEnd = -1;
        for (const comment of comments) {
            if (comment.line === runEnd + 1 && runStart !== -1)
                runEnd = comment.line;
            else {
                if (runStart !== -1 && runEnd > runStart)
                    folds.push({ startLine: runStart, endLine: runEnd, kind: "comment" });
                runStart = comment.line;
                runEnd = comment.line;
            }
        }
        if (runStart !== -1 && runEnd > runStart)
            folds.push({ startLine: runStart, endLine: runEnd, kind: "comment" });
    }
    return { tokens, module: moduleScope, scopes, symbols, occurrences, imports, folds, blocks, comments, unresolved };
    // -------------------------------------------------------------------------------------------
    function resolveAll() {
        // Comprehension element expressions precede their `for`; re-home them.
        for (const comp of comprehensionScopes) {
            for (const occurrence of occurrences) {
                if (occurrence.scope.kind !== "comprehension" &&
                    occurrence.offset > comp.openOffset &&
                    occurrence.offset < comp.forOffset &&
                    occurrence.scope === comp.scope.parent)
                    occurrence.scope = comp.scope;
            }
        }
        for (const occurrence of occurrences) {
            if (occurrence.symbol !== undefined || occurrence.isKeywordArg)
                continue;
            if (occurrence.isAttribute) {
                // self.x / cls.x resolve to members of the enclosing class (and bases).
                if (occurrence.receiver === "self" || occurrence.receiver === "cls") {
                    const owner = enclosingClass(occurrence.scope);
                    const member = owner === undefined ? undefined : findMemberIn(owner, occurrence.name, new Set());
                    if (member !== undefined) {
                        occurrence.symbol = member;
                        member.occurrences.push(occurrence);
                    }
                }
                continue;
            }
            const symbol = lookup(occurrence.scope, occurrence.name);
            if (symbol !== undefined) {
                occurrence.symbol = symbol;
                symbol.occurrences.push(occurrence);
            }
        }
        // Keep occurrences in source order per symbol.
        for (const symbol of symbols)
            symbol.occurrences.sort((a, b) => a.offset - b.offset);
    }
    function findMemberIn(classScope, name, seen) {
        if (seen.has(classScope))
            return undefined;
        seen.add(classScope);
        const direct = classScope.symbols.get(name);
        if (direct !== undefined)
            return direct;
        for (const base of classScope.owner?.bases ?? []) {
            const baseSym = lookup(classScope.parent ?? moduleScope, base);
            const baseScope = baseSym === undefined ? undefined : scopes.find((candidate) => candidate.owner === baseSym && candidate.kind === "class");
            if (baseScope !== undefined) {
                const found = findMemberIn(baseScope, name, seen);
                if (found !== undefined)
                    return found;
            }
        }
        return undefined;
    }
    function lookup(from, name) {
        let scope = from;
        if (from.globals.has(name))
            return moduleScope.symbols.get(name);
        let first = true;
        while (scope !== undefined) {
            // Class scopes are only visible from their own body, not nested functions.
            if (scope.kind !== "class" || first) {
                const found = scope.symbols.get(name);
                if (found !== undefined)
                    return found;
            }
            first = false;
            scope = scope.parent;
        }
        return undefined;
    }
}
// Module-level mutable state used by the binder closure.
const comprehensionScopes = [];
const keywordArgs = new Set();
let lastExceptDepth = -1;
/** Reset per-run helper state (called by `bindDocument`). */
function bindDocument(source) {
    comprehensionScopes.length = 0;
    keywordArgs.clear();
    lastExceptDepth = -1;
    return bind(source);
}
function pairBrackets(tokens) {
    const stack = [];
    const pairs = new Map();
    const closers = { ")": "(", "]": "[", "}": "{" };
    tokens.forEach((token, index) => {
        if (token.kind !== "operator")
            return;
        if (token.value === "(" || token.value === "[" || token.value === "{")
            stack.push(index);
        else if (token.value in closers) {
            // Pop until we find the matching opener kind (tolerate stray closers).
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
    // Unclosed openers extend to EOF.
    for (const open of stack)
        pairs.set(open, tokens.length - 1);
    return pairs;
}
function computeFolds(source, tokens, blocks) {
    const folds = [];
    const lineOf = (offset) => {
        let line = 0;
        for (let i = 0; i < offset && i < source.length; i++)
            if (source.charCodeAt(i) === 10)
                line++;
        return line;
    };
    // Precompute line starts for O(log n) lookups.
    const starts = [0];
    for (let i = 0; i < source.length; i++)
        if (source.charCodeAt(i) === 10)
            starts.push(i + 1);
    const fastLine = (offset) => {
        let lo = 0, hi = starts.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (starts[mid] <= offset)
                lo = mid;
            else
                hi = mid - 1;
        }
        return lo;
    };
    void lineOf;
    for (const block of blocks) {
        const startLine = fastLine(block.open);
        const endLine = fastLine(block.close);
        if (endLine > startLine)
            folds.push({ startLine, endLine: endLine - 1 });
    }
    // Brackets spanning lines (lists, dicts, calls).
    const stack = [];
    for (const token of tokens) {
        if (token.kind !== "operator")
            continue;
        if (token.value === "(" || token.value === "[")
            stack.push(token);
        else if ((token.value === ")" || token.value === "]") && stack.length > 0) {
            const open = stack.pop();
            if (token.line > open.line)
                folds.push({ startLine: open.line, endLine: token.line - 1 });
        }
    }
    // Consecutive imports.
    let runStart = -1;
    let runEnd = -1;
    const importLines = new Set();
    for (const token of tokens)
        if (token.kind === "keyword" && (token.value === "import" || token.value === "from") && (token.column === 0))
            importLines.add(token.line);
    const sorted = [...importLines].sort((a, b) => a - b);
    for (const line of sorted) {
        if (runStart === -1) {
            runStart = line;
            runEnd = line;
        }
        else if (line === runEnd + 1)
            runEnd = line;
        else {
            if (runEnd > runStart)
                folds.push({ startLine: runStart, endLine: runEnd, kind: "imports" });
            runStart = line;
            runEnd = line;
        }
    }
    if (runStart !== -1 && runEnd > runStart)
        folds.push({ startLine: runStart, endLine: runEnd, kind: "imports" });
    return dedupeFolds(folds);
}
function dedupeFolds(folds) {
    const seen = new Set();
    return folds.filter((fold) => {
        const key = `${fold.startLine}:${fold.endLine}`;
        if (seen.has(key))
            return false;
        seen.add(key);
        return fold.endLine > fold.startLine - 0 && fold.endLine >= fold.startLine;
    });
}
