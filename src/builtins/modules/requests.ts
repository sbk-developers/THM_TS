/**
 * builtins/modules/requests.ts
 * ---------------------------------------------------------------------------
 * `requests` built-in module: an HTTP-only `get()` implemented over the
 * system curl binary. Only http/https URLs are accepted; local filesystem
 * access via file:// is deliberately rejected.
 */

import { registerBuiltinModule } from "../registry.js";
import { ThmTypeError, ThmValueError } from "../../errors/errors.js";
import { makeDict, type DictEntry, type Value } from "../../runtime/values.js";
import { ManagedHeap } from "../../vm/memory.js";
import { execSync } from "node:child_process";

/** Shell-escape a value for safe single-quoted use in a command line. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

interface GetResult {
  status: number | null;
  text: string;
}

/** Run curl for an http/https URL and capture status + body. */
function httpGet(url: string): GetResult {
  if (!/^https?:\/\//i.test(url)) {
    throw new ThmValueError(`req.get() only supports http and https URLs, got '${url}'`);
  }
  const command = `curl -s -i -L --max-time 30 ${shellQuote(url)}`;
  let output: string;
  try {
    output = execSync(command, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ThmValueError(`req.get() request failed: ${detail}`);
  }
  let status: number | null = null;
  let body: string;
  const lastSeparator = output.lastIndexOf("\r\n\r\n");
  if (lastSeparator !== -1) {
    const headerBlock = output.slice(0, lastSeparator);
    body = output.slice(lastSeparator + 4);
    const matches = [...headerBlock.matchAll(/HTTP\/\d(?:\.\d)?\s+(\d{3})/g)];
    const last = matches[matches.length - 1];
    status = last ? parseInt(last[1]!, 10) : null;
  } else {
    body = output;
  }
  return { status, text: body };
}

// Convert a GetResult into a THM dict value.
function resToValue(heap: ManagedHeap, res: GetResult): Value {
  const entries: DictEntry[] = [
    { key: "text", value: res.text, hash: `string:text` },
    { key: "status", value: BigInt(res.status ?? 0), hash: `string:status` },
  ];
  return makeDict(heap, entries);
}

registerBuiltinModule("req", {
  functions: {
    get: (_vm, _receiver, args) => {
      if (args.length !== 1 || typeof args[0] !== "string") {
        throw new ThmTypeError("get() expects exactly one string argument");
      }
      const result = httpGet(args[0]!);
      return resToValue(_vm.heap, result);
    },
  },
});
