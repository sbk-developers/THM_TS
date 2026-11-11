import { getPlatform, type Platform } from "../src/platform/platform.js";

type TestBody = () => void;
type TestCase = { name: string; body: TestBody };
type Failure = { name: string; detail: string };

const tests: TestCase[] = [];
const suiteNames: string[] = [];

export function describe(name: string, body: () => void): void {
  suiteNames.push(name);
  try {
    body();
  } finally {
    suiteNames.pop();
  }
}

export function test(name: string, body: TestBody): void {
  tests.push({ name: [...suiteNames, name].join(" > "), body });
}

export function assert(condition: unknown, message = "Assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

export function equal<T>(actual: T, expected: T, message?: string): void {
  if (!Object.is(actual, expected)) {
    throw new Error(message ?? `Expected ${format(expected)}, received ${format(actual)}`);
  }
}

export function deepEqual(actual: unknown, expected: unknown, message?: string): void {
  const pending: Array<[unknown, unknown]> = [[actual, expected]];
  const visited: Array<[object, object]> = [];
  while (pending.length > 0) {
    const pair = pending.pop();
    if (pair === undefined) break;
    const [left, right] = pair;
    if (Object.is(left, right)) continue;
    if (!isObject(left) || !isObject(right) || Array.isArray(left) !== Array.isArray(right)) {
      throw new Error(message ?? `Expected ${format(right)}, received ${format(left)}`);
    }
    if (visited.some(([a, b]) => a === left && b === right)) continue;
    visited.push([left, right]);
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    if (
      leftKeys.length !== rightKeys.length ||
      leftKeys.some((key, index) => key !== rightKeys[index])
    ) {
      throw new Error(message ?? `Expected ${format(right)}, received ${format(left)}`);
    }
    for (const key of leftKeys) pending.push([left[key], right[key]]);
  }
}

export function throws(body: TestBody, predicate?: (error: unknown) => boolean): unknown {
  try {
    body();
  } catch (error) {
    if (predicate !== undefined && !predicate(error)) {
      throw new Error(`Thrown value did not match expectation: ${format(error)}`);
    }
    return error;
  }
  throw new Error("Expected the function to throw");
}

export interface TestSummary {
  passed: number;
  failed: number;
  failures: Failure[];
}

export function runTests(platform: Platform = getPlatform()): TestSummary {
  let passed = 0;
  const failures: Failure[] = [];

  for (const current of tests) {
    try {
      current.body();
      passed++;
    } catch (error) {
      failures.push({ name: current.name, detail: format(error) });
      platform.stderr(`FAIL ${current.name}: ${format(error)}\n`);
    }
  }

  platform.stdout(`Tests: ${passed + failures.length}, passed: ${passed}, failed: ${failures.length}\n`);
  const summary = { passed, failed: failures.length, failures };
  if (failures.length > 0) platform.exit(1);
  return summary;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function format(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "undefined") return "undefined";
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
