import {
  getPlatform,
  setPlatformForTests,
  type Platform,
} from "../../src/platform/platform.js";
import { equal, test } from "../harness.js";

test("platform can be replaced and restored for tests", () => {
  const expected: Platform = {
    readFile: () => "input",
    writeFile: () => undefined,
    readBinaryFile: () => new Uint8Array([1, 2]),
    writeBinaryFile: () => undefined,
    exists: () => true,
    listDir: () => ["entry"],
    isDirectory: () => false,
    stdout: () => undefined,
    stderr: () => undefined,
    args: () => ["arg"],
    exit: () => {
      throw new Error("exit");
    },
    cwd: () => "/test",
    joinPath: (...segments) => segments.join("/"),
    clock: () => 10,
  };
  const original = getPlatform();
  const restore = setPlatformForTests(expected);
  equal(getPlatform(), expected);
  restore();
  equal(getPlatform(), original);
});
