import { compile } from "../../src/compiler.js";
import {
  RuntimeError,
  ThmIndexError,
  ThmNameError,
  ThmRecursionError,
  ThmTypeError,
  ThmValueError,
  ThmZeroDivisionError,
} from "../../src/errors/errors.js";
import { parse } from "../../src/parser/parser.js";
import { VM } from "../../src/vm/vm.js";
import type { Platform } from "../../src/platform/platform.js";
import { assert, equal, test, throws } from "../harness.js";
import { readTraceback } from "../../src/errors/errors.js";

function run(source: string, recursionLimit = 1000): string {
  const output: string[] = [];
  const platform: Platform = {
    readFile: () => {
      throw new Error("not available");
    },
    writeFile: () => undefined,
    readBinaryFile: () => new Uint8Array(),
    writeBinaryFile: () => undefined,
    exists: () => false,
    listDir: () => [],
    isDirectory: () => false,
    stdout: (text) => output.push(text),
    stderr: () => undefined,
    args: () => [],
    exit: () => {
      throw new Error("unexpected exit");
    },
    cwd: () => "/test",
    joinPath: (...parts) => parts.join("/"),
    clock: () => 0,
  };
  new VM(platform, recursionLimit).run(compile(parse(source), "test.thm"));
  return output.join("");
}

test("VM executes list, set, and dict comprehensions", () => {
  equal(
    run(`values = [1, 2, 3, 4]
doubled = [x * 2 for x in values if x > 1]
squares = {x: x * x for x in values if x % 2 == 0}
unique = {x % 2 for x in values}
pairs = [x + y for x in [1, 2] for y in [10, 20]]
write(doubled, squares[2], squares[4], len(unique), pairs)
`),
    "[4, 6, 8] 4 16 2 [11, 21, 12, 22]\n",
  );
});

test("comprehension iteration variables do not overwrite surrounding bindings", () => {
  equal(
    run("x = 99\nitems = [x for x in [1, 2, 3]]\nwrite(x, items)\n"),
    "99 [1, 2, 3]\n",
  );
});

test("VM supports tuple-unpacking targets in comprehensions", () => {
  equal(
    run("pairs = [(1, 2), (3, 4)]\nresult = [a + b for a, b in pairs]\nwrite(result)\n"),
    "[3, 7]\n",
  );
});

test("VM evaluates chained assignment once and tuple assignment atomically", () => {
  equal(
    run(
      "calls = 0\n" +
        "def next_value() {\n global calls\n calls += 1\n return calls\n}\n" +
        "a = b = next_value()\n" +
        "left, right = 10, 20\n" +
        "left, right = right, left\n" +
        "write(a, b, calls, left, right)\n",
    ),
    "1 1 1 20 10\n",
  );
  throws(() => run("a, b = [1]\n"), (error) => error instanceof ThmValueError);
  equal(
    run(
      "indices = []\n" +
        "def get_index(value) {\n global indices\n indices.append(value)\n return value\n}\n" +
        "items = [0, 0]\n" +
        "items[get_index(0)], items[get_index(1)] = 10, 20\n" +
        "write(indices, items)\n",
    ),
    "[0, 1] [10, 20]\n",
  );
});

test("VM preserves arbitrary-precision integers and Python-style floor division", () => {
  equal(
    run("write(9007199254740993 + 2, -7 // 3, -7 % 3, 5 & 3, 2 ** 100)\n"),
    "9007199254740995 -3 2 1 1267650600228229401496703205376\n",
  );
  equal(run("write(1 + 1.5, type(1), type(1.0))\n"), "2.5 <class 'int'> <class 'float'>\n");
  equal(run("write(+true, type(+true), -true)\n"), "1 <class 'int'> -1\n");
});

test("VM binds defaults, keyword-only, variadic, and unpacked arguments", () => {
  equal(
    run(
      "def show(a, b=2, *rest, c=3, **options) {\n" +
        " write(a, b, rest, c, options)\n" +
        "}\n" +
        "show(1, c=8, b=4, extra=9)\n" +
        "show(*[5, 6, 7], **{\"c\": 10, \"other\": 11})\n" +
        "f = lambda value=12: value\n" +
        "write(f())\n" +
        "class Box {\n" +
        " def __init__(self, value=13) { self.value = value }\n" +
        "}\n" +
        "write(Box(value=14).value)\n",
    ),
    "1 4 () 8 {\"extra\": 9}\n5 6 (7,) 10 {\"other\": 11}\n12\n14\n",
  );
});

test("VM rejects duplicate and unknown function arguments", () => {
  throws(
    () => run("def f(value) { return value }\nf(1, value=2)\n"),
    (error) => error instanceof Error && error.message.includes("multiple values"),
  );
  throws(
    () => run("def f(value) { return value }\nf(unknown=2)\n"),
    (error) => error instanceof Error && error.message.includes("unexpected keyword"),
  );
  throws(
    () => run("write(value=2)\n"),
    (error) => error instanceof Error && error.message.includes("does not accept keyword"),
  );
});

test("VM executes while-else only after normal loop termination", () => {
  equal(
    run(
      "count = 0\n" +
        "while count < 2 {\n count += 1\n} else {\n write(\"finished\", count)\n}\n" +
        "while true {\n break\n} else {\n write(\"unreachable\")\n}\n",
    ),
    "finished 2\n",
  );
});

test("VM accepts generic classes as runtime metadata", () => {
  equal(
    run(
      "class Box[T] {\n" +
        " def __init__(self, value) { self.value = value }\n" +
        "}\n" +
        "number = Box[int](42)\n" +
        "text = Box[str](\"ok\")\n" +
        "write(number.value, text.value)\n",
    ),
    "42 ok\n",
  );
});

test("VM retains shared closure cells and runs recursion on explicit frames", () => {
  equal(
    run(
      "def counter() {\n" +
        " value = 0\n" +
        " def increment() {\n" +
        "  nonlocal value\n" +
        "  value += 1\n" +
        "  return value\n" +
        " }\n" +
        " return increment\n" +
        "}\n" +
        "count = counter()\n" +
        "write(count(), count())\n" +
        "def factorial(n) {\n if n <= 1 { return 1 }\n return n * factorial(n - 1)\n}\n" +
        "write(factorial(6))\n",
    ),
    "1 2\n720\n",
  );
  throws(
    () => run("def recurse() { return recurse() }\nrecurse()\n", 30),
    (error) => error instanceof ThmRecursionError,
  );
});

test("VM short-circuits logical operands and chained comparisons", () => {
  equal(
    run(
      "calls = 0\n" +
        "def side_effect() {\n global calls\n calls += 1\n return 2\n}\n" +
        "a = 1 < 0 < side_effect()\n" +
        "b = false and side_effect()\n" +
        "c = true or side_effect()\n" +
        "write(a, b, c, calls)\n",
    ),
    "false false true 0\n",
  );
});

test("VM compiles and executes lambda functions through VM frames", () => {
  equal(
    run(
      "increment = lambda value: value + 1\n" +
        "write(increment(4))\n" +
        "write(1 | 2 ^ 3 & 2 << 1, ~2)\n",
    ),
    "5\n3 -3\n",
  );
});

test("VM parses f-string expressions and treats generic subscriptions as metadata", () => {
  equal(
    run(
      'name = "Sobuj"\n' +
        "age = 20\n" +
        'write(f"Hello {name}")\n' +
        'write(f"Age: {age + 1}")\n' +
        'write(f"Result: {{literal braces}}")\n' +
        `write(f"Nested: {f'Value {age}'}")\n` +
        "def identity[T](value: T) -> T { return value }\n" +
        "write(identity[int](100))\n" +
        'write(1 is not 2, "a" in "cat", 4 if true else 5)\n',
    ),
    "Hello Sobuj\nAge: 21\nResult: {literal braces}\nNested: Value 20\n100\ntrue true 4\n",
  );
  throws(
    () => run('value = 1\nwrite(f"{value:04}")\n'),
    (error) => error instanceof Error && error.name === "SyntaxError",
  );
});

test("VM implements slices, negative arithmetic, and target evaluation exactly once", () => {
  equal(
    run(
      "items = [0, 1, 2, 3, 4]\n" +
        "write(items[1:4], items[:3], items[2:], items[::2], items[::-1])\n" +
        "write(-7 // 2, -7 % 3, 2 ** 3 ** 2)\n" +
        "calls = 0\n" +
        "def get_index() {\n global calls\n calls += 1\n return 0\n}\n" +
        "items[get_index()] += 1\n" +
        "write(calls, items[0])\n",
    ),
    "[1, 2, 3] [0, 1, 2] [2, 3, 4] [0, 2, 4] [4, 3, 2, 1, 0]\n-4 2 512\n1 1\n",
  );
  throws(() => run("items = [1]\nitems[::0]\n"), (error) => error instanceof Error && error.name === "ValueError");
  throws(() => run("items = [1]\nitems[2]\n"), (error) => error instanceof ThmIndexError);
  throws(() => run("a = 1 / 0\n"), (error) => error instanceof ThmZeroDivisionError);
  throws(() => run("range(0, 4, 0)\n"), (error) => error instanceof ThmValueError);
});

test("VM dictionary attributes follow method-key-fallback precedence", () => {
  equal(
    run(
      'd = {"keys": "item", "name": "Sobuj", "age": 20}\n' +
        'write(d.name, d["keys"], d.keys())\n' +
        'd.city = "Dhaka"\n' +
        'd["age"] = 21\n' +
        'write(d.city, d.age, d["age"])\n',
    ),
    'Sobuj item ["keys", "name", "age"]\nDhaka 21 21\n',
  );
  throws(() => run('d = {}\nwrite(d.missing)\n'), (error) => error instanceof Error && error.name === "KeyError");
});

test("VM supports numeric bool compatibility and lazy iteration helpers", () => {
  equal(
    run(
      "write(true + 1, isinstance(true, int), type(true) == bool, true == 1)\n" +
        "def twice(x) { return x * 2 }\n" +
        "write(list(map(twice, [1, 2, 3])))\n" +
        "write(list(filter(twice, [0, 1, 2])))\n" +
        "write(list(reversed([1, 2, 3])))\n" +
        "for index, value in enumerate([8, 9]) { write(index, value) }\n" +
        "for pair in zip([1, 2], [3, 4]) { write(pair) }\n",
    ),
    "2 true true true\n[2, 4, 6]\n[1, 2]\n[3, 2, 1]\n0 8\n1 9\n(1, 3)\n(2, 4)\n",
  );
});

test("VM detects collection mutation during iteration and raises NameError for bare annotations", () => {
  throws(
    () => run('d = {"a": 1}\nfor key in d { d["b"] = 2 }\n'),
    (error) => error instanceof RuntimeError,
  );
  throws(() => run("x: unknown\nwrite(x)\n"), (error) => error instanceof ThmNameError);
  equal(run('x: unknown\na: int = "text"\nwrite(a)\n'), "text\n");
  throws(
    () => run("a = 5\nx, a = [1]\n"),
    (error) => error instanceof ThmValueError,
  );
});

test("VM collects unreachable cycles from its logical heap", () => {
  const output = run("cycle = []\ncycle.append(cycle)\ncycle = none\nremoved = gc_collect()\nwrite(removed > 0)\n");
  equal(output, "true\n");
});

test("VM uses cycle-safe structural equality and representation", () => {
  equal(
    run(
      "a = []\n" +
        "a.append(a)\n" +
        "b = []\n" +
        "b.append(b)\n" +
        "write(a == b, a)\n" +
        "d = {}\n" +
        'd["self"] = d\n' +
        "write(d)\n",
    ),
    "true [[...]]\n{\"self\": {...}}\n",
  );
});

test("VM preserves insertion order and numeric dictionary key equivalence", () => {
  equal(
    run('d = {true: "first", "x": 2}\nd[1] = "updated"\nwrite(d, len(d))\n'),
    '{true: "updated", "x": 2} 2\n',
  );
  assert(true);
});

test("VM reports collection mutation and recursion errors as runtime failures", () => {
  throws(
    () => run("values = {1, 2}\nfor value in values { values.add(3) }\n"),
    (error) => error instanceof RuntimeError,
  );
});

test("VM supports classes, instance fields, methods, and class attributes", () => {
  equal(
    run(
      "class User {\n" +
        " species = 'human'\n" +
        " def __init__(self, name) { self.name = name }\n" +
        " def greet(self) { return 'Hello ' + self.name }\n" +
        "}\n" +
        "user = User('Sobuj')\n" +
        "user.age = 20\n" +
        "write(user.name, user.age, user.species, user.greet())\n" +
        "write(User.species)\n",
    ),
    "Sobuj 20 human Hello Sobuj\nhuman\n",
  );
});

test("VM supports static methods, class methods, and properties", () => {
  equal(
    run(
      "class Base {\n" +
        " @staticmethod\n" +
        " def add(left, right) { return left + right }\n" +
        " @classmethod\n" +
        " def label(cls) { return cls.__name__ }\n" +
        " @property\n" +
        " def value(self) { return self._value }\n" +
        " @value.setter\n" +
        " def value(self, next) { self._value = next }\n" +
        " @value.deleter\n" +
        " def value(self) { del self._value }\n" +
        "}\n" +
        "class Child(Base) {}\n" +
        "class Root {\n" +
        " @classmethod\n" +
        " def identify(cls) { return 'Root' }\n" +
        "}\n" +
        "class Mid(Root) {\n" +
        " @classmethod\n" +
        " def identify(cls) { return 'Mid' + super().identify() }\n" +
        "}\n" +
        "class Leaf(Mid) {\n" +
        " @classmethod\n" +
        " def identify(cls) { return 'Leaf' + super().identify() }\n" +
        "}\n" +
        "item = Child()\n" +
        "item.value = 12\n" +
        "write(Base.add(2, 3), item.add(4, 5), Base.label(), Child.label(), item.label(), item.value)\n" +
        "write(Leaf.identify())\n",
    ),
    "5 9 Base Child Child 12\nLeafMidRoot\n",
  );
  throws(
    () => run(
      "class Item {\n" +
        " @property\n" +
        " def value(self) { return self._value }\n" +
        " @value.deleter\n" +
        " def value(self) { del self._value }\n" +
        "}\n" +
        "item = Item()\n" +
        "item._value = 1\n" +
        "del item.value\n" +
        "write(item.value)\n",
    ),
    (error) => error instanceof ThmNameError,
  );
});

test("VM propagates property getter, setter, and deleter exceptions to caller handlers", () => {
  equal(
    run(
      "class Item {\n" +
        " @property\n" +
        " def value(self) { raise ValueError(\"getter failed\") }\n" +
        " @value.setter\n" +
        " def value(self, next) { raise ValueError(\"setter failed\") }\n" +
        " @value.deleter\n" +
        " def value(self) { raise ValueError(\"deleter failed\") }\n" +
        "}\n" +
        "item = Item()\n" +
        "try {\n write(item.value)\n} except ValueError {\n write(\"getter caught\")\n}\n" +
        "try {\n item.value = 1\n} except ValueError {\n write(\"setter caught\")\n}\n" +
        "try {\n del item.value\n} except ValueError {\n write(\"deleter caught\")\n}\n" +
        "write(\"finished\")\n",
    ),
    "getter caught\nsetter caught\ndeleter caught\nfinished\n",
  );
});

test("VM propagates exceptions through nested calls inside a property callback", () => {
  equal(
    run(
      "def fail() { raise ValueError(\"nested property failure\") }\n" +
        "class Item {\n" +
        " @property\n" +
        " def value(self) { return fail() }\n" +
        "}\n" +
        "item = Item()\n" +
        "try {\n write(item.value)\n} except ValueError {\n write(\"nested caught\")\n}\n" +
        "write(\"still running\")\n",
    ),
    "nested caught\nstill running\n",
  );
});

test("VM preserves the original exception raised by an unhandled property callback", () => {
  const error = throws(() =>
    run(
      "class Item {\n" +
        " @property\n" +
        " def value(self) { return self._value }\n" +
        " @value.setter\n" +
        " def value(self, next) { raise ValueError(\"invalid property value\") }\n" +
        "}\n" +
        "item = Item()\nitem.value = 10\n",
    ),
  );
  assert(error instanceof Error);
  equal(error.name, "ValueError");
  equal(error.message, "invalid property value");
});

test("VM supports custom descriptor get, set, and delete methods", () => {
  equal(
    run(
      "class Descriptor {\n" +
        " def __get__(self, instance, owner) {\n" +
        "  if instance == none { return self }\n" +
        "  return instance._stored\n" +
        " }\n" +
        " def __set__(self, instance, value) { instance._stored = value }\n" +
        " def __delete__(self, instance) { del instance._stored }\n" +
        "}\n" +
        "class Record {\n" +
        " value = Descriptor()\n" +
        "}\n" +
        "record = Record()\n" +
        "record.value = 42\n" +
        "write(record.value, Record.value == Record.value)\n" +
        "del record.value\n",
    ),
    "42 true\n",
  );
  throws(
    () => run(
      "class Descriptor {\n" +
        " def __get__(self, instance, owner) { return instance._stored }\n" +
        " def __delete__(self, instance) { del instance._stored }\n" +
        "}\n" +
        "class Record {\n value = Descriptor()\n}\n" +
        "record = Record()\n" +
        "record._stored = 1\n" +
        "del record.value\n" +
        "write(record._stored)\n",
    ),
    (error) => error instanceof ThmNameError,
  );
});

test("VM selects and invokes metaclasses using type.__new__", () => {
  equal(
    run(
      "class Meta(type) {\n" +
        " @staticmethod\n" +
        " def __new__(cls, name, bases, namespace) {\n" +
        "  namespace['created'] = 'yes'\n" +
        "  return type.__new__(cls, name, bases, namespace)\n" +
        " }\n" +
        " def __init__(cls, name, bases, namespace) { cls.initialized = name }\n" +
      "}\n" +
        "class Base(metaclass=Meta) {}\n" +
        "class Child(Base) {}\n" +
        "class CallableMeta(type) {\n" +
        " def __call__(cls, value) { return value + 1 }\n" +
        "}\n" +
        "class Factory(metaclass=CallableMeta) {}\n" +
        "write(Base.created, Base.initialized, Child.created, Child.initialized)\n" +
        "write(type(Base) == Meta, isinstance(Base, Meta), isinstance(Meta, type), issubclass(Meta, type))\n" +
        "write(Factory(4), type('Made', (), {'value': 9}).value)\n",
    ),
    "yes Base yes Child\ntrue true true true\n5 9\n",
  );
  throws(
    () => run(
      "class MetaA(type) {}\n" +
        "class MetaB(type) {}\n" +
        "class A(metaclass=MetaA) {}\n" +
        "class B(metaclass=MetaB) {}\n" +
        "class Conflict(A, B) {}\n",
    ),
    (error) => error instanceof ThmTypeError && error.message.includes("metaclass conflict"),
  );
});

test("VM supports single inheritance, inherited methods, and method overrides", () => {
  equal(
    run(
      "class Animal {\n" +
        " def __init__(self, name) { self.name = name }\n" +
        " def speak(self) { return self.name + ' makes a sound' }\n" +
        "}\n" +
        "class Dog(Animal) {\n" +
        " def speak(self) { return self.name + ' barks' }\n" +
        "}\n" +
        "dog = Dog('Rex')\n" +
        "animal = Animal('Cat')\n" +
        "write(dog.speak(), animal.speak(), dog.name)\n",
    ),
    "Rex barks Cat makes a sound Rex\n",
  );
});

test("VM dispatches arithmetic and comparison operators to class magic methods", () => {
  equal(
    run(
      "class Number {\n" +
        " def __init__(self, value) { self.value = value }\n" +
        " def __add__(self, other) { return Number(self.value + other.value) }\n" +
        " def __lt__(self, other) { return self.value < other.value }\n" +
        " def __neg__(self) { return Number(-self.value) }\n" +
        "}\n" +
        "a = Number(4)\nb = Number(7)\nc = a + b\nd = -a\n" +
        "write(c.value, d.value, a < b)\n",
    ),
    "11 -4 true\n",
  );
});

test("VM supports multiple inheritance with C3 MRO and cooperative super()", () => {
  equal(
    run(
      "class A {\n def who(self) { return 'A' }\n}\n" +
        "class B(A) {\n def who(self) { return 'B' + super().who() }\n}\n" +
        "class C(A) {\n def who(self) { return 'C' + super().who() }\n}\n" +
        "class D(B, C) {\n def who(self) { return 'D' + super().who() }\n}\n" +
        "value = D()\n" +
        "write(value.who(), isinstance(value, A), issubclass(D, C))\n",
    ),
    "DBCA true true\n",
  );
  throws(
    () => run(
      "class A {}\nclass B {}\nclass X(A, B) {}\nclass Y(B, A) {}\nclass Z(X, Y) {}\n",
    ),
    (error) => error instanceof Error && error.message.includes("method resolution order"),
  );
});

test("VM supports zero-argument super(), isinstance(), and issubclass()", () => {
  equal(
    run(
      "class Base {\n" +
        " def __init__(self, name) { self.name = name }\n" +
        " def message(self) { return self.name + ' base' }\n" +
        "}\n" +
        "class Child(Base) {\n" +
        " def __init__(self, name) { super().__init__(name) }\n" +
        " def message(self) { return super().message() + ' child' }\n" +
        "}\n" +
        "child = Child('Rex')\n" +
        "write(child.message(), isinstance(child, Child), isinstance(child, Base), issubclass(Child, Base), issubclass(Base, Child), type(child) == Child)\n",
    ),
    "Rex base child true true true false true\n",
  );
});

test("VM attaches a call-stack traceback to unhandled runtime errors", () => {
  const error = throws(() =>
    run(
      "def bar() {\n raise ValueError(\"boom\")\n}\n" +
        "def foo() {\n bar()\n}\n" +
        "foo()\n",
    ),
  );
  assert(error instanceof Error);
  equal(error.name, "ValueError");
  equal(error.message, "boom");
  const traceback = readTraceback(error);
  assert(traceback !== undefined);
  assert(traceback.frames.length >= 3);
  equal(traceback.frames[0].name, "bar");
  equal(traceback.frames[1].name, "foo");
  equal(traceback.frames[traceback.frames.length - 1].name, "<module>");
  for (const frame of traceback.frames) {
    assert(frame.filename === "test.thm");
    assert(Number.isInteger(frame.line) && frame.line >= 1);
  }
});

test("VM does not surface a traceback when the exception is handled", () => {
  equal(
    run(
      "def bar() {\n raise ValueError(\"boom\")\n}\n" +
        "try {\n bar()\n} except ValueError {\n write(\"caught\")\n}\n",
    ),
    "caught\n",
  );
});

test("VM formats an unhandled top-level error without a function frame", () => {
  const error = throws(() => run("raise TypeError(\"bad type\")\n"));
  assert(error instanceof Error);
  equal(error.name, "TypeError");
  equal(error.message, "bad type");
  const traceback = readTraceback(error);
  assert(traceback !== undefined);
  assert(traceback.frames.length === 1);
  equal(traceback.frames[0].name, "<module>");
});

test("custom descriptor __get__ exceptions propagate to the accessing caller", () => {
  equal(run(
    "def fail() { raise ValueError(\"get boom\") }\n" +
    "class D { def __get__(self, instance, owner) { fail() } }\n" +
    "class C { value = D() }\n" +
    "obj = C()\n" +
    "try { write(obj.value) } except ValueError as e { write(e) }\n" +
    "write(\"after get\")\n"
  ), "ValueError: get boom\nafter get\n");
});

test("custom descriptor __set__ exceptions propagate to the assigning caller", () => {
  equal(run(
    "def fail() { raise ValueError(\"set boom\") }\n" +
    "class D { def __get__(self, instance, owner) { return self } def __set__(self, instance, value) { fail() } }\n" +
    "class C { value = D() }\n" +
    "obj = C()\n" +
    "try { obj.value = 1 } except ValueError as e { write(e) }\n" +
    "write(\"after set\")\n"
  ), "ValueError: set boom\nafter set\n");
});

test("custom descriptor __delete__ exceptions propagate to the deleting caller", () => {
  equal(run(
    "def fail() { raise ValueError(\"delete boom\") }\n" +
    "class D { def __get__(self, instance, owner) { return self } def __delete__(self, instance) { fail() } }\n" +
    "class C { value = D() }\n" +
    "obj = C()\n" +
    "try { del obj.value } except ValueError as e { write(e) }\n" +
    "write(\"after delete\")\n"
  ), "ValueError: delete boom\nafter delete\n");
});

test("decorator callback exceptions propagate at decoration time", () => {
  equal(run(
    "def bad(fn) { raise ValueError(\"decorate boom\") }\n" +
    "try {\n @bad\n def target() { return 1 }\n} except ValueError as e { write(e) }\n" +
    "write(\"after decorate\")\n"
  ), "ValueError: decorate boom\nafter decorate\n");
});

test("decorator wrapper exceptions propagate through nested and recursive calls", () => {
  equal(run(
    "def explode(n) {\n if n == 0 { raise ValueError(\"wrapper boom\") }\n return explode(n - 1)\n}\n" +
    "def wrap(fn) {\n def wrapped(n) {\n  if n == 0 { return fn(n) }\n  return wrapped(n - 1)\n }\n return wrapped\n}\n" +
    "@wrap\n def target(n) { return explode(n) }\n" +
    "try { target(3) } except ValueError as e { write(e) }\n" +
    "write(\"after wrapper\")\n"
  ), "ValueError: wrapper boom\nafter wrapper\n");
});

test("custom descriptor unhandled exceptions preserve type and message", () => {
  const cases = [
    "class D { def __get__(self, instance, owner) { raise ValueError(\"get unhandled\") } } class C { value = D() } obj = C() write(obj.value)",
    "class D { def __get__(self, instance, owner) { return self } def __set__(self, instance, value) { raise ValueError(\"set unhandled\") } } class C { value = D() } obj = C() obj.value = 1",
    "class D { def __get__(self, instance, owner) { return self } def __delete__(self, instance) { raise ValueError(\"delete unhandled\") } } class C { value = D() } obj = C() del obj.value",
  ];
  const messages = ["get unhandled", "set unhandled", "delete unhandled"];
  cases.forEach((source, index) => {
    const error = throws(() => run(source));
    assert(error instanceof Error);
    equal(error.name, "ValueError");
    equal(error.message, messages[index]!);
  });
});

test("decorator wrapper preserves original unhandled exception", () => {
  const error = throws(() => run(
    "def decorate(fn) {\n def wrapped() { raise ValueError(\"wrapper unhandled\") }\n return wrapped\n}\n" +
    "@decorate\n def target() { return 1 }\n" +
    "target()\n"
  ));
  assert(error instanceof Error);
  equal(error.name, "ValueError");
  equal(error.message, "wrapper unhandled");
});

test("decorator factory and class decorator exceptions propagate to surrounding handlers", () => {
  equal(run(
    "def factory() { raise ValueError(\"factory boom\") }\n" +
    "try {\n @factory()\n def target() { return 1 }\n} except ValueError as e { write(e) }\n" +
    "def bad_class(cls) { raise TypeError(\"class decorator boom\") }\n" +
    "try {\n @bad_class\n class Item {}\n} except TypeError as e { write(e) }\n" +
    "write(\"after decorators\")\n"
  ), "ValueError: factory boom\nTypeError: class decorator boom\nafter decorators\n");
});
