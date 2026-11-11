import { registerBuiltinModule } from "../registry";
import { ThmTypeError } from "../../errors/errors.js";
import { makeDict, type DictEntry, type Value } from "../../runtime/values.js";
import { ManagedHeap } from "../../vm/memory.js";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** Escape a value for safe single-quoted shell usage. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

interface GetResult {
  status: number | null;
  text: string;
}

function httpGet(url: string): GetResult {
  // -s: silent, -i: include response headers, -L: follow redirects,
  // --max-time: bound the request so a hung server cannot hang the VM.
  const command = `curl -s -i -L --max-time 30 ${shellQuote(url)}`;
  const output = execSync(command, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const separator = output.indexOf("\r\n\r\n");
  let status: number | null = null;
  let body: string;
  if (separator !== -1) {
    const headerBlock = output.slice(0, separator);
    body = output.slice(separator + 4);
    const statusLine = headerBlock.split("\r\n")[0] ?? "";
    const match = /HTTP\/\d(?:\.\d)?\s+(\d+)/.exec(statusLine);
    status = match ? parseInt(match[1]!, 10) : null;
  } else {
    body = output;
  }
  return { status, text: body };
}

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
      const input = args[0]!;
      let result: GetResult;
      if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(input)) {
        result = httpGet(input);
      } else {
        const text = readFileSync(input, "utf8");
        result = { status: 200, text };
      }
      return resToValue(_vm.heap, result);
    },
  },
});