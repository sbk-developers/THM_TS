import type { NativeCallback, Value } from "../runtime/values.js";

export type BuiltinConstant = null | boolean | bigint | number | string;

/** A registered built-in module, with native functions and constant/runtime values. */
export interface BuiltinModuleDefinition {
  readonly name: string;
  readonly functions: Readonly<Record<string, NativeCallback>>;
  readonly values: Readonly<Record<string, Value>>;
}

/** Native functions and initial values installed directly in THM's global scope. */
export interface BuiltinGlobalDefinition {
  readonly functions: Readonly<Record<string, NativeCallback>>;
  readonly values: Readonly<Record<string, BuiltinConstant>>;
}

const modules = new Map<string, BuiltinModuleDefinition>();
const globalFunctions = new Map<string, NativeCallback>();
const globalValues = new Map<string, BuiltinConstant>();

function validateIdentifier(name: string, description: string): void {
  if (!/^[A-Za-z_]\w*$/.test(name)) {
    throw new Error(`Invalid ${description} '${name}'`);
  }
}

function ensureGlobalNameAvailable(name: string): void {
  validateIdentifier(name, "built-in global name");
  if (globalFunctions.has(name) || globalValues.has(name)) {
    throw new Error(`Built-in global '${name}' is already registered`);
  }
}

/** Register a native function callable by its name in every THM program. */
export function registerBuiltinGlobalFunction(name: string, callback: NativeCallback): void {
  ensureGlobalNameAvailable(name);
  globalFunctions.set(name, callback);
}

/** Register an initial primitive value in every THM program's global scope. */
export function registerBuiltinGlobalValue(name: string, value: BuiltinConstant): void {
  ensureGlobalNameAvailable(name);
  globalValues.set(name, value);
}

/** Return a snapshot of the registered globals for VM initialization. */
export function getBuiltinGlobals(): BuiltinGlobalDefinition {
  return {
    functions: Object.fromEntries(globalFunctions),
    values: Object.fromEntries(globalValues),
  };
}

/**
 * Register one built-in module. Add the module's implementation in its own
 * file under `src/builtins/modules/`, then load that file from `index.ts`.
 */
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

/** Look up a registered module when the VM handles an import statement. */
export function getBuiltinModule(name: string): BuiltinModuleDefinition | undefined {
  return modules.get(name);
}
