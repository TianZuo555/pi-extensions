/**
 * Herdr session capability — HERDR_ENV + binary on PATH, cached per session.
 */

import { resolveExecutableOnPath } from "./cli.ts";

let cachedAvailable: boolean | undefined;
let binaryPathOverride: string | null | undefined;

/** Test hook: force a binary path, or `null` to simulate missing binary. */
export function setHerdrBinaryPathForTests(path: string | null | undefined): void {
  binaryPathOverride = path;
  resetHerdrCapabilityCache();
}

export function resetHerdrCapabilityCache(): void {
  cachedAvailable = undefined;
}

function resolveHerdrBinary(): string | undefined {
  if (binaryPathOverride === null) return undefined;
  if (binaryPathOverride !== undefined) return binaryPathOverride;
  return resolveExecutableOnPath("herdr");
}

/**
 * True when HERDR_ENV is `1` and `herdr` resolves on PATH. Never invokes herdr.
 *
 * `PI_SUBAGENTS_DISABLE_HERDR=1` forces unavailable so a test suite running inside a real
 * Herdr session can never drive the user's live server. An explicit
 * `setHerdrBinaryPathForTests` override still wins, so selection tests can exercise the
 * herdr-available branches deterministically.
 */
export function isHerdrAvailable(): boolean {
  if (cachedAvailable !== undefined) return cachedAvailable;
  if (binaryPathOverride === undefined && process.env.PI_SUBAGENTS_DISABLE_HERDR === "1") {
    cachedAvailable = false;
    return cachedAvailable;
  }
  cachedAvailable = process.env.HERDR_ENV === "1" && resolveHerdrBinary() !== undefined;
  return cachedAvailable;
}
