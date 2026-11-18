import assert from "node:assert/strict";
import { checkTypes, parseAst, buildCfg, typeToString, optionalType } from "../out/type-system.js";

const source = [
  "count: int = 1",
  'count = "wrong"',
  "maybe: Optional[str] = None",
  "if maybe is not None {",
  '    label: str = maybe',
  "}",
  "values: list[int] = [1, 2, 3]",
  "nothing: Never",
].join("\n");
const result = checkTypes(source);
assert.ok(result.ast.body.length >= 6, "builds tolerant AST");
assert.ok(result.cfg.blocks.length > result.ast.body.length, "lowers AST into CFG blocks");
assert.ok(result.diagnostics.some(d => d.code === "type-mismatch" && d.message.includes("int")),
  "reports incompatible assignment");
assert.equal(typeToString(optionalType({kind:"primitive",name:"str"})), "str | None");
console.log("TYPE SYSTEM TESTS PASSED");
