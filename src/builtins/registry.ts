/**
 * builtins/registry.ts
 * ---------------------------------------------------------------------------
 * Registry for native (host-implemented) built-ins. Modules and globals call
 * registerBuiltinModule()/registerBuiltinGlobalFunction() at import time;
 * the VM then reads them via getBuiltinModule()/getBuiltinGlobals() when it
 * starts up or resolves an import.
 */

import type { NativeCallback, Value } from "../runtime/values.js";

/** Constants allowed as built-in values (JSON-like scalar types). */
export type BuiltinConstant = null | boolean | bigint | number | string;

/** A built-in module: name plus its native functions and constants. */
export interface BuiltinModuleDefinition {
  readonly name: string;
  readonly functions: Readonly<Record<string, NativeCallback>>;
  readonly values: Readonly<Record<string, Value>>;
}

// Native functions and initial values installed in THM's global scope.
export interface BuiltinGlobalDefinition {
  readonly functions: Readonly<Record<string, NativeCallback>>;
  readonly values: Readonly<Record<string, BuiltinConstant>>;
}

const modules = new Map<string, BuiltinModuleDefinition>();
const globalFunctions = new Map<string, NativeCallback>();
const globalValues = new Map<string, BuiltinConstant>();

// Validate that a name is a valid identifier.
function validateIdentifier(name: string, description: string): void {
  if (!/^[A-Za-z_]\w*$/.test(name)) {
    throw new Error(`Invalid ${description} '${name}'`);
  }
}

// Ensure a global name is not already registered.
function ensureGlobalNameAvailable(name: string): void {
  validateIdentifier(name, "built-in global name");
  if (globalFunctions.has(name) || globalValues.has(name)) {
    throw new Error(`Built-in global '${name}' is already registered`);
  }
}

// Register a native function callable by name in every THM program.
export function registerBuiltinGlobalFunction(name: string, callback: NativeCallback): void {
  ensureGlobalNameAvailable(name);
  globalFunctions.set(name, callback);
}

// Register an initial primitive value in every THM program's global scope.
export function registerBuiltinGlobalValue(name: string, value: BuiltinConstant): void {
  ensureGlobalNameAvailable(name);
  globalValues.set(name, value);
}

// Return a snapshot of registered globals for VM initialization.
export function getBuiltinGlobals(): BuiltinGlobalDefinition {
  return {
    functions: Object.fromEntries(globalFunctions),
    values: Object.fromEntries(globalValues),
  };
}

// Register one built-in module. Add the implementation under src/builtins/modules/
// and load it from index.ts.
export function registerBuiltinModule(
  name: string,
  members: {
    readonly functions?: Readonly<Record<string, NativeCallback>>;
    readonly values?: Readonly<Record<string, Value>>;
  },
): void {
  validateIdentifier(name, "built-in module name");
  if (modules.has(name)) throw new Error(`Built-in module '${name}' is already registered`);
  const functions = members.functions ?? {};
  const values = members.values ?? {};
  if (Object.keys(functions).length + Object.keys(values).length === 0) {
    throw new Error(`Built-in module '${name}' must export a member`);
  }
  const functionNames = Object.keys(functions);
  const valueNames = Object.keys(values);
  for (const memberName of [...functionNames, ...valueNames]) {
    validateIdentifier(memberName, `member name in built-in module '${name}'`);
  }
  const conflictingName = functionNames.find((memberName) => valueNames.includes(memberName));
  if (conflictingName !== undefined) {
    throw new Error(`Built-in module '${name}' defines '${conflictingName}' as both a function and a value`);
  }
  modules.set(name, { name, functions: { ...functions }, values: { ...values } });
}

// Look up a registered module when the VM handles an import statement.
export function getBuiltinModule(name: string): BuiltinModuleDefinition | undefined {
  return modules.get(name);
}
