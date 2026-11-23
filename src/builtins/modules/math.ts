/**
 * builtins/modules/math.ts
 * ---------------------------------------------------------------------------
 * `math` built-in module: constants (pi, e, tau) and functions (sqrt,
 * floor, ceil, sin, cos, ...).
 */

import { ThmTypeError, ThmValueError } from "../../errors/errors.js";
import type { NativeCallback, Value } from "../../runtime/values.js";
import { registerBuiltinModule } from "../registry.js";

/** Coerce a value to a JS number; TypeError if not numeric. */
function toNumber(value: Value, functionName: string): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  throw new ThmTypeError(`${functionName}() argument must be a real number`);
}

/** Build a one-argument math function with an optional domain validator. */
function unaryMath(
  functionName: string,
  operation: (value: number) => number,
  validate?: (value: number) => void,
): NativeCallback {
  return (_vm, _receiver, args) => {
    if (args.length !== 1) {
      throw new ThmTypeError(`${functionName}() takes exactly one argument`);
    }
    const value = toNumber(args[0]!, functionName);
    validate?.(value);
    return operation(value);
  };
}

registerBuiltinModule("math", {
  values: {
    pi: Math.PI,
    e: Math.E,
    tau: Math.PI * 2,
  },
  functions: {
    sqrt: unaryMath("sqrt", Math.sqrt, (value) => {
      if (value < 0) throw new ThmValueError("math domain error");
    }),
    floor: unaryMath("floor", Math.floor),
    ceil: unaryMath("ceil", Math.ceil),
    sin: unaryMath("sin", Math.sin),
    cos: unaryMath("cos", Math.cos),
  },
});
