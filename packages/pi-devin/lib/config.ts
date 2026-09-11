import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Absolute path to a machine-local pi config directory: ~/.pi/<name>. */
export function piConfigDir(name: string): string {
  return path.join(os.homedir(), ".pi", name);
}

/** Read and parse a JSON file, returning fallback if it is missing or invalid. */
export function readJson<T>(file: string, fallback: T): T {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

/** Write a JSON file, creating parent directories. Throws on failure. */
export function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}
