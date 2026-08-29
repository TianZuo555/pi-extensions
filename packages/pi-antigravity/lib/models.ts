/**
 * agy model discovery — parses `agy models` tab-separated output and maps it
 * to pi provider model configs. Effort variants (`-low`/`-medium`/`-high`
 * suffixes) are collapsed into one base model per family; reasoning effort is
 * controlled at turn time from pi's thinking level via `agy --effort`.
 * A bundled fallback snapshot (captured from agy 1.1.19) registers when
 * discovery cannot run, so /model stays usable.
 */

export interface AgyModelInfo {
  id: string;
  name: string;
}

const EFFORT_SUFFIX = /-(low|medium|high)$/i;
const EFFORT_NAME_SUFFIX = /\s*\((?:low|medium|high)\)$/i;

/** Collapse an effort variant (`gemini-3.7-flash-high`) to its base model. */
export function normalizeAgyModelId(id: string, name: string): AgyModelInfo {
  const baseId = id.replace(EFFORT_SUFFIX, "");
  const baseName = name.replace(EFFORT_NAME_SUFFIX, "").trim();
  return { id: baseId || id, name: baseName || name };
}

/** Parse `agy models` output: header/noise lines without a tab are ignored. */
export function parseAgyModels(text: string): AgyModelInfo[] {
  const models: AgyModelInfo[] = [];
  for (const line of text.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab <= 0) continue;
    const rawId = line.slice(0, tab).trim();
    const rawName = line.slice(tab + 1).trim();
    if (!rawId || !rawName) continue;
    if (!/^[a-z0-9][a-z0-9.-]*$/i.test(rawId)) continue;
    const model = normalizeAgyModelId(rawId, rawName);
    if (models.some((m) => m.id === model.id)) continue;
    models.push(model);
  }
  return models;
}

/** Fallback snapshot from agy 1.1.19 `agy models` (2026-08-24), base models only. */
export const FALLBACK_MODELS: AgyModelInfo[] = [
  { id: "gemini-3.7-flash", name: "Gemini 3.7 Flash" },
  { id: "gemini-3.6-flash", name: "Gemini 3.6 Flash" },
  { id: "gemini-3.5-flash", name: "Gemini 3.5 Flash" },
  { id: "gemini-3.1-pro", name: "Gemini 3.1 Pro" },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (Thinking)" },
  { id: "claude-opus-4-6-thinking", name: "Claude Opus 4.6 (Thinking)" },
  { id: "gpt-oss-120b", name: "GPT-OSS 120B" },
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
  if (/^gemini-3\.(?:7|6)-flash$/i.test(modelId)) {
    return { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0.75 };
  }
  if (/^gemini-3\.5-flash$/i.test(modelId)) {
    return { input: 1.5, output: 9, cacheRead: 0.15, cacheWrite: 1.5 };
  }
  if (/^gemini-3\.1-pro/i.test(modelId)) {
    // The <=200k standard tier; pi's cost shape cannot express tiered rates.
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
 * window. agy owns and persists its native context compaction; advertising the
 * smaller working cap made Pi summarize the same conversation first. This is
 * not a claim about raw model capacity — `/agy` reports the observed native
 * footprint while Pi uses this value only for its compaction scheduler.
 */
export const AGY_PI_SCHEDULING_CONTEXT_WINDOW = 1_000_000;

/** Vendor-specific limits for models present in agy's current catalog. */
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

/** Cache lifetime for a discovery result: live catalogs hold a day. */
export const LIVE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * Fallback snapshots hold minutes only: live discovery can lose a race
 * (observed: `agy models` taking 12s against a 15s timeout) and must be
 * retried soon instead of sticking for the full day.
 */
export const FALLBACK_CACHE_TTL_MS = 5 * 60 * 1000;

/** TTL that applies to a cached model list with the given source. */
export function modelCacheTtlMs(source: "live" | "fallback" | undefined): number {
  return source === "fallback" ? FALLBACK_CACHE_TTL_MS : LIVE_CACHE_TTL_MS;
}
