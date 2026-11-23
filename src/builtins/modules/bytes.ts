/**
 * builtins/modules/bytes.ts
 * ---------------------------------------------------------------------------
 * `bytes` built-in module: construction, length, indexing, slicing,
 * encode/decode, and hex conversion for bytes values.
 */

import { ThmTypeError, ThmValueError, ThmIndexError } from "../../errors/errors.js";
import type { NativeCallback, Value } from "../../runtime/values.js";
import { makeBytes } from "../../runtime/values.js";
import { registerBuiltinModule } from "../registry.js";

/** bytes(x): accepts bytes (identity), str (UTF-8) or iterable of ints. */
const bytesFromIterable: NativeCallback = (vm, _receiver, args) => {
  if (args.length !== 1) throw new ThmTypeError("bytes() takes exactly one argument");
  const value = args[0]!;
  if (typeof value === "object" && value !== null && value.kind === "bytes") return value;
  if (typeof value === "string") return makeBytes(vm.heap, new TextEncoder().encode(value));
  const isIterable =
    typeof value === "object" && value !== null &&
    (value.kind === "list" || value.kind === "tuple" || value.kind === "range");
  if (isIterable) {
    const items = vm.iterateAll(value);
    const bytes: number[] = [];
    for (const item of items) {
      if (typeof item !== "number" && typeof item !== "bigint") {
        throw new ThmTypeError("bytes() argument must be an iterable of integers");
      }
      const intVal = typeof item === "bigint" ? Number(item) : item;
      if (!Number.isSafeInteger(intVal)) throw new ThmTypeError("bytes() argument must be an iterable of integers");
      if (intVal < 0 || intVal > 255) throw new ThmValueError("bytes() argument must be in range(0, 256)");
      bytes.push(intVal);
    }
    return makeBytes(vm.heap, new Uint8Array(bytes));
  }
  throw new ThmTypeError("bytes() argument must be bytes, string, or iterable of integers");
};

// Return the length of a bytes value.
const len: NativeCallback = (_vm, _receiver, args) => {
  if (args.length !== 1) throw new ThmTypeError("len() takes exactly one argument");
  const value = args[0]!;
  if (typeof value === "object" && value !== null && value.kind === "bytes") return BigInt(value.data.length);
  throw new ThmTypeError("len() argument must be bytes");
};

// Get a byte by index.
const getitem: NativeCallback = (_vm, _receiver, args) => {
  if (args.length !== 2) throw new ThmTypeError("getitem() takes exactly two arguments");
  const bytesVal = args[0]!;
  const index = args[1]!;
  if (!(typeof bytesVal === "object" && bytesVal !== null && bytesVal.kind === "bytes")) throw new ThmTypeError("getitem() first argument must be bytes");
  if (typeof index !== "bigint" && typeof index !== "number") throw new ThmTypeError("getitem() second argument must be an integer");
  const idx = typeof index === "bigint" ? Number(index) : index;
  if (idx < 0 || idx >= bytesVal.data.length) throw new ThmIndexError("bytes index out of range");
  return BigInt(bytesVal.data[idx]);
};

// Slice bytes with start, stop, step.
const slice: NativeCallback = (_vm, _receiver, args) => {
  if (args.length !== 4) throw new ThmTypeError("slice() takes exactly four arguments");
  const bytesVal = args[0]!;
  const start = args[1]!;
  const stop = args[2]!;
  const step = args[3]!;
  if (!(typeof bytesVal === "object" && bytesVal !== null && bytesVal.kind === "bytes")) throw new ThmTypeError("slice() first argument must be bytes");
  const startVal = start === null ? 0 : (typeof start === "bigint" ? Number(start) : start as number);
  const stopVal = stop === null ? bytesVal.data.length : (typeof stop === "bigint" ? Number(stop) : stop as number);
  const stepVal = step === null ? 1 : (typeof step === "bigint" ? Number(step) : step as number);
  const result: number[] = [];
  for (let i = startVal; i < stopVal; i += stepVal) {
    if (i >= 0 && i < bytesVal.data.length) result.push(bytesVal.data[i]);
  }
  return makeBytes(_vm.heap, new Uint8Array(result));
};

// Decode bytes to string.
const decode: NativeCallback = (_vm, _receiver, args) => {
  if (args.length < 1 || args.length > 2) throw new ThmTypeError("decode() takes one or two arguments");
  const bytesVal = args[0]!;
  const encoding = args[1] ?? "utf-8";
  if (!(typeof bytesVal === "object" && bytesVal !== null && bytesVal.kind === "bytes")) throw new ThmTypeError("decode() first argument must be bytes");
  if (typeof encoding !== "string") throw new ThmTypeError("decode() second argument must be a string");
  const decoder = new TextDecoder(encoding);
  return decoder.decode(bytesVal.data);
};

// Encode string to bytes.
const encode: NativeCallback = (_vm, _receiver, args) => {
  if (args.length < 1 || args.length > 2) throw new ThmTypeError("encode() takes one or two arguments");
  const str = args[0]!;
  const encoding = args[1] ?? "utf-8";
  if (typeof str !== "string") throw new ThmTypeError("encode() first argument must be a string");
  if (typeof encoding !== "string") throw new ThmTypeError("encode() second argument must be a string");
  const encoder = new TextEncoder();
  return makeBytes(_vm.heap, encoder.encode(str));
};

// Return hex representation of bytes.
const hex: NativeCallback = (_vm, _receiver, args) => {
  if (args.length !== 1) throw new ThmTypeError("hex() takes exactly one argument");
  const bytesVal = args[0]!;
  if (!(typeof bytesVal === "object" && bytesVal !== null && bytesVal.kind === "bytes")) throw new ThmTypeError("hex() argument must be bytes");
  const hexChars = "0123456789abcdef";
  let result = "";
  for (let i = 0; i < bytesVal.data.length; i++) {
    const b = bytesVal.data[i];
    result += hexChars[b >> 4] + hexChars[b & 0xf];
  }
  return result;
};

// Construct bytes from a hex string.
const fromhex: NativeCallback = (_vm, _receiver, args) => {
  if (args.length !== 1) throw new ThmTypeError("fromhex() takes exactly one argument");
  const str = args[0]!;
  if (typeof str !== "string") throw new ThmTypeError("fromhex() argument must be a string");
  const hexStr = str.replace(/\s/g, "");
  if (hexStr.length % 2 !== 0) throw new ThmValueError("fromhex() string must have even length");
  const bytes: number[] = [];
  for (let i = 0; i < hexStr.length; i += 2) {
    const byte = parseInt(hexStr.slice(i, i + 2), 16);
    if (isNaN(byte)) throw new ThmValueError("fromhex() string must contain only hex digits");
    bytes.push(byte);
  }
  return makeBytes(_vm.heap, new Uint8Array(bytes));
};

registerBuiltinModule("bytes", {
  functions: {
    bytes: bytesFromIterable,
    len,
    getitem,
    slice,
    decode,
    encode,
    hex,
    fromhex,
  },
});
