import { getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import lockfile from "proper-lockfile";
import type { AgyToolMode } from "./tool-mode.ts";

function settingsPath(): string {
  return path.join(getAgentDir(), "settings.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readDocument(file: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  const document: unknown = JSON.parse(text.replace(/^\uFEFF/, ""));
  if (!isRecord(document)) throw new Error("Pi settings.json must contain an object.");
  if (document.antigravity !== undefined && !isRecord(document.antigravity)) {
    throw new Error("Pi settings antigravity must contain an object.");
  }
  return document;
}

/** Read the user preference; CLI and environment overrides are resolved separately. */
export function loadSavedAgyToolMode(file = settingsPath()): AgyToolMode | undefined {
  const settings = readDocument(file).antigravity as Record<string, unknown> | undefined;
  const mode = settings?.toolMode;
  if (mode === undefined) return undefined;
  if (mode !== "native" && mode !== "pi") {
    throw new Error('Pi settings antigravity.toolMode must be exactly "native" or "pi".');
  }
  return mode;
}

/** Merge under the same file lock Pi uses, preserving other sessions' settings. */
export async function saveAgyToolMode(mode: AgyToolMode, file = settingsPath()): Promise<void> {
  await withFileMutationQueue(file, async () => {
    mkdirSync(path.dirname(file), { recursive: true });
    const release = lockfile.lockSync(file, { realpath: false });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      const document = readDocument(file);
      document.antigravity = {
        ...(document.antigravity as Record<string, unknown> | undefined),
        toolMode: mode,
      };
      writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      renameSync(temporary, file);
    } finally {
      try {
        rmSync(temporary, { force: true });
      } finally {
        release();
      }
    }
  });
}
