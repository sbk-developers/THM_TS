"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.optionalType = exports.NONE = exports.NEVER = exports.ANY = void 0;
exports.unionType = unionType;
exports.typeToString = typeToString;
exports.parseAst = parseAst;
exports.buildCfg = buildCfg;
exports.checkTypes = checkTypes;
exports.ANY = { kind: "any" }, exports.NEVER = { kind: "never" }, exports.NONE = { kind: "none" };
const primitive = (name) => ({ kind: "primitive", name });
const T = (name) => ({ kind: "variable", name });
function unionType(...types) {
    const flat = [];
    for (const t of types)
        for (const x of (t.kind === "union" ? t.items : [t])) {
            if (x.kind === "never")
                continue;
            if (x.kind === "any")
                return exports.ANY;
            if (!flat.some(y => typeToString(y) === typeToString(x)))
                flat.push(x);
        }
    if (!flat.length)
        return exports.NEVER;
    if (flat.length === 1)
        return flat[0];
    return { kind: "union", items: flat };
}
const optionalType = (t) => unionType(t, exports.NONE);
exports.optionalType = optionalType;
function typeToString(t) {
    switch (t.kind) {
        case "any": return "Any";
        case "never": return "Never";
        case "none": return "None";
        case "primitive": return t.name;
        case "literal": return `Literal[${JSON.stringify(t.value)}]`;
        case "variable": return t.name;
        case "generic": return `${t.name}[${t.args.map(typeToString).join(", ")}]`;
        case "protocol": return t.name;
        case "union": return t.items.map(typeToString).join(" | ");
    }
}
function isSubtype(a, b) {
    if (a.kind === "never" || b.kind === "any" || a.kind === "any")
        return true;
    if (b.kind === "union")
        return b.items.some(x => isSubtype(a, x));
    if (a.kind === "union")
        return a.items.every(x => isSubtype(x, b));
    if (a.kind === "literal")
        return isSubtype(primitive(a.base), b);
    if (a.kind === "none")
        return b.kind === "none";
    if (a.kind === "primitive" && b.kind === "primitive") {
        if (a.name === b.name)
            return true;
        return a.name === "bool" && b.name === "int";
    }
    if (a.kind === "generic" && b.kind === "generic" && a.name === b.name)
        return a.args.length === b.args.length && a.args.every((x, i) => isSubtype(x, b.args[i]));
    if (b.kind === "protocol" && a.kind === "protocol")
        return Object.entries(b.members).every(([k, v]) => a.members[k] && isSubtype(a.members[k], v));
    return false;
}
function assignable(actual, expected) { return isSubtype(actual, expected); }
const TYPE_NAMES = new Set(["Any", "Never", "None", "int", "float", "str", "bool", "bytes", "object", "list", "dict", "tuple", "set", "type", "complex"]);
function parseType(raw) {
    const s = raw.trim();
    if (!s || s === "Any" || s === "any")
        return exports.ANY;
    if (s === "Never" || s === "NoReturn")
        return exports.NEVER;
    if (s === "None" || s === "NoneType")
        return exports.NONE;
    if (s.includes("|"))
        return unionType(...splitTop(s, "|").map(parseType));
    const m = /^([A-Za-z_]\w*)\[(.*)\]$/.exec(s);
    if (m) {
        const args = splitTop(m[2], ",").map(parseType);
        if (m[1] === "Optional")
            return (0, exports.optionalType)(args[0] ?? exports.ANY);
        if (m[1] === "Union")
            return unionType(...args);
        if (m[1] === "Literal")
            return { kind: "union", items: splitTop(m[2], ",").map(v => literalType(v.trim())) };
        return { kind: "generic", name: m[1], args };
    }
    if (/^[A-Z]\w*$/.test(s) && !TYPE_NAMES.has(s))
        return T(s);
    return primitive(s);
}
function splitTop(s, sep) {
    const out = [];
    let depth = 0, quote = "", start = 0;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (quote) {
            if (c === quote && s[i - 1] !== "\\\\")
                quote = "";
            continue;
        }
        if (c === '"' || c === "'") {
            quote = c;
            continue;
        }
        if ("[({".includes(c))
            depth++;
        else if ("])}".includes(c))
            depth--;
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
    if (raw === "True" || raw === "False")
        return { kind: "literal", value: raw === "True", base: "bool" };
    if (raw === "None")
        return exports.NONE;
    if (/^['"]/.test(raw))
        return { kind: "literal", value: raw.slice(1, -1), base: "str" };
    const n = Number(raw);
    if (Number.isFinite(n))
        return { kind: "literal", value: n, base: Number.isInteger(n) ? "int" : "float" };
    return exports.ANY;
}
function parseExpr(raw) {
    const s = raw.trim();
    if (!s)
        return { kind: "unknown", children: [] };
    if (/^(True|False|None|-?\d+(?:\.\d+)?)$/.test(s) || /^['"]/.test(s))
        return { kind: "literal", value: s, children: [] };
    if (/^[A-Za-z_]\w*$/.test(s))
        return { kind: "name", value: s, children: [] };
    const call = /^([A-Za-z_]\w*)\((.*)\)$/.exec(s);
    if (call)
        return { kind: "call", value: call[1], children: splitTop(call[2], ",").map(parseExpr) };
    const member = /^(.+)\.([A-Za-z_]\w*)$/.exec(s);
    if (member)
        return { kind: "member", value: member[2], children: [parseExpr(member[1])] };
    const index = /^(.+)\[(.*)\]$/.exec(s);
    if (index)
        return { kind: "index", children: [parseExpr(index[1]), parseExpr(index[2])] };
    if (s.startsWith("[") && s.endsWith("]"))
        return { kind: "list", children: splitTop(s.slice(1, -1), ",").filter(Boolean).map(parseExpr) };
    if (s.startsWith("{") && s.endsWith("}"))
        return { kind: "dict", children: splitTop(s.slice(1, -1), ",").filter(Boolean).map(x => parseExpr(x.split(":").slice(1).join(":"))) };
    for (const op of [" is not ", " is ", " == ", " != ", " >= ", " <= ", " + ", " - ", " * ", " / ", " // ", " % ", " and ", " or "]) {
        const p = splitTop(s, op.trim());
        if (p.length > 1)
            return { kind: "binary", value: op.trim(), children: p.map(parseExpr) };
    }
    return { kind: "unknown", value: s, children: [] };
}
function inferExpr(e, env) {
    switch (e.kind) {
        case "literal": return literalType(e.value ?? "");
        case "name": return env.get(e.value ?? "") ?? exports.ANY;
        case "list": return { kind: "generic", name: "list", args: [unionType(...e.children.map(x => inferExpr(x, env)))] };
        case "dict": return { kind: "generic", name: "dict", args: [exports.ANY, unionType(...e.children.map(x => inferExpr(x, env)))] };
        case "member": return exports.ANY;
        case "index": {
            const base = inferExpr(e.children[0], env);
            return base.kind === "generic" ? (base.name === "dict" ? base.args[1] ?? exports.ANY : base.args[0] ?? exports.ANY) : exports.ANY;
        }
        case "call": {
            const args = e.children.map(x => inferExpr(x, env));
            const n = e.value ?? "";
            if (n === "int" || n === "float" || n === "str" || n === "bool" || n === "bytes")
                return primitive(n);
            if (n === "list")
                return { kind: "generic", name: "list", args: [args[0] ?? exports.ANY] };
            if (n === "dict")
                return { kind: "generic", name: "dict", args: [exports.ANY, exports.ANY] };
            if (n === "len" || n === "ord" || n === "hash" || n === "id")
                return primitive("int");
            if (n === "str" || n === "repr")
                return primitive("str");
            if (n === "isinstance")
                return primitive("bool");
            if (n === "range")
                return { kind: "generic", name: "range", args: [primitive("int")] };
            if (n === "open")
                return primitive("File");
            return exports.ANY;
        }
        case "binary": {
            const ts = e.children.map(x => inferExpr(x, env));
            if (["==", "!=", "is", "is not", ">=", "<=", "and", "or"].includes(e.value ?? ""))
                return primitive("bool");
            if (ts.some(t => typeToString(t) === "str"))
                return primitive("str");
            if (ts.every(t => isSubtype(t, primitive("int"))))
                return primitive("int");
            if (ts.some(t => isSubtype(t, primitive("float"))))
                return primitive("float");
            return exports.ANY;
        }
        default: return exports.ANY;
    }
}
/** Tolerant AST construction from logical source lines; nested bodies use indentation or braces. */
function parseAst(source) {
    const lines = source.split(/\r\n|\n|\r/);
    const root = [];
    const stack = [];
    let braceDepth = 0;
    for (let line = 0; line < lines.length; line++) {
        const raw = lines[line], trimmed = raw.trim();
        if (!trimmed || trimmed.startsWith("#"))
            continue;
        const indent = raw.length - raw.trimStart().length;
        while (stack.length && indent <= stack[stack.length - 1].indent && braceDepth === 0)
            stack.pop();
        const parent = stack[stack.length - 1]?.node;
        const body = parent?.children ?? root;
        const mk = (kind, name, annotation, expression) => ({ kind, line, column: indent, endColumn: raw.length, indent, name, annotation, expression, raw, children: [] });
        let node;
        let m;
        if ((m = /^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/.exec(trimmed)))
            node = mk("def", m[1]);
        else if ((m = /^class\s+([A-Za-z_]\w*)/.exec(trimmed)))
            node = mk("class", m[1]);
        else if ((m = /^(if|elif|while)\s+(.+?)\s*(?:do)?\s*\{?$/.exec(trimmed))) {
            node = mk(m[1]);
            node.condition = parseExpr(m[2]);
        }
        else if (/^(else)\s*(?:do)?\s*\{?$/.test(trimmed))
            node = mk("else");
        else if ((m = /^for\s+([A-Za-z_]\w*)\s+in\s+(.+?)\s*(?:do)?\s*\{?$/.exec(trimmed))) {
            node = mk("for", m[1], undefined, parseExpr(m[2]));
        }
        else if ((m = /^return(?:\s+(.+))?$/.exec(trimmed)))
            node = mk("return", undefined, undefined, parseExpr(m[1] ?? ""));
        else if ((m = /^raise(?:\s+(.+))?$/.exec(trimmed)))
            node = mk("raise", undefined, undefined, parseExpr(m[1] ?? ""));
        else if ((m = /^([A-Za-z_]\w*)\s*:\s*([^=]+?)(?:\s*=\s*(.+))?$/.exec(trimmed)))
            node = mk("annotate", m[1], parseType(m[2]), m[3] ? parseExpr(m[3]) : undefined);
        else if ((m = /^([A-Za-z_]\w*)\s*(?:\+=|-=|\*=|\/=|=)\s*(.+)$/.exec(trimmed)))
            node = mk("assign", m[1], undefined, parseExpr(m[2]));
        else if (trimmed === "pass")
            node = mk("pass");
        else
            node = mk("expr", undefined, undefined, parseExpr(trimmed.replace(/[;{}]+$/g, "")));
        body.push(node);
        if (/[{:]$/.test(trimmed) || ["if", "elif", "else", "while", "for", "def", "class"].includes(node.kind))
            stack.push({ indent, node });
        const opens = (trimmed.match(/{/g) || []).length, closes = (trimmed.match(/}/g) || []).length;
        braceDepth = Math.max(0, braceDepth + opens - closes);
        if (closes > 0) {
            while (stack.length && braceDepth === 0)
                stack.pop();
        }
    }
    return { kind: "module", body: root };
}
function buildCfg(ast) {
    const blocks = [{ id: 0, successors: [], predecessors: [] }];
    let current = 0;
    const add = (statement) => { const b = { id: blocks.length, statement, successors: [], predecessors: [] }; blocks.push(b); blocks[current].successors.push(b.id); b.predecessors.push(current); current = b.id; return b.id; };
    const walk = (items) => { for (const st of items) {
        const id = add(st);
        if (st.kind === "if" || st.kind === "while" || st.kind === "for") {
            const branchStart = current;
            walk(st.children);
            const join = blocks.length;
            const j = { id: join, successors: [], predecessors: [] };
            blocks.push(j);
            blocks[branchStart].successors.push(join);
            j.predecessors.push(branchStart);
            if (current !== branchStart) {
                blocks[current].successors.push(join);
                j.predecessors.push(current);
            }
            current = join;
        }
        else if (st.children.length)
            walk(st.children);
    } };
    walk(ast.body);
    const exit = add();
    return { entry: 0, exit, blocks };
}
/** Forward data-flow type checker with joins and simple branch narrowing. */
function checkTypes(source) {
    const ast = parseAst(source), cfg = buildCfg(ast), diagnostics = [];
    const env = new Map(), annotations = new Map(), returns = [];
    const report = (st, msg, code) => diagnostics.push({ line: st.line, start: st.column, end: Math.max(st.column + 1, st.endColumn), message: msg, code });
    const visit = (items, local) => {
        for (const st of items) {
            if (st.kind === "annotate" && st.name && st.annotation) {
                annotations.set(st.name, st.annotation);
                if (st.expression) {
                    const actual = inferExpr(st.expression, local);
                    if (!assignable(actual, st.annotation))
                        report(st, `Type '${typeToString(actual)}' is not assignable to '${typeToString(st.annotation)}'`, "type-mismatch");
                    local.set(st.name, st.annotation);
                }
                else
                    local.set(st.name, st.annotation);
            }
            else if (st.kind === "assign" && st.name && st.expression) {
                const actual = inferExpr(st.expression, local), expected = annotations.get(st.name);
                if (expected && !assignable(actual, expected))
                    report(st, `Type '${typeToString(actual)}' is not assignable to '${typeToString(expected)}'`, "type-mismatch");
                local.set(st.name, expected ?? actual);
            }
            else if (st.kind === "return" && st.expression)
                returns.push(inferExpr(st.expression, local));
            else if (st.kind === "for" && st.name) {
                local.set(st.name, primitive("int"));
                visit(st.children, new Map(local));
            }
            else if (st.kind === "if" || st.kind === "elif" || st.kind === "while") {
                const branch = new Map(local);
                const cond = st.condition;
                if (cond?.kind === "binary" && cond.value === "is not" && cond.children[0]?.kind === "name" && cond.children[1]?.value === "None") {
                    const n = cond.children[0].value;
                    const old = branch.get(n);
                    if (old?.kind === "union")
                        branch.set(n, unionType(...old.items.filter(x => x.kind !== "none")));
                }
                visit(st.children, branch);
                for (const [k, v] of branch)
                    local.set(k, unionType(local.get(k) ?? v, v));
            }
            else if (st.children.length)
                visit(st.children, new Map(local));
        }
    };
    visit(ast.body, env);
    // CFG-based fixed point: propagate variable facts through predecessor joins.
    const inStates = new Map([[cfg.entry, new Map()]]);
    for (let pass = 0; pass < Math.min(32, cfg.blocks.length * 2); pass++) {
        let changed = false;
        for (const block of cfg.blocks) {
            const incoming = block.predecessors.map(p => inStates.get(p)).filter((x) => !!x);
            const merged = new Map();
            for (const state of incoming)
                for (const [k, v] of state)
                    merged.set(k, unionType(merged.get(k) ?? v, v));
            if (block.statement?.kind === "assign" && block.statement.name && block.statement.expression)
                merged.set(block.statement.name, inferExpr(block.statement.expression, merged));
            const prev = inStates.get(block.id);
            const signature = (m) => [...m].map(([k, v]) => k + ":" + typeToString(v)).sort().join("|");
            if (!prev || signature(prev) !== signature(merged)) {
                inStates.set(block.id, merged);
                changed = true;
            }
        }
        if (!changed)
            break;
    }
    return { ast, cfg, diagnostics, types: env };
}
