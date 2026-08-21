/**
 * agy model discovery — parses `agy models` tab-separated output and maps it
 * to pi provider model configs. A bundled fallback snapshot (captured from agy
 * 1.1.17) registers when discovery cannot run, so /model stays usable.
 */

export interface AgyModelInfo {
  id: string;
  name: string;
}

/** Parse `agy models` output: header/noise lines without a tab are ignored. */
export function parseAgyModels(text: string): AgyModelInfo[] {
  const models: AgyModelInfo[] = [];
  for (const line of text.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab <= 0) continue;
    const id = line.slice(0, tab).trim();
    const name = line.slice(tab + 1).trim();
    if (!id || !name) continue;
    if (!/^[a-z0-9][a-z0-9.-]*$/i.test(id)) continue;
    if (models.some((m) => m.id === id)) continue;
    models.push({ id, name });
  }
  return models;
}

/** Fallback snapshot from agy 1.1.17 `agy models` (2026-08-21). */
export const FALLBACK_MODELS: AgyModelInfo[] = [
  { id: "gemini-3.7-flash-high", name: "Gemini 3.7 Flash (High)" },
  { id: "gemini-3.7-flash-medium", name: "Gemini 3.7 Flash (Medium)" },
  { id: "gemini-3.7-flash-low", name: "Gemini 3.7 Flash (Low)" },
  { id: "gemini-3.6-flash-high", name: "Gemini 3.6 Flash (High)" },
  { id: "gemini-3.6-flash-medium", name: "Gemini 3.6 Flash (Medium)" },
  { id: "gemini-3.6-flash-low", name: "Gemini 3.6 Flash (Low)" },
  { id: "gemini-3.5-flash-high", name: "Gemini 3.5 Flash (High)" },
  { id: "gemini-3.5-flash-medium", name: "Gemini 3.5 Flash (Medium)" },
  { id: "gemini-3.5-flash-low", name: "Gemini 3.5 Flash (Low)" },
];

/** Placeholder context/output limits — agy does not expose these via CLI. */
export const CONTEXT_WINDOW = 1_048_576;
export const MAX_TOKENS = 65_536;
