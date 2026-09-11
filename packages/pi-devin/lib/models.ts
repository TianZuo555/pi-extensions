/**
 * devin model discovery. `devin models list` prints families of concrete
 * model rows; each row carries thinking-level, fast (priority), and
 * context-window-variant markers as id suffixes. Families collapse into one
 * Pi model per (context variant, fast) group; a Pi thinking level resolves
 * to the group's concrete devin model id at turn time.
 */

import type { ThinkingLevel } from "@earendil-works/pi-ai";

export type DevinEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

const EFFORT_ORDER: DevinEffort[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

export interface DevinModelPricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface DevinModelRow {
  /** Concrete devin model id, e.g. "claude-opus-5-high" or "MODEL_GPT_5_2_LOW". */
  id: string;
  name: string;
  contextWindow: number;
  cost: DevinModelPricing;
  /** Trailing effort marker, when the row id carries one. */
  effort?: DevinEffort;
  /** Binary thinking row ("-thinking") — any-level fallback. */
  thinking?: boolean;
  /** Fast/priority serving tier ("-fast" or "-priority"). */
  fast?: boolean;
  /** Context-window variant marker ("-1m"), lowercased. */
  contextVariant?: string;
}

export interface DevinModelGroup {
  /** Pi model id, e.g. "claude-opus-5", "claude-opus-4.6-1m", "gpt-5.4-fast". */
  id: string;
  name: string;
  contextWindow: number;
  cost: DevinModelPricing;
  /** Whether any row supports a thinking control (levels or "-thinking"). */
  reasoning: boolean;
  /** Default row when the user specifies no thinking level. */
  defaultRow: DevinModelRow;
  rows: DevinModelRow[];
}

export interface DevinModelFamily {
  /** Family slug as printed in `devin models list`, e.g. "claude-opus-5". */
  id: string;
  name: string;
  aliases: string[];
  rows: DevinModelRow[];
}

const EFFORT_TOKENS = new Set<DevinEffort>(EFFORT_ORDER);
const FAST_TOKENS = new Set(["fast", "priority"]);
const CONTEXT_TOKEN = /^\d+[km]$/i;

/**
 * Split a row id's trailing markers from its base. Suffix tokens are
 * `-`/`_`-separated; recognized markers strip repeatedly from the end:
 * `claude-opus-4-6-thinking-1m` → ctx=1m, thinking; `gpt-5-4-none-priority`
 * → fast, effort=none; `MODEL_GPT_5_2_XHIGH` → effort=xhigh.
 */
export function rowMarkers(id: string): {
  effort?: DevinEffort;
  thinking: boolean;
  fast: boolean;
  contextVariant?: string;
} {
  const tokens = id.split(/[-_]/);
  let effort: DevinEffort | undefined;
  let thinking = false;
  let fast = false;
  let contextVariant: string | undefined;
  for (let i = tokens.length - 1; i >= 0; i--) {
    const token = tokens[i].toLowerCase();
    if (fast === false && FAST_TOKENS.has(token)) {
      fast = true;
      continue;
    }
    if (contextVariant === undefined && CONTEXT_TOKEN.test(token)) {
      contextVariant = token;
      continue;
    }
    if (!thinking && token === "thinking") {
      thinking = true;
      continue;
    }
    if (effort === undefined && (EFFORT_TOKENS.has as (v: string) => boolean)(token)) {
      effort = token as DevinEffort;
      continue;
    }
    break;
  }
  return { effort, thinking, fast, contextVariant };
}

function parseContextWindow(meta: string): number {
  const match = meta.match(/([\d.,]+)\s*(k|m)?\s*context/i);
  if (!match) return 0;
  const value = Number(match[1].replace(/,/g, ""));
  if (!Number.isFinite(value)) return 0;
  const suffix = match[2]?.toLowerCase();
  const scale = suffix === "m" ? 1_000_000 : suffix === "k" ? 1_000 : 1;
  return Math.round(value * scale);
}

const PRICE = /\$([\d.]+)\s*\/\s*1M\s*(input|cached input|output)/gi;

/** Parse the `[…]` meta section: context size plus per-Mtok USD rates or Free. */
export function parseRowMeta(meta: string): { contextWindow: number; cost: DevinModelPricing } {
  const cost: DevinModelPricing = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const match of meta.matchAll(PRICE)) {
    const value = Number(match[1]);
    if (!Number.isFinite(value)) continue;
    const kind = match[2].toLowerCase();
    if (kind === "input") cost.input = value;
    else if (kind === "cached input") cost.cacheRead = value;
    else if (kind === "output") cost.output = value;
  }
  return { contextWindow: parseContextWindow(meta), cost };
}

const FAMILY_LINE = /^(\S.*)\s\(([^()\s]+)\)\s*$/;
const ALIASES_LINE = /^\s+aliases:\s*(.+)$/;
const ROW_LINE = /^\s{2,}(\S+)\s{2,}(\S.*?)\s{2,}\[([^\]]*)\]\s*$/;

/**
 * Parse `devin models list` output. Non-matching lines (header, footer,
 * blank) are ignored; families keep printed order.
 */
export function parseDevinModels(text: string): DevinModelFamily[] {
  const families: DevinModelFamily[] = [];
  let current: { id: string; name: string; aliases: string[]; rows: DevinModelRow[] } | undefined;
  for (const line of text.split("\n")) {
    const aliases = line.match(ALIASES_LINE);
    if (aliases && current) {
      current.aliases = aliases[1]
        .split(",")
        .map((alias) => alias.trim())
        .filter(Boolean);
      continue;
    }
    const row = line.match(ROW_LINE);
    if (row && current) {
      const { contextWindow, cost } = parseRowMeta(row[3]);
      const markers = rowMarkers(row[1]);
      current.rows.push({
        id: row[1],
        name: row[2].trim(),
        contextWindow,
        cost,
        effort: markers.effort,
        thinking: markers.thinking || undefined,
        fast: markers.fast || undefined,
        contextVariant: markers.contextVariant,
      });
      continue;
    }
    const family = line.match(FAMILY_LINE);
    if (family) {
      current = { id: family[2], name: family[1].trim(), aliases: [], rows: [] };
      families.push(current);
      continue;
    }
    // A non-indented non-family line ends the family block tolerance-free:
    // rows/aliases only apply while a family header preceded them.
    if (line.trim() !== "" && !line.startsWith(" ") && !line.startsWith("\t")) {
      current = undefined;
    }
  }
  return families;
}

/** Effort rank for nearest-at-or-below resolution. */
function effortRank(effort: DevinEffort | undefined): number {
  return effort === undefined ? -1 : EFFORT_ORDER.indexOf(effort);
}

/**
 * Pick the row a bare pi model resolves to: prefer `medium`, then a binary
 * `thinking` row, then an unmarked row, then the first listed.
 */
function defaultRow(rows: DevinModelRow[]): DevinModelRow {
  return (
    rows.find((row) => row.effort === "medium") ??
    rows.find((row) => row.thinking) ??
    rows.find((row) => row.effort === undefined) ??
    rows[0]
  );
}

/** Split one family's rows into pi models keyed by (context variant, fast). */
export function buildGroups(family: {
  id: string;
  name: string;
  rows: DevinModelRow[];
}): DevinModelGroup[] {
  const byKey = new Map<string, DevinModelRow[]>();
  for (const row of family.rows) {
    const key = `${row.contextVariant ?? ""}|${row.fast ? "fast" : ""}`;
    const group = byKey.get(key) ?? [];
    group.push(row);
    byKey.set(key, group);
  }
  const single = byKey.size === 1;
  const groups: DevinModelGroup[] = [];
  for (const rows of byKey.values()) {
    const first = rows[0];
    const suffix =
      single || !first
        ? ""
        : `${first.contextVariant ? `-${first.contextVariant}` : ""}${first.fast ? "-fast" : ""}`;
    const reasoning = rows.some((row) => row.thinking === true || row.effort !== undefined);
    groups.push({
      id: `${family.id}${suffix}`,
      name: `${family.name}${suffix ? ` ${suffix.slice(1).replace(/-/g, " ")}` : ""}`.trim(),
      contextWindow: first?.contextWindow ?? 0,
      cost: first ? { ...first.cost } : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      reasoning,
      defaultRow: defaultRow(rows),
      rows,
    });
  }
  return groups;
}

/**
 * Resolve a pi thinking level to the group's concrete devin model id.
 * - undefined → the group's default row;
 * - "off" → a `none` effort row, else an unmarked row, else the default;
 * - an exact effort row wins, then the highest effort at or below the
 *   request, then a binary `-thinking` row, then the lowest effort
 *   available (a request below the floor clamps down, never up to max).
 */
export function resolveDevinModelRow(
  group: DevinModelGroup,
  level: ThinkingLevel | "off" | undefined,
): DevinModelRow {
  const rows = group.rows;
  if (level === undefined) return group.defaultRow;
  if (level === "off") {
    return (
      rows.find((row) => row.effort === "none") ??
      rows.find((row) => row.effort === undefined && !row.thinking) ??
      group.defaultRow
    );
  }
  const wanted = level as DevinEffort;
  const exact = rows.find((row) => row.effort === wanted);
  if (exact) return exact;
  const ranked = rows
    .filter((row) => row.effort !== undefined)
    .sort((a, b) => effortRank(b.effort) - effortRank(a.effort));
  const atOrBelow = ranked.find((row) => effortRank(row.effort) <= effortRank(wanted));
  if (atOrBelow) return atOrBelow;
  const thinking = rows.find((row) => row.thinking);
  if (thinking) return thinking;
  return ranked.at(-1) ?? group.defaultRow;
}

/** Pi model list metadata for one group (registration-time view). */
export function groupThinkingLevelMap(
  group: DevinModelGroup,
): Partial<Record<ThinkingLevel | "off", string | null>> | undefined {
  if (!group.reasoning) return undefined;
  const map: Partial<Record<ThinkingLevel | "off", string | null>> = {};
  for (const level of ["minimal", "low", "medium", "high", "xhigh", "max", "off"] as const) {
    map[level] = resolveDevinModelRow(group, level).id;
  }
  return map;
}

/** Flatten families into the pi-registerable group list. */
export function devinGroups(families: DevinModelFamily[]): DevinModelGroup[] {
  return families.flatMap((family) => buildGroups(family));
}

/** Find a group by pi model id (family slug + variant suffix). */
export function findDevinGroup(
  families: DevinModelFamily[],
  modelId: string,
): DevinModelGroup | undefined {
  return devinGroups(families).find((group) => group.id === modelId);
}

export const LIVE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const FALLBACK_CACHE_TTL_MS = 5 * 60 * 1000;

export function modelCacheTtlMs(source: "live" | "fallback" | undefined): number {
  return source === "fallback" ? FALLBACK_CACHE_TTL_MS : LIVE_CACHE_TTL_MS;
}
