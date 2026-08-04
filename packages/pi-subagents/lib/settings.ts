import * as fs from "node:fs";
import * as path from "node:path";

export interface ProfileOverride {
  model?: string;
  thinking?: string;
  timeoutSeconds?: number;
  maxTurns?: number;
}

export interface SubagentsSettings {
  defaultTimeoutMs?: number;
  defaultMaxTurns?: number;
  sessionSoftCostUsd?: number;
  agentOverrides?: Record<string, ProfileOverride>;
}

export function loadSubagentsSettings(paths: string[]): SubagentsSettings {
  const merged: SubagentsSettings = {};
  for (const filePath of paths) {
    if (!fs.existsSync(filePath)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as {
        subagents?: SubagentsSettings;
      };
      const block = parsed.subagents;
      if (!block) continue;
      if (block.defaultTimeoutMs !== undefined) {
        merged.defaultTimeoutMs = block.defaultTimeoutMs;
      }
      if (block.defaultMaxTurns !== undefined) {
        merged.defaultMaxTurns = block.defaultMaxTurns;
      }
      if (block.sessionSoftCostUsd !== undefined) {
        merged.sessionSoftCostUsd = block.sessionSoftCostUsd;
      }
      if (block.agentOverrides) {
        merged.agentOverrides = { ...merged.agentOverrides, ...block.agentOverrides };
      }
    } catch {
      // Ignore invalid settings files.
    }
  }
  return merged;
}

export function settingsPaths(agentDir: string, projectDir: string): string[] {
  return [
    path.join(agentDir, "settings.json"),
    path.join(projectDir, ".pi", "settings.json"),
  ];
}

export function mergeProfileOverride(
  profileName: string,
  qualifiedId: string,
  settings: SubagentsSettings,
): ProfileOverride | undefined {
  const overrides = settings.agentOverrides;
  if (!overrides) return undefined;
  return overrides[qualifiedId] ?? overrides[profileName];
}
