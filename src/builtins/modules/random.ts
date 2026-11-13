import { ThmIndexError, ThmTypeError, ThmValueError } from "../../errors/errors.js";
import { makeList, makeNone } from "../../runtime/values.js";
import type { NativeCallback, Value } from "../../runtime/values.js";
import { registerBuiltinModule } from "../registry.js";

/**
 * Seedable generator (mulberry32). `Math.random` cannot be seeded, and
 * `random.seed(x)` must make later results reproducible.
 */
let state = 0;

function seedFrom(value: Value): number {
  if (typeof value === "object" && value !== null && "kind" in value && value.kind === "none") return initialSeed();
  let text: string;
  if (typeof value === "string") text = value;
  else if (typeof value === "bigint" || typeof value === "number" || typeof value === "boolean") text = String(value);
  else throw new ThmTypeError("seed() argument must be none, int, float, bool or str");
  // FNV-1a hash so that any value (including big ints and strings) folds to 32 bits.
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function initialSeed(): number {
  return (Math.floor(Math.random() * 0x100000000) ^ (Date.now() & 0xffffffff)) >>> 0;
}

state = initialSeed();

function nextUint32(): number {
  state = (state + 0x6d2b79f5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return (t ^ (t >>> 14)) >>> 0;
}

/** A float in [0, 1) with 53 bits of randomness. */
function nextFloat(): number {
  const high = nextUint32() >>> 5;
  const low = nextUint32() >>> 6;
  return (high * 67108864 + low) / 9007199254740992;
}

/** An integer in [0, bound) for bound up to 2**53. */
function below(bound: number): number {
  return Math.floor(nextFloat() * bound);
}

function toInteger(value: Value, functionName: string): number {
  let result: number;
  if (typeof value === "bigint") result = Number(value);
  else if (typeof value === "boolean") result = value ? 1 : 0;
  else if (typeof value === "number" && Number.isInteger(value)) result = value;
  else throw new ThmTypeError(`${functionName}() arguments must be integers`);
  if (!Number.isSafeInteger(result)) throw new ThmValueError(`${functionName}() argument is too large`);
  return result;
}

function toReal(value: Value, functionName: string): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "boolean") return value ? 1 : 0;
  throw new ThmTypeError(`${functionName}() arguments must be real numbers`);
}

function expectArguments(args: Value[], functionName: string, low: number, high: number): void {
  if (args.length < low || args.length > high) {
    throw new ThmTypeError(
      `${functionName}() takes ${low === high ? `exactly ${low}` : `${low} to ${high}`} argument(s)`,
    );
  }
}

const seed: NativeCallback = (vm, _receiver, args) => {
  expectArguments(args, "seed", 0, 1);
  state = args.length === 0 ? initialSeed() : seedFrom(args[0]!);
  return makeNone(vm.heap);
};

const random: NativeCallback = (_vm, _receiver, args) => {
  expectArguments(args, "random", 0, 0);
  return nextFloat();
};

const randint: NativeCallback = (_vm, _receiver, args) => {
  expectArguments(args, "randint", 2, 2);
  const low = toInteger(args[0]!, "randint");
  const high = toInteger(args[1]!, "randint");
  if (low > high) throw new ThmValueError(`empty range in randint(${low}, ${high})`);
  return BigInt(low + below(high - low + 1));
};

const randrange: NativeCallback = (_vm, _receiver, args) => {
  expectArguments(args, "randrange", 1, 3);
  const start = args.length === 1 ? 0 : toInteger(args[0]!, "randrange");
  const stop = args.length === 1 ? toInteger(args[0]!, "randrange") : toInteger(args[1]!, "randrange");
  const step = args.length === 3 ? toInteger(args[2]!, "randrange") : 1;
  if (step === 0) throw new ThmValueError("randrange() step argument must not be zero");
  const count = step > 0 ? Math.ceil((stop - start) / step) : Math.ceil((start - stop) / -step);
  if (count <= 0) throw new ThmValueError("empty range in randrange()");
  return BigInt(start + step * below(count));
};

const uniform: NativeCallback = (_vm, _receiver, args) => {
  expectArguments(args, "uniform", 2, 2);
  const low = toReal(args[0]!, "uniform");
  const high = toReal(args[1]!, "uniform");
  return low + (high - low) * nextFloat();
};

const gauss: NativeCallback = (_vm, _receiver, args) => {
  expectArguments(args, "gauss", 0, 2);
  const mu = args.length > 0 ? toReal(args[0]!, "gauss") : 0;
  const sigma = args.length > 1 ? toReal(args[1]!, "gauss") : 1;
  // Box-Muller transform; 1 - random() keeps the logarithm argument above zero.
  const u = 1 - nextFloat();
  const v = nextFloat();
  return mu + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

const getrandbits: NativeCallback = (_vm, _receiver, args) => {
  expectArguments(args, "getrandbits", 1, 1);
  const bits = toInteger(args[0]!, "getrandbits");
  if (bits < 0) throw new ThmValueError("number of bits must be non-negative");
  let result = BigInt(0);
  for (let done = 0; done < bits; done += 32) {
    const chunk = Math.min(32, bits - done);
    result = (result << BigInt(chunk)) | BigInt(nextUint32() >>> (32 - chunk));
  }
  return result;
};

function sequenceItems(vm: Parameters<NativeCallback>[0], value: Value, functionName: string): Value[] {
  const isSequence =
    typeof value === "string" ||
    (typeof value === "object" && value !== null &&
      (value.kind === "list" || value.kind === "tuple" || value.kind === "range"));
  if (!isSequence) throw new ThmTypeError(`${functionName}() argument must be a sequence`);
  return vm.iterateAll(value);
}

const choice: NativeCallback = (vm, _receiver, args) => {
  expectArguments(args, "choice", 1, 1);
  const items = sequenceItems(vm, args[0]!, "choice");
  if (items.length === 0) throw new ThmIndexError("cannot choose from an empty sequence");
  return items[below(items.length)]!;
};

const shuffle: NativeCallback = (vm, _receiver, args) => {
  expectArguments(args, "shuffle", 1, 1);
  const target = args[0]!;
  if (typeof target !== "object" || target === null || target.kind !== "list") {
    throw new ThmTypeError("shuffle() argument must be a list");
  }
  const items = target.items;
  for (let index = items.length - 1; index > 0; index--) {
    const other = below(index + 1);
    const held = items[index]!;
    items[index] = items[other]!;
    items[other] = held;
  }
  return makeNone(vm.heap);
};

const sample: NativeCallback = (vm, _receiver, args) => {
  expectArguments(args, "sample", 2, 2);
  const items = [...sequenceItems(vm, args[0]!, "sample")];
  const count = toInteger(args[1]!, "sample");
  if (count < 0 || count > items.length) throw new ThmValueError("sample larger than population or is negative");
  for (let index = 0; index < count; index++) {
    const other = index + below(items.length - index);
    const held = items[index]!;
    items[index] = items[other]!;
    items[other] = held;
  }
  return makeList(vm.heap, items.slice(0, count));
};

const choices: NativeCallback = (vm, _receiver, args) => {
  expectArguments(args, "choices", 1, 2);
  const items = sequenceItems(vm, args[0]!, "choices");
  const count = args.length === 2 ? toInteger(args[1]!, "choices") : 1;
  if (items.length === 0) throw new ThmIndexError("cannot choose from an empty sequence");
  if (count < 0) throw new ThmValueError("choices() count must be non-negative");
  const picked: Value[] = [];
  for (let index = 0; index < count; index++) picked.push(items[below(items.length)]!);
  return makeList(vm.heap, picked);
};

registerBuiltinModule("random", {
  functions: { seed, random, randint, randrange, uniform, gauss, getrandbits, choice, choices, shuffle, sample },
});

