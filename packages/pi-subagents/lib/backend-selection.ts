/**
 * Per-profile backend resolution — Herdr preferred when available (decision 1).
 */

import type { ProfileDefinition } from "./domain.ts";
import { isHerdrAvailable } from "./herdr/capability.ts";

export type ResolvedBackendKind = "rpc" | "herdr";

export function resolveBackendKind(profile: ProfileDefinition): ResolvedBackendKind {
  const herdrAvailable = isHerdrAvailable();

  if (profile.backend === "rpc") {
    return "rpc";
  }

  if (profile.backend === "herdr") {
    if (!herdrAvailable) {
      throw new Error(
        `Profile "${profile.qualifiedId}" requires Herdr but no Herdr session is available (set HERDR_ENV=1 and ensure herdr is on PATH).`,
      );
    }
    return "herdr";
  }

  if (herdrAvailable) {
    return "herdr";
  }

  if (profile.kind !== "pi") {
    throw new Error(
      `Profile "${profile.qualifiedId}" requires agent kind "${profile.kind}", which needs a Herdr session`,
    );
  }

  return "rpc";
}
