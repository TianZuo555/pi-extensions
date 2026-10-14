// Provider usage via magpie (https://github.com/yetone/magpie).
//
// When magpie is installed it already discovers the machine's agent sign-ins —
// Codex's ~/.codex/auth.json, Copilot's keychain item and config.json, the API
// keys it stores for vendors like DeepSeek and Zhipu — and answers quota with
// one entry per account, plan or key balance. Two routes reach that reading:
// GET /v1/magpie/quotas on the local gateway while the app runs (a cached
// snapshot, sub-second), and `magpie quota --json` otherwise (the CLI loads
// every account, several seconds). The gateway is tried first, the CLI next.
// That reading is preferred over pi's own credential: it stays correct when
// magpie routes pi's models through its local gateway (where pi's stored key
// is a gateway placeholder), refreshes OAuth tokens itself, and reports every
// account it knows. When magpie is absent, fails, or has no entry for a
// provider, the caller falls back to the direct provider query.

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProviderReport, UsageWindow } from "./providers.ts";

const QUERY_TIMEOUT_MS = 25_000; // magpie's own vendor timeout is 15s
const GATEWAY_TIMEOUT_MS = 3_000; // a running gateway serves a cached snapshot
const MEMO_TTL_MS = 30_000;
const DEFAULT_GATEWAY_PORT = 3425; // settings.go's DefaultPort

// `magpie` relies on PATH; the rest are the install locations of the script
// installer, Homebrew and the signed macOS app. PI_USAGE_MAGPIE_BIN overrides
// discovery entirely.
const MAGPIE_BINARIES = [
  "magpie",
  path.join(os.homedir(), ".local", "bin", "magpie"),
  "/usr/local/bin/magpie",
  "/opt/homebrew/bin/magpie",
  "/Applications/magpie.app/Contents/MacOS/magpie",
];

/** One `magpie quota --json` entry — see internal/provider/quotas.go. */
export interface MagpieQuota {
  provider?: string;
  plan?: string;
  user?: string;
  alias?: string;
  windows?: MagpieWindow[];
  balance?: string;
  error?: string;
  resets?: { count?: number };
}

export interface MagpieWindow {
  unlimited?: boolean;
  name?: string;
  used?: number;
  /** Percentage of the allowance still remaining (0-100), like `used`. */
  remaining?: number;
  resetsAt?: string; // RFC3339
  /** The vendor's own count, e.g. "1992.3 / 25000" (used / total). */
  display?: string;
  unit?: string;
}

interface MemoEntry {
  startedAt: number;
  settled: boolean;
  promise: Promise<MagpieQuota[]>;
}

let memo: MemoEntry | undefined;
let resolvedBinary: string | undefined;

/**
 * Run `magpie quota --json` once and share the result across providers. A
 * spawn already in flight is always shared; a settled result is reused for
 * MEMO_TTL_MS unless `fresh` asks for a new spawn. Never rejects — magpie
 * being absent or broken just means "no magpie data".
 */
export function queryMagpieQuotas(options: { fresh?: boolean } = {}): Promise<MagpieQuota[]> {
  const now = Date.now();
  if (memo && (!memo.settled || (!options.fresh && now - memo.startedAt < MEMO_TTL_MS))) {
    return memo.promise;
  }
  const entry: MemoEntry = { startedAt: now, settled: false, promise: Promise.resolve([]) };
  entry.promise = collectQuotas()
    .catch(() => [] as MagpieQuota[])
    .finally(() => {
      entry.settled = true;
    });
  memo = entry;
  return entry.promise;
}

async function collectQuotas(): Promise<MagpieQuota[]> {
  const binOverride = process.env.PI_USAGE_MAGPIE_BIN;
  const gatewayOverride = process.env.PI_USAGE_MAGPIE_GATEWAY;
  // Under node --test nothing may hit a real magpie install; explicit
  // PI_USAGE_MAGPIE_* overrides are the only way a test reaches one.
  const underTest = process.execArgv.some((arg) => arg === "--test" || arg.startsWith("--test-"));

  const url = gatewayOverride ?? (underTest ? undefined : gatewayUrl());
  if (url) {
    const quotas = await fetchGatewayQuotas(`${url}/v1/magpie/quotas`);
    if (quotas !== undefined) return quotas;
  }

  if (underTest && !binOverride) return [];
  const candidates = binOverride
    ? [binOverride]
    : resolvedBinary
      ? [resolvedBinary]
      : MAGPIE_BINARIES;
  for (const binary of candidates) {
    if (binary !== "magpie" && !fs.existsSync(binary)) continue;
    const quotas = await runQuota(binary);
    if (quotas === undefined) continue;
    resolvedBinary = binary;
    return quotas;
  }
  return [];
}

/** The gateway's origin: MAGPIE_ADDR, else the port Settings has (3425). */
function gatewayUrl(): string {
  const addr = process.env.MAGPIE_ADDR;
  if (addr) return `http://${addr.startsWith(":") ? `127.0.0.1${addr}` : addr}`;
  return `http://127.0.0.1:${readGatewayPort()}`;
}

function readGatewayPort(): number {
  try {
    const file = path.join(os.homedir(), ".config", "magpie", "settings.json");
    const port = (JSON.parse(fs.readFileSync(file, "utf8")) as { port?: unknown }).port;
    if (typeof port === "number" && port >= 1024 && port <= 65535) return port;
  } catch {
    // No settings file or a malformed one: the default applies.
  }
  return DEFAULT_GATEWAY_PORT;
}

/** Ask the running app for its quota snapshot; undefined when none answers. */
async function fetchGatewayQuotas(url: string): Promise<MagpieQuota[] | undefined> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS) });
    if (!response.ok) return undefined;
    const body: unknown = await response.json();
    const data = Array.isArray(body) ? body : (body as { data?: unknown }).data;
    return Array.isArray(data) ? (data as MagpieQuota[]) : undefined;
  } catch {
    return undefined;
  }
}

function runQuota(binary: string): Promise<MagpieQuota[] | undefined> {
  return new Promise((resolve) => {
    execFile(
      binary,
      ["quota", "--json"],
      { timeout: QUERY_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (_error, stdout) => {
        resolve(parseQuotas(stdout));
      },
    );
  });
}

function parseQuotas(stdout: string): MagpieQuota[] | undefined {
  // Be liberal: a stray warning line before the array must not lose the data.
  const start = stdout.indexOf("[");
  const end = stdout.lastIndexOf("]");
  if (start === -1 || end <= start) return undefined;
  try {
    const parsed: unknown = JSON.parse(stdout.slice(start, end + 1));
    return Array.isArray(parsed) ? (parsed as MagpieQuota[]) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Normalize magpie's quota entries for one provider into a ProviderReport, or
 * undefined when magpie has no usable entry (callers then fall back to the
 * direct query). Several magpie accounts under one provider merge into a
 * single report with the account name prefixed to each window.
 */
export function magpieReport(
  spec: { id: string; name: string; magpieId: string },
  quotas: readonly MagpieQuota[],
): ProviderReport | undefined {
  const entries = quotas.filter((quota) => quota.provider === spec.magpieId && hasData(quota));
  if (entries.length === 0) return undefined;

  const multi = entries.length > 1;
  const windows: UsageWindow[] = [];
  const notes: string[] = [];
  const plans = new Set<string>();
  for (const quota of entries) {
    if (quota.plan) plans.add(quota.plan);
    const who = quota.alias || quota.user;
    if (who && !multi) notes.push(`Account: ${who}`);
    windows.push(...quotaWindows(quota, multi ? who : undefined));
    const balance = parseBalance(quota.balance);
    if (balance) {
      windows.push(multi && who ? { ...balance, label: `${who} · ${balance.label}` } : balance);
    }
    if (quota.resets?.count) notes.push(`Rate-limit resets: ${quota.resets.count}`);
  }

  return {
    id: spec.id,
    name: spec.name,
    plan: [...plans].join(", ") || undefined,
    windows,
    notes,
  };
}

function hasData(quota: MagpieQuota): boolean {
  return Boolean(
    (quota.windows ?? []).some((window) => window.name) || parseBalance(quota.balance),
  );
}

function quotaWindows(quota: MagpieQuota, prefix: string | undefined): UsageWindow[] {
  const all = (quota.windows ?? []).filter((window) => window.name);
  // Unmetered buckets (Copilot's chat/completions) add noise next to a metered
  // window, but are the only information on a fully unmetered plan.
  const windows = all.some((window) => !window.unlimited)
    ? all.filter((window) => !window.unlimited)
    : all;
  return windows.map((window) => {
    const label = prefix ? `${prefix} · ${window.name}` : (window.name as string);
    const result: UsageWindow = {
      label,
      unlimited: window.unlimited || undefined,
      credits: window.unit === "credits" || undefined,
    };
    if (window.unlimited) return result;
    if (typeof window.remaining === "number" && Number.isFinite(window.remaining)) {
      result.remainingPercent = Math.min(100, Math.max(0, window.remaining));
    }
    const used = parseUsedOf(window.display);
    if (used) {
      result.entitlement = used.total;
      result.remaining = Math.max(0, used.total - used.used);
    }
    if (window.resetsAt) {
      const resetsAt = Date.parse(window.resetsAt);
      if (!Number.isNaN(resetsAt)) result.resetsAt = Math.round(resetsAt / 1000);
    }
    return result;
  });
}

/** Parse magpie's `display` "used / total" counts, with k/M suffixes. */
function parseUsedOf(display: string | undefined): { used: number; total: number } | undefined {
  const match = display?.trim().match(/^([\d.,]+)\s*([kKmM])?\s*\/\s*([\d.,]+)\s*([kKmM])?$/);
  if (!match) return undefined;
  const used = scaled(match[1], match[2]);
  const total = scaled(match[3], match[4]);
  if (used === undefined || total === undefined || total <= 0) return undefined;
  return { used, total };
}

function scaled(digits: string, suffix: string | undefined): number | undefined {
  const value = Number(digits.replace(/,/g, ""));
  if (!Number.isFinite(value)) return undefined;
  const factor = suffix?.toLowerCase() === "k" ? 1e3 : suffix?.toLowerCase() === "m" ? 1e6 : 1;
  return value * factor;
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  "¥": "CNY",
  "￥": "CNY",
  $: "USD",
  "€": "EUR",
  "£": "GBP",
};

/** Parse magpie's balance string ("¥16.82", "$5.00", "16.82 CNY") into a window. */
function parseBalance(balance: string | undefined): UsageWindow | undefined {
  const text = balance?.trim();
  if (!text) return undefined;
  const match = text.match(/^([^\d\s]+)?\s*([\d,]+(?:\.\d+)?)\s*([A-Za-z]{3})?$/);
  if (!match) return undefined;
  const amount = Number(match[2].replace(/,/g, ""));
  if (!Number.isFinite(amount)) return undefined;
  const currency = match[3]?.toUpperCase() ?? (match[1] ? CURRENCY_SYMBOLS[match[1]] : undefined);
  if (!currency) return undefined;
  return { label: "Balance", remaining: amount, currency };
}
