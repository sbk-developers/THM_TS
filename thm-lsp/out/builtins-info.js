"use strict";
/**
 * Static knowledge of THM's built-ins, mirrored from the thm runtime source
 * (`src/vm/vm.ts` installBuiltins and `src/builtins/modules/*`).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.GLOBAL_SIGNATURES = exports.TYPE_MEMBERS = exports.MODULE_DESCRIPTIONS = exports.BUILTIN_MODULES = exports.KEYWORD_HELP = exports.GLOBAL_TYPES = exports.GLOBAL_FUNCTIONS = void 0;
/** Global built-in functions installed by the VM (`installBuiltins`). */
exports.GLOBAL_FUNCTIONS = {
    write: "write(*values) -> None — print values separated by spaces, then a newline",
    print: "print(*values) -> None — alias of write()",
    len: "len(obj) -> int — length of a str, list, tuple, dict, set, range or bytes",
    isinstance: "isinstance(obj, cls) -> bool — true when obj is an instance of cls (or its subclass)",
    issubclass: "issubclass(cls, base) -> bool — true when cls derives from base",
    super: "super() — the next class in the MRO for the enclosing method",
    staticmethod: "staticmethod(fn) — wrap fn as a static method",
    classmethod: "classmethod(fn) — wrap fn as a class method",
    property: "property(get, [set], [delete]) — declare a managed attribute",
    type: "type(x) — the runtime type of x, or type(name, bases, dict) to build a class",
    abs: "abs(n) -> number — absolute value",
    all: "all(iterable) -> bool — true when every element is truthy",
    any: "any(iterable) -> bool — true when any element is truthy",
    callable: "callable(v) -> bool — true when v can be called",
    chr: "chr(code) -> str — character for a Unicode code point",
    divmod: "divmod(a, b) -> tuple — quotient and remainder pair",
    enumerate: "enumerate(iterable, [start=0]) — iterator of (index, item) pairs",
    filter: "filter(fn, iterable) — elements where fn(element) is truthy",
    iter: "iter(iterable) — iterator over the elements",
    map: "map(fn, *iterables) — fn applied to each element positionally",
    max: "max(*args) — largest argument",
    min: "min(*args) — smallest argument",
    next: "next(iterator) — the next element, raising StopIteration when exhausted",
    ord: "ord(ch) -> int — Unicode code point of a one-character string",
    pow: "pow(base, exp, [mod]) — base raised to exp",
    repr: "repr(v) -> str — the debug representation of v",
    reversed: "reversed(seq) — iterator over seq backwards",
    round: "round(n, [digits]) — rounded value",
    setattr: "setattr(obj, name, value) — set an attribute",
    getattr: "getattr(obj, name, [default]) — read an attribute or default",
    hasattr: "hasattr(obj, name) -> bool — true when the attribute exists",
    sorted: "sorted(iterable, [key], [reverse]) -> list — sorted copy",
    sum: "sum(iterable, [start]) — total of the elements",
    zip: "zip(*iterables) — iterator of tuples of corresponding elements",
    gc_collect: "gc_collect() -> int — collect unreachable managed objects",
    input: "input([prompt]) -> str — read a line from stdin",
};
/** Runtime types and exception classes exposed as globals. */
exports.GLOBAL_TYPES = {
    bool: "bool — truth type (true/false)",
    dict: "dict — key/value map",
    float: "float — binary floating-point number",
    int: "int — arbitrary-precision integer",
    list: "list — mutable sequence",
    range: "range — arithmetic progression",
    set: "set — unordered unique collection",
    str: "str — UTF-8 text",
    tuple: "tuple — immutable sequence",
    type: "type — the type of types",
    BaseException: "BaseException — root of the exception hierarchy",
    Exception: "Exception — parent of all standard exceptions",
    ArithmeticError: "ArithmeticError(Exception)",
    ZeroDivisionError: "ZeroDivisionError(ArithmeticError) — division or modulo by zero",
    OverflowError: "OverflowError(ArithmeticError)",
    AssertionError: "AssertionError(Exception) — raised by a failed assert",
    AttributeError: "AttributeError(Exception) — missing attribute",
    EOFError: "EOFError(Exception)",
    ImportError: "ImportError(Exception) — module resolution or execution failure",
    LookupError: "LookupError(Exception)",
    IndexError: "IndexError(LookupError) — sequence subscript out of range",
    KeyError: "KeyError(LookupError) — missing dict key",
    NameError: "NameError(Exception) — unknown name",
    OSError: "OSError(Exception) — filesystem failure",
    RuntimeError: "RuntimeError(Exception)",
    NotImplementedError: "NotImplementedError(RuntimeError)",
    RecursionError: "RecursionError(RuntimeError)",
    StopIteration: "StopIteration(Exception)",
    TypeError: "TypeError(Exception) — wrong type/value shape",
    ValueError: "ValueError(Exception) — right type, wrong value",
};
/** Language keywords with short descriptions. */
exports.KEYWORD_HELP = {
    and: "Boolean AND (short-circuit)",
    as: "alias in `import ... as` / `from ... import ... as` / `except ... as`",
    assert: "assert condition[, message] — raise AssertionError when condition is falsy",
    break: "exit the enclosing loop",
    case: "case value { ... } — branch of a switch statement",
    default: "default { ... } — fallback branch of a switch statement",
    class: "class Name(Bases) { ... } — declare a class",
    continue: "jump to the next loop iteration",
    def: "def name(params) { ... } — declare a function",
    del: "del target — remove a variable, attribute or item",
    elif: "alternative branch of an if/elif chain",
    else: "fallback branch of if/while/for/try",
    except: "exception handler clause of try",
    finally: "always-run clause of try",
    for: "for item in iterable { ... } — iterate; optional else clause",
    from: "from module import member [as alias], ...",
    global: "global name — assign the module-level binding",
    if: "if condition { ... }",
    import: "import module [as alias]",
    in: "membership test / for target",
    is: "identity comparison",
    lambda: "lambda params: expression — anonymous function",
    nonlocal: "nonlocal name — assign the nearest enclosing function binding",
    not: "Boolean NOT",
    or: "Boolean OR (short-circuit)",
    pass: "do nothing",
    raise: "raise expr — throw an exception object (bare raise re-throws)",
    return: "return [value] — leave the function",
    switch: "switch (subject) { case value { ... } default { ... } } — multi-way branch",
    try: "try { ... } except E [as e] { ... } else { ... } finally { ... }",
    while: "while condition { ... } — optional else clause",
};
/** Built-in modules with their member surfaces (mirrors src/builtins/modules). */
exports.BUILTIN_MODULES = {
    math: {
        pi: "value — π constant",
        e: "value — e constant",
        tau: "value — τ constant",
        sqrt: "sqrt(x) — square root",
        floor: "floor(x) — round down",
        ceil: "ceil(x) — round up",
        sin: "sin(x) — sine",
        cos: "cos(x) — cosine",
    },
    os: {
        getcwd: "getcwd() — current working directory",
        exists: "exists(path) — path exists?",
        isdir: "isdir(path) — path is a directory?",
        listdir: "listdir([path]) — directory entries",
        join: "join(*paths) — join with the platform separator",
        system: "system(cmd) — run a shell command",
        platform: "platform() — OS platform",
        arch: "arch() — CPU architecture",
        version: "version() — kernel release",
        cpus: "cpus() — CPU model",
    },
    random: {
        seed: "seed(n) — seed the generator",
        random: "random() — float in [0, 1)",
        randint: "randint(a, b) — inclusive integer",
        randrange: "randrange([start], stop, [step])",
        uniform: "uniform(a, b) — float in [a, b]",
        gauss: "gauss(mu, sigma) — normal deviate",
        getrandbits: "getrandbits(k) — k random bits",
        choice: "choice(seq) — one element",
        choices: "choices(seq, [k]) — sample with replacement",
        shuffle: "shuffle(seq) — in-place shuffle",
        sample: "sample(seq, k) — sample without replacement",
    },
    sys: {
        argv: "value — argument list",
        exit: "exit([code]) — terminate the process",
        platform: 'value — "thm"',
        version: "value — interpreter version",
    },
    bytes: {
        bytes: "bytes(iterable) — construct bytes",
        len: "len(b) — byte count",
        getitem: "getitem(b, i)",
        slice: "slice(b, start, stop, step)",
        decode: "decode(b, [encoding])",
        encode: "encode(s, [encoding])",
        hex: "hex(b) — hex string",
        fromhex: "fromhex(s) — parse hex",
    },
    requests: {
        get: "get(url) — HTTP GET, returns a response object",
    },
    test_sbk: {
        greet: "greet() — example custom built-in",
        values: "values — example constants",
    },
};
exports.MODULE_DESCRIPTIONS = {
    math: "Mathematical constants and trigonometry/rounding functions",
    os: "Host operating-system and filesystem access",
    random: "Pseudo-random number generation",
    sys: "Interpreter-level values (argv, exit, version)",
    bytes: "Byte-buffer construction, slicing and encoding helpers",
    requests: "HTTP GET and file reading helpers",
    test_sbk: "Example custom built-in module",
};
/** Common attribute members by receiver type name (best effort). */
exports.TYPE_MEMBERS = {
    str: {
        upper: "upper() — uppercase copy",
        lower: "lower() — lowercase copy",
        strip: "strip([chars]) — trim both ends",
        split: "split([sep]) — split into a list",
        join: "join(parts) — concatenate with this separator",
        replace: "replace(old, new)",
        startswith: "startswith(prefix) — prefix check",
        endswith: "startswith(prefix) — suffix check",
        find: "find(needle) — first index or -1",
        format: "format(*args) — substitution",
    },
    list: {
        append: "append(item) — push at the end",
        pop: "pop([index]) — remove and return",
        extend: "extend(other) — append all",
        insert: "insert(i, item)",
        remove: "remove(value) — delete first match",
        sort: "sort() — in-place sort",
        reverse: "reverse() — in-place reversal",
        clear: "clear() — drop all items",
        index: "index(value) — first position",
        count: "count(value) — occurrences",
    },
    dict: {
        keys: "keys() — iterable of keys",
        values: "values() — iterable of values",
        items: "items() — iterable of (k, v) pairs",
        get: "get(key, [default])",
        pop: "pop(key, [default])",
        setdefault: "setdefault(key, default)",
        clear: "clear() — empty the map",
        update: "update(other) — merge",
    },
    set: {
        add: "add(item)",
        remove: "remove(item)",
        discard: "discard(item)",
        clear: "clear()",
    },
};
/** Signature index combining everything callable by bare name. */
exports.GLOBAL_SIGNATURES = buildSignatures();
function buildSignatures() {
    const signatures = {};
    for (const [name, doc] of Object.entries(exports.GLOBAL_FUNCTIONS)) {
        const open = doc.indexOf("(");
        const close = doc.indexOf(")", open);
        const parameterText = open >= 0 && close > open ? doc.slice(open + 1, close) : "";
        const label = doc.split("—")[0].trim();
        signatures[name] = {
            label,
            parameters: parameterText
                .split(",")
                .map((part) => part.trim())
                .filter((part) => part !== "")
                .map((part) => ({
                label: part.replace(/^\*\*/, "**").replace(/^\*/, "*"),
            })),
            documentation: doc.slice(doc.indexOf("—") + 1).trim() || doc,
        };
    }
    for (const [name, doc] of Object.entries(exports.GLOBAL_TYPES)) {
        signatures[name] = {
            label: `${name}(initializers...)`,
            parameters: [],
            documentation: doc,
        };
    }
    return signatures;
}
