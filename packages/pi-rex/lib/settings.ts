// Read the pi settings in the `rex` section.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Names of the on/off switches in the `rex` settings section. */
export type RexSwitch = "autoName";

function rexSettings(pi: ExtensionAPI): Record<string, unknown> | undefined {
  const rex = (pi.getSettings() as { rex?: unknown }).rex;
  if (typeof rex !== "object" || rex === null) return undefined;
  return rex as Record<string, unknown>;
}

/** Only an explicit `false` turns a feature off. */
export function rexSetting(pi: ExtensionAPI, key: RexSwitch): boolean {
  return rexSettings(pi)?.[key] !== false;
}
