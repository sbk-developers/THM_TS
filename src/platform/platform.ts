import * as fs from "node:fs";
import * as path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";

export interface Platform {
  readFile(filePath: string): string;
  writeFile(filePath: string, contents: string): void;
  readBinaryFile(filePath: string): Uint8Array;
  writeBinaryFile(filePath: string, contents: Uint8Array): void;
  exists(filePath: string): boolean;
  listDir(directoryPath: string): string[];
  isDirectory(filePath: string): boolean;
  stdout(text: string): void;
  stderr(text: string): void;
  args(): string[];
  exit(code: number): never;
  cwd(): string;
  joinPath(...segments: string[]): string;
  clock(): number;
  /** Read one line from standard input without its newline; `null` at end of input. */
  readLine?(): string | null;
}

export class PlatformError extends Error {
  constructor(operation: string, target: string, cause: unknown) {
    const detail =
      typeof cause === "string"
        ? cause
        : cause instanceof Error
          ? cause.message
          : String(cause);
    super(`${operation} ${JSON.stringify(target)}: ${detail}`);
    this.name = "PlatformError";
  }
}

function decodeUtf8(bytes: number[]): string {
  const text = new TextDecoder().decode(new Uint8Array(bytes));
  return text.endsWith("\r") ? text.slice(0, -1) : text;
}

function platformCall<T>(operation: string, target: string, action: () => T): T {
  try {
    return action();
  } catch (error) {
    throw new PlatformError(operation, target, error);
  }
}

export function createNativePlatform(): Platform {
  const resolve = (filePath: string): string =>
    path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
  return {
    readFile(filePath): string {
      const target = resolve(filePath);
      return platformCall("readFile", filePath, () => fs.readFileSync(target, "utf8"));
    },
    writeFile(filePath, contents): void {
      const target = resolve(filePath);
      platformCall("writeFile", filePath, () => fs.writeFileSync(target, contents, "utf8"));
    },
    readBinaryFile(filePath): Uint8Array {
      const target = resolve(filePath);
      return platformCall("readBinaryFile", filePath, () => new Uint8Array(fs.readFileSync(target)));
    },
    writeBinaryFile(filePath, contents): void {
      const target = resolve(filePath);
      platformCall("writeBinaryFile", filePath, () => fs.writeFileSync(target, contents));
    },
    exists(filePath): boolean {
      return fs.existsSync(resolve(filePath));
    },
    listDir(directoryPath): string[] {
      const target = resolve(directoryPath);
      return platformCall("listDir", directoryPath, () => fs.readdirSync(target).slice());
    },
    isDirectory(filePath): boolean {
      const target = resolve(filePath);
      return platformCall("isDirectory", filePath, () => fs.statSync(target).isDirectory());
    },
    stdout(text): void {
      process.stdout.write(text);
    },
    stderr(text): void {
      process.stderr.write(text);
    },
    args(): string[] {
      return process.argv.slice(2).slice();
    },
    exit(code): never {
      process.exit(code);
    },
    cwd(): string {
      return process.cwd();
    },
    joinPath(...segments): string {
      return path.join(...segments);
    },
    clock(): number {
      return performance.now();
    },
    readLine(): string | null {
      const buffer = new Uint8Array(1);
      const bytes: number[] = [];
      while (true) {
        let read = 0;
        try {
          read = fs.readSync(0, buffer, 0, 1, null);
        } catch (error) {
          const code = (error as { code?: string }).code;
          if (code === "EAGAIN") continue;
          if (code === "EOF") break;
          throw new PlatformError("readLine", "stdin", error);
        }
        if (read === 0) break;
        if (buffer[0] === 10) return decodeUtf8(bytes);
        bytes.push(buffer[0]!);
      }
      return bytes.length === 0 ? null : decodeUtf8(bytes);
    },
  };
}

let activePlatform: Platform = createNativePlatform();

export function getPlatform(): Platform {
  return activePlatform;
}

export function setPlatformForTests(platform: Platform): () => void {
  const previous = activePlatform;
  activePlatform = platform;
  return () => {
    activePlatform = previous;
  };
}
