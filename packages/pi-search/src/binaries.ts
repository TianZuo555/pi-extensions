/**
 * Binary discovery for rg and fd.
 *
 * pi already downloads both into its agent dir for the built-in grep/find, so
 * the common case needs no install: prefer pi's copy, then anything on PATH.
 * Resolution is cached per binary because a search is on the interactive path
 * and stat-ing candidates on every call is wasted work.
 */

import { accessSync, constants } from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type SearchBinary = "rg" | "fd";

const cache = new Map<SearchBinary, string | null>();

function isExecutable(candidate: string): boolean {
  try {
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Test seam for platform PATH aliases. */
export function pathCandidates(binary: SearchBinary): string[] {
  const exeSuffix = process.platform === "win32" ? ".exe" : "";
  const names = binary === "fd" && process.platform !== "win32"
    ? ["fd", "fdfind"]
    : [`${binary}${exeSuffix}`];
  const entries = (process.env.PATH ?? "").split(path.delimiter);
  return entries
    .filter((entry) => entry.length > 0)
    .flatMap((entry) => names.map((name) => path.join(entry, name)));
}

/** Absolute path to the binary, or null when it is nowhere to be found. */
export function resolveBinary(binary: SearchBinary): string | null {
  const cached = cache.get(binary);
  if (cached !== undefined) return cached;

  const exeSuffix = process.platform === "win32" ? ".exe" : "";
  const candidates = [
    // pi's own managed copy: guaranteed version-compatible with the harness.
    path.join(getAgentDir(), "bin", `${binary}${exeSuffix}`),
    ...pathCandidates(binary),
  ];

  const found = candidates.find(isExecutable) ?? null;
  cache.set(binary, found);
  return found;
}

/** Test seam: forget cached resolutions. */
export function resetBinaryCache(): void {
  cache.clear();
}

export function missingBinaryMessage(binary: SearchBinary): string {
  const name = binary === "rg" ? "ripgrep (rg)" : "fd";
  const install =
    binary === "rg" ? "brew install ripgrep" : "brew install fd";
  return `${name} was not found in pi's bin directory or on PATH. Install it with \`${install}\` (or the equivalent for your platform) and retry.`;
}
