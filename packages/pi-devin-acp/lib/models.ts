/**
 * devin model discovery. `devin models list` prints families of concrete
 * model rows; each row carries thinking-level, fast (priority), and
 * context-window-variant markers as id suffixes. Families collapse into one
 * Pi model per (context variant, fast) group; a Pi thinking level resolves
 * to the group's concrete devin model id at turn time.
 */

import type { ThinkingLevel } from "@earendil-works/pi-ai";
import type { DevinConfigOption } from "./acp-client.ts";

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
  /** Pi model id, e.g. "claude-opus-5", "claude-opus-4.6-1m". */
  id: string;
  name: string;
  contextWindow: number;
  cost: DevinModelPricing;
  /** Whether any row supports a thinking control (levels or "-thinking"). */
  reasoning: boolean;
  rows: DevinModelRow[];
}

export interface DevinModelFamily {
  /** Family slug as printed in `devin models list`, e.g. "claude-opus-5". */
  id: string;
  name: string;
  aliases: string[];
  rows: DevinModelRow[];
}

const EFFORT_TOKENS = new Set<string>(EFFORT_ORDER);
const FAST_TOKENS = new Set(["fast", "priority"]);
const CONTEXT_TOKEN = /^\d+[km]$/i;

const TRAILING_TOKEN = /([-_])([^-_]+)$/;
const SIDECKICK_SPLIT = "-sidekick-";

/**
 * Split a row id's trailing markers from its base. Suffix tokens are
 * `-`/`_`-separated; recognized markers strip repeatedly from the end:
 * `claude-opus-4-6-thinking-1m` → base=claude-opus-4-6, ctx=1m, thinking;
 * `gpt-5-4-none-priority` → base=gpt-5-4, fast, effort=none;
 * `MODEL_GPT_5_2_XHIGH` → base=MODEL_GPT_5_2, effort=xhigh.
 *
 * Fusion rows are composite (`fusion-<leadUid>-sidekick-<sidekickUid>`):
 * only the lead uid carries markers (including mid-id `-fast`), and the
 * sidekick uid tail stays verbatim in the base — it selects the anchor
 * variant and is not a marker carrier.
 */
export function rowMarkers(id: string): {
  base: string;
  effort?: DevinEffort;
  thinking: boolean;
  fast: boolean;
  contextVariant?: string;
} {
  const split = id.lastIndexOf(SIDECKICK_SPLIT);
  if (split !== -1) {
    const lead = rowMarkers(id.slice(0, split));
    return { ...lead, base: `${lead.base}${id.slice(split)}` };
  }
  let base = id;
  let effort: DevinEffort | undefined;
  let thinking = false;
  let fast = false;
  let contextVariant: string | undefined;
  for (;;) {
    const match = TRAILING_TOKEN.exec(base);
    if (!match) break;
    const token = match[2].toLowerCase();
    if (!fast && FAST_TOKENS.has(token)) {
      fast = true;
      base = base.slice(0, match.index);
      continue;
    }
    if (contextVariant === undefined && CONTEXT_TOKEN.test(token)) {
      contextVariant = token;
      base = base.slice(0, match.index);
      continue;
    }
    if (!thinking && token === "thinking") {
      thinking = true;
      base = base.slice(0, match.index);
      continue;
    }
    if (effort === undefined && EFFORT_TOKENS.has(token)) {
      effort = token as DevinEffort;
      base = base.slice(0, match.index);
      continue;
    }
    break;
  }
  return { base, effort, thinking, fast, contextVariant };
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
 * Clamp a desired effort onto the values a select option advertises: exact
 * match, else the closest at or below, else the lowest available (a request
 * below the floor clamps down, never up).
 */
export function clampDevinEffort(
  desired: DevinEffort | undefined,
  values: readonly string[],
): string | undefined {
  if (desired === undefined) return undefined;
  const ranked = values
    .map((value) => ({ value, effort: value.toLowerCase() as DevinEffort }))
    .filter((candidate) => EFFORT_TOKENS.has(candidate.effort))
    .sort((a, b) => effortRank(b.effort) - effortRank(a.effort));
  const exact = ranked.find((candidate) => candidate.effort === desired);
  if (exact) return exact.value;
  const atOrBelow = ranked.find((candidate) => effortRank(candidate.effort) <= effortRank(desired));
  return atOrBelow?.value ?? ranked.at(-1)?.value;
}

/** One `session/set_config_option` write. */
export interface DevinConfigSet {
  configId: string;
  value: string;
}

/** The ACP config options that carry devin's model selection, in write order. */
export const MODEL_SYNC_CONFIG_IDS = ["model", "thought_level", "speed"] as const;

/** Whether two row ids address the same family and context variant. */
function sameRowBase(a: string, b: string): boolean {
  const ma = rowMarkers(a);
  const mb = rowMarkers(b);
  return ma.base === mb.base && ma.contextVariant === mb.contextVariant;
}

/**
 * Looser anchor identity for composite rows: the sidekick half's markers are
 * stripped too, so a row whose sidekick variant has no advertised anchor can
 * still land on the closest one (its effort/tier is then set via
 * thought_level/speed where expressible).
 */
function sameLooseBase(a: string, b: string): boolean {
  const loose = (id: string) => {
    const markers = rowMarkers(id);
    const split = markers.base.lastIndexOf(SIDECKICK_SPLIT);
    const base =
      split === -1
        ? markers.base
        : `${markers.base.slice(0, split)}${SIDECKICK_SPLIT}${rowMarkers(markers.base.slice(split + SIDECKICK_SPLIT.length)).base}`;
    return `${base}|${markers.contextVariant ?? ""}`;
  };
  return loose(a) === loose(b);
}

function optionValues(options: readonly DevinConfigOption[], id: string): string[] {
  return options.find((option) => option.id === id)?.options?.map((o) => o.value) ?? [];
}

/**
 * Plan one config write that helps select `rowId` on an ACP session.
 *
 * Devin validates `model` against the session's advertised select values.
 * Modern builds (3000.11+) advertise one anchor row per family and carry
 * the variant dimensions in separate `thought_level`/`speed` options, while
 * older builds accept any catalog row id directly. A row id that is itself
 * an accepted model value already encodes effort/speed, so it is written
 * as-is and the variant options are left untouched. Each write may refresh
 * the advertised options (effort levels are per family), so callers plan
 * every write against the latest `configOptions`.
 */
export function planDevinConfigSet(
  configId: string,
  rowId: string,
  configOptions: readonly DevinConfigOption[],
): DevinConfigSet | undefined {
  if (configId === "model") {
    const values = optionValues(configOptions, "model");
    // Devin validates `model` against its select values and rejects concrete
    // catalog rows (notably fusion combinations): fall back from the exact id
    // to the anchor of the same family/lead + sidekick.
    const value = values.includes(rowId)
      ? rowId
      : (values.find((value) => sameRowBase(value, rowId)) ??
        values.find((value) => sameLooseBase(value, rowId)) ??
        rowId);
    return { configId, value };
  }
  if (optionValues(configOptions, "model").includes(rowId)) return undefined;
  const markers = rowMarkers(rowId);
  const values = optionValues(configOptions, configId);
  if (configId === "thought_level") {
    const value = clampDevinEffort(markers.effort, values);
    return value === undefined ? undefined : { configId, value };
  }
  if (configId === "speed") {
    const wanted = markers.fast ? "fast" : "standard";
    return values.includes(wanted) ? { configId, value: wanted } : undefined;
  }
  return undefined;
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

/** Split one family's rows into pi models keyed by context variant. */
export function buildGroups(family: {
  id: string;
  name: string;
  rows: DevinModelRow[];
}): DevinModelGroup[] {
  const byKey = new Map<string, DevinModelRow[]>();
  for (const row of family.rows) {
    const key = row.contextVariant ?? "";
    const group = byKey.get(key) ?? [];
    group.push(row);
    byKey.set(key, group);
  }
  const single = byKey.size === 1;
  const groups: DevinModelGroup[] = [];
  for (const rows of byKey.values()) {
    // Serving-tier rows share the family's identity and pricing metadata is
    // taken from the standard tier (fast/priority serving costs more).
    const first = rows.find((row) => !row.fast) ?? rows[0];
    const suffix = single || !first?.contextVariant ? "" : `-${first.contextVariant}`;
    const reasoning = rows.some((row) => row.thinking === true || row.effort !== undefined);
    groups.push({
      id: `${family.id}${suffix}`,
      name: `${family.name}${suffix ? ` ${suffix.slice(1).replace(/-/g, " ")}` : ""}`.trim(),
      contextWindow: first?.contextWindow ?? 0,
      cost: first ? { ...first.cost } : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      reasoning,
      rows,
    });
  }
  return groups;
}

/**
 * Rows of one serving tier (`fast` = the priority tier /devin-fast selects);
 * a family without the requested tier falls back to all its rows.
 */
function tierRows(rows: DevinModelRow[], fast: boolean): DevinModelRow[] {
  const tiered = rows.filter((row) => Boolean(row.fast) === fast);
  return tiered.length > 0 ? tiered : rows;
}

/**
 * Resolve a pi thinking level to the group's concrete devin row id, within
 * the requested serving tier.
 * - undefined → the tier's default row;
 * - "off" → a `none` effort row, else an unmarked row, else the default;
 * - an exact effort row wins, then the highest effort at or below the
 *   request, then a binary `-thinking` row, then the lowest effort
 *   available (a request below the floor clamps down, never up to max).
 */
export function resolveDevinModelRow(
  group: DevinModelGroup,
  level: ThinkingLevel | "off" | undefined,
  fast = false,
): DevinModelRow {
  const rows = tierRows(group.rows, fast);
  if (level === undefined) return defaultRow(rows);
  if (level === "off") {
    return (
      rows.find((row) => row.effort === "none") ??
      rows.find((row) => row.effort === undefined && !row.thinking) ??
      defaultRow(rows)
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
  return ranked.at(-1) ?? defaultRow(rows);
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
