// Provider queries and normalization for Codex, GitHub Copilot, Z.ai (global
// and China), DeepSeek, and Xiaomi MiMo usage.
//
// Each provider is normalized into a small, presentation-friendly `ProviderReport`
// so the formatter does not need to know provider-specific JSON shapes.
// HTTP fetch/retry lives in `src/fetch.ts` (Effect v4).

import { Data, Effect } from "effect";
import {
  DEFAULT_RETRY_COUNT,
  DEFAULT_TIMEOUT_MS,
  fetchProviderJsonEffect,
  ProviderQueryError,
} from "../src/fetch.ts";

export const CODEX_PROVIDER_ID = "openai-codex";
export const COPILOT_PROVIDER_ID = "github-copilot";
export const ZAI_PROVIDER_ID = "zai";
export const ZAI_CN_PROVIDER_ID = "zai-coding-cn";
export const DEEPSEEK_PROVIDER_ID = "deepseek";
export const XIAOMI_PROVIDER_ID = "xiaomi";

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const COPILOT_USAGE_URL = "https://api.github.com/copilot_internal/user";
const ZAI_QUOTA_URL = "https://api.z.ai/api/monitor/usage/quota/limit";
const ZAI_CN_QUOTA_URL = "https://open.bigmodel.cn/api/monitor/usage/quota/limit";
const DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance";
const XIAOMI_BALANCE_URL = "https://platform.xiaomimimo.com/api/v1/balance";

// Copilot's internal endpoint expects the editor client headers plus a REST API
// version. Values mirror the GitHub Copilot chat client.
const COPILOT_HEADERS: Record<string, string> = {
  "Editor-Version": "vscode/1.104.0",
  "Editor-Plugin-Version": "copilot-chat/0.30.0",
  "Copilot-Integration-Id": "vscode-chat",
  "X-GitHub-Api-Version": "2025-04-01",
};

/** One usage window/bucket, already normalized for display. */
export interface UsageWindow {
  label: string;
  /** Percentage of the allowance still remaining (0-100). */
  remainingPercent?: number;
  /** Absolute remaining and total allowance, when the provider reports them. */
  remaining?: number;
  entitlement?: number;
  /** True when the allowance is unmetered. */
  unlimited?: boolean;
  /** True when the allowance is denominated in credits rather than requests. */
  credits?: boolean;
  /** Reset time as epoch seconds (Codex) — rendered as a clock/date. */
  resetsAt?: number;
  /** Currency code for a monetary balance (e.g. "CNY") — rendered with the amount. */
  currency?: string;
}

export interface ProviderReport {
  id: string;
  name: string;
  plan?: string;
  windows: UsageWindow[];
  notes: string[];
}

export class ProviderNormalizationError extends Data.TaggedError("ProviderNormalizationError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

export type ProviderQueryFailure = ProviderQueryError | ProviderNormalizationError | Error;

/** Run fetch then normalization; normalizer throws become typed Effect failures. */
function queryFromFetch(
  fetchEffect: Effect.Effect<Record<string, unknown>, ProviderQueryError | Error>,
  normalize: (data: Record<string, unknown>) => ProviderReport,
): Effect.Effect<ProviderReport, ProviderQueryFailure> {
  return Effect.gen(function* () {
    const data = yield* fetchEffect;
    return yield* Effect.try({
      try: () => normalize(data),
      catch: (cause) =>
        new ProviderNormalizationError({
          message: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    });
  });
}

function runQueryPromise(
  effect: Effect.Effect<ProviderReport, ProviderQueryFailure>,
  signal?: AbortSignal,
): Promise<ProviderReport> {
  return Effect.runPromise(effect, signal ? { signal } : undefined);
}

export function queryCodexUsageEffect(
  token: string,
  signal?: AbortSignal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retryCount = DEFAULT_RETRY_COUNT,
): Effect.Effect<ProviderReport, ProviderQueryFailure> {
  return queryFromFetch(
    fetchProviderJsonEffect(
      CODEX_USAGE_URL,
      token,
      { "User-Agent": "pi-usage" },
      signal,
      timeoutMs,
      retryCount,
      token,
    ),
    normalizeCodexReport,
  );
}

export async function queryCodexUsage(
  token: string,
  signal?: AbortSignal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retryCount = DEFAULT_RETRY_COUNT,
): Promise<ProviderReport> {
  return runQueryPromise(queryCodexUsageEffect(token, signal, timeoutMs, retryCount), signal);
}

function normalizeCodexReport(data: Record<string, unknown>): ProviderReport {
  const windows: UsageWindow[] = [];
  const rateLimit = asObject(data.rate_limit);
  addCodexWindow(windows, "5h", rateLimit?.primary_window);
  addCodexWindow(windows, "Weekly", rateLimit?.secondary_window);

  const notes: string[] = [];
  const credits = asObject(data.credits);
  if (credits?.has_credits === true) {
    if (credits.unlimited === true) notes.push("Credits: unlimited");
    else {
      const balance = asNumber(credits.balance);
      notes.push(balance !== undefined ? `Credits: ${balance}` : "Credits: available");
    }
  }

  if (windows.length === 0 && notes.length === 0) {
    throw new Error("Codex usage endpoint returned no displayable data.");
  }

  return {
    id: CODEX_PROVIDER_ID,
    name: "OpenAI Codex",
    plan: asString(data.plan_type),
    windows,
    notes,
  };
}

function addCodexWindow(windows: UsageWindow[], fallbackLabel: string, raw: unknown): void {
  const value = asObject(raw);
  if (!value) return;
  const used = asNumber(value.used_percent);
  if (used === undefined) return;
  const seconds = asNumber(value.limit_window_seconds);
  windows.push({
    label: `${seconds ? windowLabel(seconds) : fallbackLabel} limit`,
    remainingPercent: clampPercent(100 - used),
    resetsAt: asNumber(value.reset_at),
  });
}

function windowLabel(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes % 10_080 === 0) return minutes / 10_080 === 1 ? "Weekly" : `${minutes / 10_080}-week`;
  if (minutes % 1_440 === 0) return minutes / 1_440 === 1 ? "Daily" : `${minutes / 1_440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

// --- GitHub Copilot ---------------------------------------------------------

const COPILOT_SNAPSHOT_LABELS: Record<string, string> = {
  premium_interactions: "Premium requests",
};
// Copilot bills premium interactions as *credits* once the account is on
// token-based billing (`token_based_billing: true`), so the same snapshot has to
// be labelled differently depending on the plan.
const COPILOT_CREDIT_LABELS: Record<string, string> = {
  premium_interactions: "Premium credits",
};
const COPILOT_SNAPSHOT_ORDER = ["premium_interactions"];
// Seat-based buckets that carry no quota worth showing (they are unmetered on
// every paid plan and pi never spends them).
const COPILOT_HIDDEN_SNAPSHOTS = new Set(["chat", "completions"]);

export function queryCopilotUsageEffect(
  token: string,
  signal?: AbortSignal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retryCount = DEFAULT_RETRY_COUNT,
): Effect.Effect<ProviderReport, ProviderQueryFailure> {
  return queryFromFetch(
    fetchProviderJsonEffect(
      COPILOT_USAGE_URL,
      token,
      { ...COPILOT_HEADERS, "User-Agent": "GitHubCopilotChat/0.30.0" },
      signal,
      timeoutMs,
      retryCount,
      token,
    ),
    normalizeCopilotReport,
  );
}

export async function queryCopilotUsage(
  token: string,
  signal?: AbortSignal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retryCount = DEFAULT_RETRY_COUNT,
): Promise<ProviderReport> {
  return runQueryPromise(queryCopilotUsageEffect(token, signal, timeoutMs, retryCount), signal);
}

function normalizeCopilotReport(data: Record<string, unknown>): ProviderReport {
  const snapshots = asObject(data.quota_snapshots) ?? {};
  if (Object.keys(snapshots).length === 0) {
    throw new Error("Copilot usage endpoint returned no quota snapshots.");
  }

  const creditBilled = data.token_based_billing === true;
  const windows: UsageWindow[] = [];
  const seen = new Set<string>();
  for (const key of [...COPILOT_SNAPSHOT_ORDER, ...Object.keys(snapshots)]) {
    if (seen.has(key)) continue;
    seen.add(key);
    if (COPILOT_HIDDEN_SNAPSHOTS.has(key)) continue;
    const snapshot = asObject(snapshots[key]);
    if (!snapshot) continue;
    const remaining = asNumber(snapshot.quota_remaining) ?? asNumber(snapshot.remaining);
    const entitlement = asNumber(snapshot.entitlement);
    const unlimited =
      snapshot.unlimited === true ||
      (remaining === 0 && entitlement === 0 && asNumber(snapshot.percent_remaining) === 100);
    windows.push({
      label: copilotSnapshotLabel(key, creditBilled),
      unlimited,
      remainingPercent: unlimited ? undefined : asNumber(snapshot.percent_remaining),
      remaining: unlimited ? undefined : remaining,
      entitlement: unlimited ? undefined : entitlement,
      credits: creditBilled,
    });
  }

  const notes: string[] = [];
  if (windows.length === 0) notes.push("No metered quotas reported.");
  const resetDate = asString(data.quota_reset_date) ?? asString(data.quota_reset_date_utc);
  if (resetDate) notes.push(`Quota resets: ${resetDate.slice(0, 10)}`);

  return {
    id: COPILOT_PROVIDER_ID,
    name: "GitHub Copilot",
    plan: asString(data.copilot_plan),
    windows,
    notes,
  };
}

function copilotSnapshotLabel(key: string, creditBilled: boolean): string {
  if (creditBilled && COPILOT_CREDIT_LABELS[key]) return COPILOT_CREDIT_LABELS[key];
  return COPILOT_SNAPSHOT_LABELS[key] ?? titleCase(key);
}

// --- Z.ai (GLM Coding Plan) ------------------------------------------------

// Z.ai reports the GLM Coding Plan quota at api.z.ai (and the China variant at
// open.bigmodel.cn). The body is
// { code, msg, data: { level, limits: [...] }, success }. Each limit carries a
// `percentage` = the share of the allowance already *used* (so remaining is
// 100 - percentage) and a `nextResetTime` in epoch *milliseconds* — unlike
// Codex's seconds, which is why we divide before handing it to the formatter.
// The global endpoint types its token windows TOKENS_LIMIT while the China
// endpoint reports them as CREDIT_LIMIT with absolute amounts in `usage`
// (total), `currentValue` (used) and `remaining`; both encode the window in
// `unit`/`number` (3 = hourly, 6 = weekly). The tool/MCP allowance
// (TIME_LIMIT) and any other windows Z.ai returns are intentionally ignored.
function zaiLimitLabel(limit: Record<string, unknown>): string | undefined {
  const type = asString(limit.type);
  const unit = asNumber(limit.unit);
  const count = asNumber(limit.number) ?? 1;
  if (type === "TOKENS_LIMIT") {
    // The original TOKENS_LIMIT responses carried no unit and were always the
    // five-hour pool, so anything non-weekly keeps the historical label.
    return unit === 6 ? (count === 1 ? "Weekly tokens" : `${count}-week tokens`) : "5h tokens";
  }
  if (type === "CREDIT_LIMIT") {
    if (unit === 3) return `${count}h credits`;
    if (unit === 6) return count === 1 ? "Weekly credits" : `${count}-week credits`;
  }
  return undefined;
}

export function queryZaiUsageEffect(
  token: string,
  signal?: AbortSignal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retryCount = DEFAULT_RETRY_COUNT,
): Effect.Effect<ProviderReport, ProviderQueryFailure> {
  return queryFromFetch(
    fetchProviderJsonEffect(
      ZAI_QUOTA_URL,
      token,
      { "User-Agent": "pi-usage" },
      signal,
      timeoutMs,
      retryCount,
      token,
    ),
    normalizeZaiReport,
  );
}

export async function queryZaiUsage(
  token: string,
  signal?: AbortSignal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retryCount = DEFAULT_RETRY_COUNT,
): Promise<ProviderReport> {
  return runQueryPromise(queryZaiUsageEffect(token, signal, timeoutMs, retryCount), signal);
}

function normalizeZaiReport(
  data: Record<string, unknown>,
  id: string = ZAI_PROVIDER_ID,
  name = "GLM Coding Plan",
): ProviderReport {
  const payload = asObject(data.data);
  if (!payload) {
    const msg = asString(data.msg);
    throw new Error(
      msg ? `Z.ai usage error: ${msg}` : "Z.ai usage endpoint returned no displayable data.",
    );
  }

  const limits = Array.isArray(payload.limits) ? payload.limits : [];
  const windows: UsageWindow[] = [];
  for (const entry of limits) {
    const limit = asObject(entry);
    if (!limit) continue;
    const label = zaiLimitLabel(limit);
    const used = asNumber(limit.percentage);
    // Skip limits we cannot label (e.g. a plan tier exposes an extra window we
    // don't yet name) rather than showing a confusing raw key.
    if (!label || used === undefined) continue;
    const resetsAtMs = asNumber(limit.nextResetTime);
    windows.push({
      label,
      remainingPercent: clampPercent(100 - used),
      remaining: asNumber(limit.remaining),
      entitlement: asNumber(limit.usage),
      credits: asString(limit.type) === "CREDIT_LIMIT" || undefined,
      resetsAt: resetsAtMs !== undefined ? Math.round(resetsAtMs / 1000) : undefined,
    });
  }

  if (windows.length === 0) {
    throw new Error("Z.ai usage endpoint returned no displayable data.");
  }

  return {
    id,
    name,
    plan: asString(payload.level),
    windows,
    notes: [],
  };
}

/** Query the domestic BigModel.cn GLM Coding Plan quota endpoint. */
export function queryZaiCnUsageEffect(
  token: string,
  signal?: AbortSignal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retryCount = DEFAULT_RETRY_COUNT,
): Effect.Effect<ProviderReport, ProviderQueryFailure> {
  return queryFromFetch(
    fetchProviderJsonEffect(
      ZAI_CN_QUOTA_URL,
      token,
      {
        // The domestic quota endpoint expects the raw API key, unlike the
        // OpenAI-compatible model endpoint and the international monitor API.
        Authorization: token,
        "Accept-Language": "en-US,en",
        "Content-Type": "application/json",
        "User-Agent": "pi-usage",
      },
      signal,
      timeoutMs,
      retryCount,
      token,
    ),
    (data) => normalizeZaiReport(data, ZAI_CN_PROVIDER_ID, "GLM Coding Plan (China)"),
  );
}

export async function queryZaiCnUsage(
  token: string,
  signal?: AbortSignal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retryCount = DEFAULT_RETRY_COUNT,
): Promise<ProviderReport> {
  return runQueryPromise(queryZaiCnUsageEffect(token, signal, timeoutMs, retryCount), signal);
}

// --- DeepSeek ---------------------------------------------------------------

// DeepSeek reports the account's money balance at api.deepseek.com/user/balance.
// The body is { is_available, balance_infos: [{ currency, total_balance,
// granted_balance, topped_up_balance }] }. Balances are decimal strings;
// granted balance is the not-yet-expired promotional credit and topped-up
// balance the prepaid amount — API fees draw from granted first, then topped
// up. Unlike the other providers there is no usage window or percentage, so
// the total balance is surfaced as a single monetary window.
export function queryDeepSeekUsageEffect(
  token: string,
  signal?: AbortSignal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retryCount = DEFAULT_RETRY_COUNT,
): Effect.Effect<ProviderReport, ProviderQueryFailure> {
  return queryFromFetch(
    fetchProviderJsonEffect(
      DEEPSEEK_BALANCE_URL,
      token,
      { "User-Agent": "pi-usage" },
      signal,
      timeoutMs,
      retryCount,
      token,
    ),
    normalizeDeepSeekReport,
  );
}

export async function queryDeepSeekUsage(
  token: string,
  signal?: AbortSignal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retryCount = DEFAULT_RETRY_COUNT,
): Promise<ProviderReport> {
  return runQueryPromise(queryDeepSeekUsageEffect(token, signal, timeoutMs, retryCount), signal);
}

function normalizeDeepSeekReport(data: Record<string, unknown>): ProviderReport {
  const infos = Array.isArray(data.balance_infos) ? data.balance_infos : [];
  const windows: UsageWindow[] = [];
  const notes: string[] = [];
  for (const entry of infos) {
    const info = asObject(entry);
    if (!info) continue;
    const currency = asString(info.currency);
    if (!currency) continue;
    const total = asNumber(info.total_balance);
    if (total !== undefined) {
      windows.push({ label: "Balance", remaining: total, currency });
    }
    const granted = asNumber(info.granted_balance);
    if (granted !== undefined && granted > 0) {
      notes.push(`Granted: ${formatMoney(granted, currency)}`);
    }
    const toppedUp = asNumber(info.topped_up_balance);
    if (toppedUp !== undefined && toppedUp > 0) {
      notes.push(`Topped up: ${formatMoney(toppedUp, currency)}`);
    }
  }
  if (data.is_available === false) {
    notes.push("Balance insufficient for API calls");
  }

  if (windows.length === 0 && notes.length === 0) {
    throw new Error("DeepSeek balance endpoint returned no displayable data.");
  }

  return {
    id: DEEPSEEK_PROVIDER_ID,
    name: "DeepSeek",
    windows,
    notes,
  };
}

// --- Xiaomi MiMo -----------------------------------------------------------

// Xiaomi MiMo's pay-as-you-go balance lives on the web console API
// (platform.xiaomimimo.com/api/v1/balance), which authenticates with Xiaomi
// account session cookies — the `sk-` model API key is rejected with an SSO
// login redirect and cannot query balance. The body is { code, message, data:
// { balance, cashBalance, giftBalance, frozenBalance, currency, ... } } with
// decimal-string money fields: `balance` is the total the API draws from,
// `giftBalance` the promotional credit, and `cashBalance` the prepaid cash.
// Like DeepSeek there is no usage window or percentage, so the total balance
// is surfaced as a single monetary window.
export function queryXiaomiUsageEffect(
  cookie: string,
  signal?: AbortSignal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retryCount = DEFAULT_RETRY_COUNT,
): Effect.Effect<ProviderReport, ProviderQueryFailure> {
  return queryFromFetch(
    fetchProviderJsonEffect(
      XIAOMI_BALANCE_URL,
      "",
      { Cookie: cookie, "User-Agent": "pi-usage" },
      signal,
      timeoutMs,
      retryCount,
      cookie,
    ),
    normalizeXiaomiReport,
  ).pipe(
    Effect.mapError((error) =>
      (error instanceof ProviderQueryError && error.status === 401) ||
      (error instanceof ProviderNormalizationError && /returned code 401\b/.test(error.message))
        ? new ProviderQueryError({
            message:
              "MiMo console session expired (401). Sign in at https://platform.xiaomimimo.com/console/balance, then run /usage-mimo-sync to import your browser session or update xiaomi-console manually.",
            status: 401,
            retryable: false,
          })
        : error,
    ),
  );
}

export async function queryXiaomiUsage(
  cookie: string,
  signal?: AbortSignal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retryCount = DEFAULT_RETRY_COUNT,
): Promise<ProviderReport> {
  return runQueryPromise(queryXiaomiUsageEffect(cookie, signal, timeoutMs, retryCount), signal);
}

function normalizeXiaomiReport(data: Record<string, unknown>): ProviderReport {
  const code = asNumber(data.code);
  if (code !== undefined && code !== 0) {
    throw new Error(`Xiaomi balance endpoint returned code ${code}.`);
  }
  const payload = asObject(data.data) ?? {};
  const windows: UsageWindow[] = [];
  const notes: string[] = [];
  const currency = asString(payload.currency) ?? "CNY";
  const total = asNumber(payload.balance);
  if (total !== undefined) {
    windows.push({ label: "Balance", remaining: total, currency });
  }
  const gift = asNumber(payload.giftBalance);
  if (gift !== undefined && gift > 0) {
    notes.push(`Granted: ${formatMoney(gift, currency)}`);
  }
  const cash = asNumber(payload.cashBalance);
  if (cash !== undefined && cash > 0) {
    notes.push(`Topped up: ${formatMoney(cash, currency)}`);
  }
  if (total !== undefined && total <= 0) {
    notes.push("Balance insufficient for API calls");
  }

  if (windows.length === 0 && notes.length === 0) {
    throw new Error("Xiaomi balance endpoint returned no displayable data.");
  }

  return {
    id: XIAOMI_PROVIDER_ID,
    name: "Xiaomi MiMo",
    windows,
    notes,
  };
}

/** Format a monetary amount with its currency symbol (used across notes and rendering). */
export function formatMoney(value: number, currency: string): string {
  const amount = value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  if (currency === "CNY") return `¥${amount}`;
  if (currency === "USD") return `$${amount}`;
  return `${amount} ${currency}`;
}

// --- small value helpers ----------------------------------------------------

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function titleCase(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .trim();
}
