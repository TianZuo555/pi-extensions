/**
 * agy model discovery — parses `agy models` tab-separated output and maps it
 * to pi provider model configs. Effort variants (`-low`/`-medium`/`-high`
 * suffixes) are collapsed into one base model per family; reasoning effort is
 * controlled at turn time from pi's thinking level via `agy --effort`.
 * A bundled fallback snapshot (captured from agy 1.1.17) registers when
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

/** Fallback snapshot from agy 1.1.17 `agy models` (2026-08-21), base models only. */
export const FALLBACK_MODELS: AgyModelInfo[] = [
  { id: "gemini-3.7-flash", name: "Gemini 3.7 Flash" },
  { id: "gemini-3.6-flash", name: "Gemini 3.6 Flash" },
  { id: "gemini-3.5-flash", name: "Gemini 3.5 Flash" },
];

/** Placeholder context/output limits — agy does not expose these via CLI. */
export const CONTEXT_WINDOW = 1_048_576;
export const MAX_TOKENS = 65_536;

/** USD per million tokens. */
export interface ModelPricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * Reference Gemini API pricing used as the default estimate. agy itself is
 * subscription-billed; these rates only make pi's native cost display show
 * the equivalent API spend.
 */
export const DEFAULT_PRICING: Record<"flash" | "pro", ModelPricing> = {
  flash: { input: 0.3, output: 2.5, cacheRead: 0.075, cacheWrite: 0.3 },
  pro: { input: 1.25, output: 10, cacheRead: 0.31, cacheWrite: 1.25 },
};

/** Pick the pricing tier for a base model id (pro when the id says so). */
export function pricingForModel(modelId: string): ModelPricing {
  return /pro/i.test(modelId) ? DEFAULT_PRICING.pro : DEFAULT_PRICING.flash;
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
