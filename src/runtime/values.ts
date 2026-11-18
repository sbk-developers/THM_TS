import type { Chunk } from "../compiler/bytecode/bytecode.js";
import { ManagedHeap, ManagedObject } from "../vm/memory.js";
import type { VM } from "../vm/vm.js";

export interface Cell {
  bound: boolean;
  value: Value | null;
}

export class Environment extends ManagedObject {
  readonly cells = new Map<string, Cell>();
  module: ModuleValue | null = null;

  private constructor(
    heapId: number,
    public parent: Environment | null,
    readonly isGlobal: boolean,
  ) {
    super(heapId);
  }

  static create(heap: ManagedHeap, parent: Environment | null, isGlobal: boolean): Environment {
    return heap.allocate((heapId) => new Environment(heapId, parent, isGlobal));
  }

  declare(name: string): Cell {
    let cell = this.cells.get(name);
    if (cell === undefined) {
      cell = { bound: false, value: null };
      this.cells.set(name, cell);
    }
    return cell;
  }

  set(name: string, value: Value): void {
    const cell = this.declare(name);
    cell.value = value;
    cell.bound = true;
  }

  references(): ManagedObject[] {
    const refs: ManagedObject[] = [];
    for (const cell of this.cells.values()) {
      if (cell.bound && cell.value !== null) refs.push(...managedReferences([cell.value]));
    }
    if (this.parent !== null) refs.push(this.parent);
    if (this.module !== null) refs.push(this.module);
    return refs;
  }

  clearReferences(): void {
    for (const cell of this.cells.values()) {
      cell.bound = false;
      cell.value = null;
    }
    this.cells.clear();
    this.parent = null;
    this.module = null;
  }
}

export class ListValue extends ManagedObject {
  readonly kind = "list";

  constructor(heapId: number, public items: Value[]) {
    super(heapId);
  }

  references(): ManagedObject[] {
    return managedReferences(this.items);
  }

  clearReferences(): void {
    this.items.length = 0;
  }
}

export class TupleValue extends ManagedObject {
  readonly kind = "tuple";

  constructor(heapId: number, public items: Value[]) {
    super(heapId);
  }

  references(): ManagedObject[] {
    return managedReferences(this.items);
  }

  clearReferences(): void {
    this.items.length = 0;
  }
}

export interface DictEntry {
  key: Value;
  value: Value;
  hash: string;
}

export class DictValue extends ManagedObject {
  readonly kind = "dict";

  constructor(heapId: number, public entries: DictEntry[]) {
    super(heapId);
  }

  references(): ManagedObject[] {
    const values: Value[] = [];
    for (const entry of this.entries) values.push(entry.key, entry.value);
    return managedReferences(values);
  }

  clearReferences(): void {
    this.entries.length = 0;
  }
}

export class SetValue extends ManagedObject {
  readonly kind = "set";

  constructor(heapId: number, public items: Value[]) {
    super(heapId);
  }

  references(): ManagedObject[] {
    return managedReferences(this.items);
  }

  clearReferences(): void {
    this.items.length = 0;
  }
}

export class BytesValue extends ManagedObject {
  readonly kind = "bytes";

  constructor(heapId: number, public data: Uint8Array) {
    super(heapId);
  }

  references(): ManagedObject[] {
    return [];
  }

  clearReferences(): void {
    this.data = new Uint8Array(0);
  }
}

export class NoneValue extends ManagedObject {
  readonly kind = "none";

  constructor(heapId: number) {
    super(heapId);
  }

  references(): ManagedObject[] {
    return [];
  }

  clearReferences(): void {}
}

export class FunctionValue extends ManagedObject {
  readonly kind = "function";
  readonly genericParameters: string[];

  constructor(
    heapId: number,
    readonly name: string,
    readonly chunk: Chunk,
    public closure: Environment | null,
    readonly parameterSpecs: FunctionParameterSpec[],
    public defaults: Value[],
    readonly isAsync = false,
    readonly isGenerator = false,
  ) {
    super(heapId);
    this.genericParameters = [...chunk.genericParameters];
  }

  references(): ManagedObject[] {
    return [
      ...(this.closure === null ? [] : [this.closure]),
      ...managedReferences(this.defaults),
    ];
  }

  clearReferences(): void {
    this.closure = null;
    this.defaults.length = 0;
  }
}

export interface FunctionParameterSpec {
  name: string;
  kind: "positional" | "vararg" | "keywordOnly" | "kwarg";
  hasDefault: boolean;
}

export type NativeCallback = (
  vm: VM,
  receiver: Value | undefined,
  args: Value[],
  keywords?: ReadonlyMap<string, Value>,
) => Value;

export class NativeValue extends ManagedObject {
  readonly kind = "native";

  constructor(
    heapId: number,
    readonly name: string,
    readonly callback: NativeCallback,
    public captures: Value[],
    readonly acceptsKeywords = false,
  ) {
    super(heapId);
  }

  references(): ManagedObject[] {
    return managedReferences(this.captures);
  }

  clearReferences(): void {
    this.captures.length = 0;
  }
}

export class ModuleValue extends ManagedObject {
  readonly kind = "module";

  constructor(
    heapId: number,
    readonly name: string,
    readonly environment: Environment,
    readonly isPackage: boolean,
    readonly packageName: string,
  ) {
    super(heapId);
  }

  references(): ManagedObject[] {
    return [this.environment];
  }

  clearReferences(): void {}
}

export class RangeValue extends ManagedObject {
  readonly kind = "range";
  readonly length: number;

  constructor(heapId: number, readonly start: number, readonly stop: number, readonly step: number) {
    super(heapId);
    this.length = step > 0
      ? Math.max(0, Math.ceil((stop - start) / step))
      : Math.max(0, Math.ceil((start - stop) / -step));
  }

  references(): ManagedObject[] {
    return [];
  }

  clearReferences(): void {}
}


export class ClassValue extends ManagedObject {
  readonly kind = "class";

  constructor(
    heapId: number,
    readonly name: string,
    readonly environment: Environment,
    public bases: ClassValue[],
    public mro: ClassValue[],
    public metaclass: ClassValue | TypeValue | null = null,
    public isMetaclass = false,
    readonly genericParameters: string[] = [],
  ) { super(heapId); }

  references(): ManagedObject[] {
    return [
      this.environment,
      ...this.bases,
      ...this.mro,
      ...managedReferences(this.metaclass === null ? [] : [this.metaclass]),
    ];
  }
  clearReferences(): void { this.bases = []; this.mro = []; this.metaclass = null; }
}

export type DescriptorKind = "staticmethod" | "classmethod" | "property";

export class DescriptorValue extends ManagedObject {
  readonly kind = "descriptor";

  constructor(
    heapId: number,
    readonly descriptorKind: DescriptorKind,
    public value: Value | null = null,
    public setter: Value | null = null,
    public deleter: Value | null = null,
  ) { super(heapId); }

  references(): ManagedObject[] {
    return managedReferences([this.value, this.setter, this.deleter].filter((v): v is Value => v !== null));
  }

  clearReferences(): void {
    this.value = null;
    this.setter = null;
    this.deleter = null;
  }
}

export class InstanceValue extends ManagedObject {
  readonly kind = "instance";
  readonly fields = new Map<string, Value>();

  constructor(heapId: number, public klass: ClassValue) { super(heapId); }
  references(): ManagedObject[] { return [this.klass, ...managedReferences([...this.fields.values()])]; }
  clearReferences(): void { this.fields.clear(); }
}


export class SuperValue extends ManagedObject {
  readonly kind = "super";
  constructor(
    heapId: number,
    public instance: InstanceValue | ClassValue | null,
    public startClass: ClassValue | null,
  ) { super(heapId); }
  references(): ManagedObject[] {
    const refs: ManagedObject[] = [];
    if (this.instance !== null) refs.push(this.instance);
    if (this.startClass !== null) refs.push(this.startClass);
    return refs;
  }
  clearReferences(): void { this.instance = null; this.startClass = null; }
}

export class TypeValue extends ManagedObject {
  readonly kind = "type";

  constructor(heapId: number, readonly name: string) {
    super(heapId);
  }

  references(): ManagedObject[] {
    return [];
  }

  clearReferences(): void {}
}

export class ExceptionValue extends ManagedObject {
  readonly kind = "exception";

  constructor(
    heapId: number,
    readonly exceptionType: string,
    readonly message: string,
  ) { super(heapId); }

  references(): ManagedObject[] { return []; }
  clearReferences(): void {}
}

export class CoroutineValue extends ManagedObject {
  readonly kind = "coroutine";
  public done = false;
  public result: Value | null = null;
  public error: unknown = undefined;
  public started = false;

  constructor(
    heapId: number,
    readonly name: string,
    readonly fn: FunctionValue,
    readonly args: Value[],
    readonly keywords: ReadonlyMap<string, Value>,
  ) {
    super(heapId);
  }

  references(): ManagedObject[] {
    const refs: ManagedObject[] = [this.fn];
    refs.push(...managedReferences(this.args));
    refs.push(...managedReferences([...this.keywords.values()]));
    if (this.done && this.error === undefined && this.result !== null) refs.push(...managedReferences([this.result]));
    return refs;
  }

  clearReferences(): void {
    this.args.length = 0;
    this.result = null;
    this.error = undefined;
  }
}

export class GeneratorValue extends ManagedObject {
  readonly kind = "generator";
  public done = false;
  public started = false;
  public result: Value | null = null;
  public error: unknown = undefined;
  public pendingValue: Value | undefined = undefined;
  public frame: any = null;
  public fn: FunctionValue;
  public args: Value[];
  public keywords: ReadonlyMap<string, Value>;

  constructor(
    heapId: number,
    readonly name: string,
    fn: FunctionValue | null = null,
    args: Value[] = [],
    keywords: ReadonlyMap<string, Value> = new Map(),
  ) {
    super(heapId);
    this.fn = fn as FunctionValue;
    this.args = args;
    this.keywords = keywords;
  }

  references(): ManagedObject[] {
    const refs: ManagedObject[] = [];
    if (this.frame) {
      refs.push(this.frame.environment);
      if (this.frame.module) refs.push(this.frame.module);
      if (this.frame.currentException) refs.push(this.frame.currentException);
    }
    if (this.fn) refs.push(this.fn);
    refs.push(...managedReferences(this.args));
    refs.push(...managedReferences([...this.keywords.values()]));
    if (this.result !== null) refs.push(...managedReferences([this.result]));
    return refs;
  }

  clearReferences(): void {
    this.frame = null;
    this.args.length = 0;
    this.result = null;
    this.error = undefined;
  }
}


export type IteratorState =
  | { kind: "sequence"; source: ListValue | TupleValue; index: number; step: 1 | -1 }
  | { kind: "string"; source: string; index: number; step: 1 | -1 }
  | { kind: "range"; source: RangeValue; index: number }
  | { kind: "dict"; source: DictValue; index: number; size: number; mode: "keys" | "values" | "items" }
  | { kind: "set"; source: SetValue; index: number; size: number }
  | { kind: "enumerate"; source: IteratorValue; index: number }
  | { kind: "zip"; sources: IteratorValue[] }
  | { kind: "map"; sources: IteratorValue[]; callback: Value }
  | { kind: "filter"; source: IteratorValue; callback: Value | null }
  | { kind: "reverse-sequence"; source: ListValue | TupleValue; index: number }
  | { kind: "reverse-string"; source: string; index: number }
  | { kind: "generator"; source: GeneratorValue };

export class IteratorValue extends ManagedObject {
  readonly kind = "iterator";

  constructor(heapId: number, public state: IteratorState | null) {
    super(heapId);
  }

  references(): ManagedObject[] {
    return this.state === null ? [] : iteratorReferences(this.state);
  }

  clearReferences(): void {
    this.state = null;
  }
}

export type Value =
  | boolean
  | bigint
  | number
  | string
  | ListValue
  | TupleValue
  | DictValue
  | SetValue
  | BytesValue
  | FunctionValue
  | NativeValue
  | ModuleValue
  | RangeValue
  | TypeValue
  | ClassValue
  | DescriptorValue
  | InstanceValue
  | SuperValue
  | ExceptionValue
  | IteratorValue
  | GeneratorValue
  | CoroutineValue
  | NoneValue;

type ObjectValue = Exclude<Value, boolean | bigint | number | string>;

export function isKind<K extends ObjectValue["kind"]>(
  value: Value,
  kind: K,
): value is Extract<ObjectValue, { kind: K }> {
  return typeof value === "object" && value !== null && value.kind === kind;
}

export function managedReferences(values: Value[]): ManagedObject[] {
  const refs: ManagedObject[] = [];
  for (const value of values) {
    if (value === null || typeof value !== "object") continue;
    if (value.kind === "list") refs.push(value);
    else if (value.kind === "tuple") refs.push(value);
    else if (value.kind === "dict") refs.push(value);
    else if (value.kind === "set") refs.push(value);
    else if (value.kind === "bytes") { /* no managed refs */ }
    else if (value.kind === "function") refs.push(value);
    else if (value.kind === "native") refs.push(value);
    else if (value.kind === "module") refs.push(value);
    else if (value.kind === "range") refs.push(value);
    else if (value.kind === "type") refs.push(value);
    else if (value.kind === "class") refs.push(value);
    else if (value.kind === "descriptor") refs.push(value);
    else if (value.kind === "instance") refs.push(value);
    else if (value.kind === "super") refs.push(value);
    else if (value.kind === "exception") refs.push(value);
    else if (value.kind === "iterator") refs.push(value);
    else if (value.kind === "generator") refs.push(value);
    else if (value.kind === "coroutine") refs.push(value);
  }
  return refs;
}

export function makeList(heap: ManagedHeap, items: Value[] = []): ListValue {
  return heap.allocate((heapId) => new ListValue(heapId, items));
}

export function makeTuple(heap: ManagedHeap, items: Value[] = []): TupleValue {
  return heap.allocate((heapId) => new TupleValue(heapId, items));
}

export function makeDict(heap: ManagedHeap, entries: DictEntry[] = []): DictValue {
  return heap.allocate((heapId) => new DictValue(heapId, entries));
}

export function makeSet(heap: ManagedHeap, items: Value[] = []): SetValue {
  return heap.allocate((heapId) => new SetValue(heapId, items));
}

export function makeBytes(heap: ManagedHeap, data: Uint8Array): BytesValue {
  return heap.allocate((heapId) => new BytesValue(heapId, data));
}

export function makeNone(heap: ManagedHeap): NoneValue {
  return heap.allocate((heapId) => new NoneValue(heapId));
}

export function makeFunction(
  heap: ManagedHeap,
  name: string,
  chunk: Chunk,
  closure: Environment,
  parameterSpecs: FunctionParameterSpec[],
  defaults: Value[],
  isAsync = false,
  isGenerator = false,
): FunctionValue {
  return heap.allocate((heapId) => new FunctionValue(heapId, name, chunk, closure, parameterSpecs, defaults, isAsync, isGenerator));
}

export function makeGenerator(heap: ManagedHeap, name: string, fn: FunctionValue, args: Value[], keywords: ReadonlyMap<string, Value>): GeneratorValue {
  return heap.allocate((heapId) => new GeneratorValue(heapId, name, fn, args, keywords));
}

export function makeNative(
  heap: ManagedHeap,
  name: string,
  callback: NativeCallback,
  captures: Value[] = [],
  acceptsKeywords = false,
): NativeValue {
  return heap.allocate((heapId) => new NativeValue(heapId, name, callback, captures, acceptsKeywords));
}

export function makeRange(heap: ManagedHeap, start: number, stop: number, step: number): RangeValue {
  return heap.allocate((heapId) => new RangeValue(heapId, start, stop, step));
}

export function makeType(heap: ManagedHeap, name: string): TypeValue {
  return heap.allocate((heapId) => new TypeValue(heapId, name));
}

export function makeException(heap: ManagedHeap, exceptionType: string, message: string): ExceptionValue {
  return heap.allocate((heapId) => new ExceptionValue(heapId, exceptionType, message));
}

export function makeClass(
  heap: ManagedHeap,
  name: string,
  environment: Environment,
  bases: ClassValue[],
  metaclass: ClassValue | TypeValue | null = null,
  isMetaclass = false,
  genericParameters: string[] = [],
): ClassValue {
  const klass = heap.allocate((heapId) =>
    new ClassValue(heapId, name, environment, bases, [], metaclass, isMetaclass, genericParameters),
  );
  klass.mro = computeMro(klass);
  return klass;
}

export function makeDescriptor(
  heap: ManagedHeap,
  descriptorKind: DescriptorKind,
  value: Value,
  setter: Value | null = null,
  deleter: Value | null = null,
): DescriptorValue {
  return heap.allocate((heapId) =>
    new DescriptorValue(heapId, descriptorKind, value, setter, deleter),
  );
}

function computeMro(klass: ClassValue): ClassValue[] {
  const sequences = klass.bases.map((base) => [...base.mro]);
  sequences.push([...klass.bases]);
  const result: ClassValue[] = [klass];
  while (sequences.some((sequence) => sequence.length > 0)) {
    let candidate: ClassValue | undefined;
    for (const sequence of sequences) {
      const head = sequence[0];
      if (head !== undefined && !sequences.some((other) => other.slice(1).includes(head))) {
        candidate = head;
        break;
      }
    }
    if (candidate === undefined) throw new Error("Cannot create a consistent method resolution order (MRO)");
    result.push(candidate);
    for (const sequence of sequences) if (sequence[0] === candidate) sequence.shift();
  }
  return result;
}

export function makeInstance(heap: ManagedHeap, klass: ClassValue): InstanceValue {
  return heap.allocate((heapId) => new InstanceValue(heapId, klass));
}

export function makeSuper(
  heap: ManagedHeap,
  instance: InstanceValue | ClassValue,
  startClass: ClassValue,
): SuperValue {
  return heap.allocate((heapId) => new SuperValue(heapId, instance, startClass));
}

export function makeIterator(heap: ManagedHeap, state: IteratorState): IteratorValue {
  return heap.allocate((heapId) => new IteratorValue(heapId, state));
}

export function makeCoroutine(
  heap: ManagedHeap,
  name: string,
  fn: FunctionValue,
  args: Value[],
  keywords: ReadonlyMap<string, Value>,
): CoroutineValue {
  return heap.allocate((heapId) => new CoroutineValue(heapId, name, fn, args, keywords));
}

function iteratorReferences(state: IteratorState): ManagedObject[] {
  switch (state.kind) {
    case "sequence":
    case "dict":
    case "set":
    case "range":
    case "reverse-sequence":
      return [state.source];
    case "string":
    case "reverse-string":
      return [];
    case "enumerate":
      return [state.source];
    case "zip":
      return state.sources;
    case "map":
      return [...state.sources, ...managedReferences([state.callback])];
    case "filter":
      return state.callback === null
        ? [state.source]
        : [state.source, ...managedReferences([state.callback])];
    case "generator":
      return [state.source];
  }
  throw new Error("Unknown iterator state");
}
