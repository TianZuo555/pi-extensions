// The pi settings that pi-rex reads. One place, so both features read the same
// `rex` section and the same on/off rule: only `false` turns a feature off.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Names of the on/off switches in the `rex` settings section. */
export type RexSwitch = "autoName" | "resume";

/**
 * Read one `rex` switch. Returns `false` only for a JSON `false`; a missing
 * section or any other value keeps the feature on.
 */
export function rexSetting(pi: ExtensionAPI, key: RexSwitch): boolean {
  const rex = (pi.getSettings() as { rex?: unknown }).rex;
  if (typeof rex !== "object" || rex === null) return true;
  return (rex as Record<string, unknown>)[key] !== false;
}
