/**
 * Binary discovery for rg and fd.
 *
 * pi already downloads both into its agent dir for the built-in grep/find, so
 * the common case needs no install: prefer pi's copy, then anything on PATH.
 * Successful discovery and version checks are cached. Cached paths are still
 * stat-ed for removal, but their version process is not rerun on every search.
 */

import { execFileSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type SearchBinary = "rg" | "fd";

const cache = new Map<SearchBinary, string>();

const MINIMUM_VERSIONS: Record<SearchBinary, readonly [number, number, number]> = {
  rg: [12, 0, 0],
  fd: [8, 7, 0],
};

export function isSupportedVersion(binary: SearchBinary, versionOutput: string): boolean {
  const match = versionOutput.match(/\b(\d+)\.(\d+)(?:\.(\d+))?/);
  if (match === null) return false;
  const actual = [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] as const;
  const minimum = MINIMUM_VERSIONS[binary];
  for (let index = 0; index < minimum.length; index++) {
    if (actual[index]! > minimum[index]!) return true;
    if (actual[index]! < minimum[index]!) return false;
  }
  return true;
}

function hasSupportedVersion(candidate: string, binary: SearchBinary): boolean {
  try {
    const output = execFileSync(candidate, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
    });
    return isSupportedVersion(binary, output);
  } catch {
    return false;
  }
}

function isExecutable(candidate: string): boolean {
  try {
    if (!statSync(candidate).isFile()) return false;
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Test seam for platform PATH aliases. */
export function pathCandidates(binary: SearchBinary): string[] {
  const exeSuffix = process.platform === "win32" ? ".exe" : "";
  const names =
    binary === "fd" && process.platform !== "win32" ? ["fd", "fdfind"] : [`${binary}${exeSuffix}`];
  const entries = (process.env.PATH ?? "").split(path.delimiter);
  return entries
    .filter((entry) => entry.length > 0)
    .flatMap((entry) => names.map((name) => path.join(entry, name)));
}

/** Absolute path to the binary, or null when it is nowhere to be found. */
export function resolveBinary(binary: SearchBinary): string | null {
  const cached = cache.get(binary);
  if (cached !== undefined) {
    if (isExecutable(cached)) return cached;
    cache.delete(binary);
  }

  const exeSuffix = process.platform === "win32" ? ".exe" : "";
  const candidates = [
    // pi's own managed copy: guaranteed version-compatible with the harness.
    path.join(getAgentDir(), "bin", `${binary}${exeSuffix}`),
    ...pathCandidates(binary),
  ];

  const found = candidates.find(
    (candidate) => isExecutable(candidate) && hasSupportedVersion(candidate, binary),
  );
  // Do not cache misses: a user may install the binary and immediately retry
  // in the same session. Positive entries are revalidated on every lookup.
  if (found !== undefined) cache.set(binary, found);
  return found ?? null;
}

/** Test seam: forget cached resolutions. */
export function resetBinaryCache(): void {
  cache.clear();
}

export function missingBinaryMessage(binary: SearchBinary): string {
  const name = binary === "rg" ? "ripgrep (rg)" : "fd";
  const minimum = MINIMUM_VERSIONS[binary].join(".");
  const install = binary === "rg" ? "brew install ripgrep" : "brew install fd";
  return `A supported ${name} (>= ${minimum}) was not found in pi's bin directory or on PATH. Install or upgrade it with \`${install}\` (or the equivalent for your platform) and retry.`;
}
