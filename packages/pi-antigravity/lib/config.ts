import fs from "node:fs";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * Absolute path to a machine-local pi config directory, under pi's own agent
 * dir (`~/.pi/agent`, or `PI_CODING_AGENT_DIR` when customized) so an isolated
 * pi profile never shares — or clobbers — the main profile's caches.
 */
export function piConfigDir(name: string): string {
  return path.join(getAgentDir(), name);
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
