/**
 * agy model discovery. Effort variants are presented as one Pi model while
 * retaining the launch constraints agy requires for the normalized base id.
 */

import type { AgyEffort } from "./agy-client.ts";

export interface AgyModelInfo {
  id: string;
  name: string;
  supportedEfforts: AgyEffort[];
  defaultEffort?: AgyEffort;
}

const EFFORT_SUFFIX = /-(low|medium|high)$/i;
const EFFORT_NAME_SUFFIX = /\s*\((?:low|medium|high)\)$/i;

function effortFromId(id: string): AgyEffort | undefined {
  const match = id.match(EFFORT_SUFFIX);
  const effort = match?.[1]?.toLowerCase();
  return effort === "low" || effort === "medium" || effort === "high" ? effort : undefined;
}

/** Collapse one effort variant while retaining its discovered effort. */
export function normalizeAgyModelId(id: string, name: string): AgyModelInfo {
  const effort = effortFromId(id);
  const baseId = effort ? id.replace(EFFORT_SUFFIX, "") : id;
  const baseName = effort ? name.replace(EFFORT_NAME_SUFFIX, "").trim() : name.trim();
  return {
    id: baseId || id,
    name: baseName || name,
    supportedEfforts: effort ? [effort] : [],
    defaultEffort: effort,
  };
}

/** Merge normalized/cache records without losing effort variants or discovery order. */
export function mergeAgyModels(models: readonly AgyModelInfo[]): AgyModelInfo[] {
  const merged: AgyModelInfo[] = [];
  for (const raw of models) {
    const normalized = normalizeAgyModelId(raw.id, raw.name);
    const efforts = raw.supportedEfforts?.length
      ? raw.supportedEfforts.filter(
          (effort): effort is AgyEffort =>
            effort === "low" || effort === "medium" || effort === "high",
        )
      : normalized.supportedEfforts;
    const existing = merged.find((model) => model.id === normalized.id);
    if (!existing) {
      merged.push({
        id: normalized.id,
        name: normalized.name,
        supportedEfforts: [...new Set(efforts)],
        defaultEffort: raw.defaultEffort ?? normalized.defaultEffort ?? efforts[0],
      });
      continue;
    }
    for (const effort of efforts) {
      if (!existing.supportedEfforts.includes(effort)) existing.supportedEfforts.push(effort);
    }
    existing.defaultEffort ??= raw.defaultEffort ?? normalized.defaultEffort ?? efforts[0];
  }
  return merged;
}

/** Parse `agy models` output: header/noise lines without a tab are ignored. */
export function parseAgyModels(text: string): AgyModelInfo[] {
  const rows: AgyModelInfo[] = [];
  for (const line of text.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab <= 0) continue;
    const rawId = line.slice(0, tab).trim();
    const rawName = line.slice(tab + 1).trim();
    if (!rawId || !rawName) continue;
    if (!/^[a-z0-9][a-z0-9.-]*$/i.test(rawId)) continue;
    rows.push(normalizeAgyModelId(rawId, rawName));
  }
  return mergeAgyModels(rows);
}

/** Resolve a valid effort for a normalized agy model. */
export function resolveAgyModelEffort(
  model: AgyModelInfo | undefined,
  requested: AgyEffort | undefined,
): AgyEffort | undefined {
  if (!model || model.supportedEfforts.length === 0) return undefined;
  if (requested && model.supportedEfforts.includes(requested)) return requested;
  return model.defaultEffort ?? model.supportedEfforts[0];
}

/** Fallback snapshot from agy 1.1.25 `agy models`, including effort constraints. */
export const FALLBACK_MODELS: AgyModelInfo[] = [
  {
    id: "gemini-3.8-flash",
    name: "Gemini 3.8 Flash",
    supportedEfforts: ["high", "medium", "low"],
    defaultEffort: "high",
  },
  {
    id: "gemini-3.7-flash",
    name: "Gemini 3.7 Flash",
    supportedEfforts: ["high", "medium", "low"],
    defaultEffort: "high",
  },
  {
    id: "gemini-3.6-flash",
    name: "Gemini 3.6 Flash",
    supportedEfforts: ["high", "medium", "low"],
    defaultEffort: "high",
  },
  {
    id: "gemini-3.1-pro",
    name: "Gemini 3.1 Pro",
    supportedEfforts: ["high", "low"],
    defaultEffort: "high",
  },
  {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6 (Thinking)",
    supportedEfforts: [],
  },
  {
    id: "claude-opus-4-6-thinking",
    name: "Claude Opus 4.6 (Thinking)",
    supportedEfforts: [],
  },
  {
    id: "gpt-oss-120b",
    name: "GPT-OSS 120B",
    supportedEfforts: ["medium"],
    defaultEffort: "medium",
  },
];

export interface ModelCapabilities {
  contextWindow: number;
  maxTokens: number;
}

/** USD per million tokens. */
export interface ModelPricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const ZERO_PRICING: ModelPricing = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

/**
 * Public API list prices, used only as a display estimate because agy itself
 * is subscription-billed. Unknown models deliberately stay at zero rather
 * than inheriting an unrelated vendor's rate.
 */
export function pricingForModel(modelId: string): ModelPricing {
  if (/^gemini-3\.(?:8|7|6)-flash$/i.test(modelId)) {
    return { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0.75 };
  }
  if (/^gemini-3\.5-flash$/i.test(modelId)) {
    return { input: 1.5, output: 9, cacheRead: 0.15, cacheWrite: 1.5 };
  }
  if (/^gemini-3\.1-pro/i.test(modelId)) {
    return { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2 };
  }
  if (/^claude-sonnet-4-6/i.test(modelId)) {
    return { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
  }
  if (/^claude-opus-4-6/i.test(modelId)) {
    return { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };
  }
  return { ...ZERO_PRICING };
}

/**
 * Pi scheduling window, deliberately larger than agy's private ~185k working
 * window. agy owns and persists its native context compaction.
 */
export const AGY_PI_SCHEDULING_CONTEXT_WINDOW = 1_000_000;

export function capabilitiesForModel(modelId: string): ModelCapabilities {
  let maxTokens: number;
  if (/^gpt-oss-120b/i.test(modelId)) {
    maxTokens = 131_072;
  } else if (/^claude-opus-4-6/i.test(modelId)) {
    maxTokens = 128_000;
  } else if (/^claude-sonnet-4-6/i.test(modelId)) {
    maxTokens = 64_000;
  } else if (/^gemini-/i.test(modelId)) {
    maxTokens = 65_536;
  } else {
    maxTokens = 32_768;
  }
  return { contextWindow: AGY_PI_SCHEDULING_CONTEXT_WINDOW, maxTokens };
}

export const LIVE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const FALLBACK_CACHE_TTL_MS = 5 * 60 * 1000;

export function modelCacheTtlMs(source: "live" | "fallback" | undefined): number {
  return source === "fallback" ? FALLBACK_CACHE_TTL_MS : LIVE_CACHE_TTL_MS;
}
