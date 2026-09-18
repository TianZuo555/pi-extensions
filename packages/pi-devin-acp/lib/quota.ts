/**
 * Quota fetch for /devin-usage. ACP has no pull-based quota request, so the
 * report calls the same Connect RPC devin's own /usage uses:
 *
 *   POST {api_server_url}/exa.seat_management_pb.SeatManagementService/GetUserStatus
 *
 * authenticated by the `windsurf_api_key` in devin's credentials file
 * (~/.local/share/devin/credentials.toml). The response's planStatus carries
 * the daily/weekly remaining percents, reset timestamps, and the overage
 * (extra usage) balance that /usage renders.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const GET_USER_STATUS_PATH = "/exa.seat_management_pb.SeatManagementService/GetUserStatus";
const QUOTA_TIMEOUT_MS = 10_000;

export interface DevinCredentials {
  apiKey: string;
  apiServerUrl: string;
}

export interface DevinQuota {
  /** Whole percent of the daily window already consumed (0–100). */
  dailyUsedPercent?: number;
  /** Whole percent of the weekly window already consumed (0–100). */
  weeklyUsedPercent?: number;
  dailyResetAtMs?: number;
  weeklyResetAtMs?: number;
  /** Extra usage balance in USD (overage_balance_micros / 1e6). */
  overageBalanceUsd?: number;
}

export type DevinQuotaResult = { ok: true; quota: DevinQuota } | { ok: false; reason: string };

/**
 * Compact footer text in the pi-usage statusline convention
 * (`provider <remaining>% <window>`): `devin 100% day 81% wk`.
 * Undefined when neither window is reported.
 */
export function formatDevinQuotaStatusline(quota: DevinQuota): string | undefined {
  const parts: string[] = [];
  if (quota.dailyUsedPercent !== undefined) {
    parts.push(`${Math.max(0, 100 - quota.dailyUsedPercent)}% day`);
  }
  if (quota.weeklyUsedPercent !== undefined) {
    parts.push(`${Math.max(0, 100 - quota.weeklyUsedPercent)}% wk`);
  }
  return parts.length > 0 ? `devin ${parts.join(" ")}` : undefined;
}

export interface FetchDevinQuotaOptions {
  /** devin CLI version, sent as ide/extension version (server requires semver). */
  devinVersion?: string;
  credentialsPath?: string;
  env?: NodeJS.ProcessEnv;
  /** Test seam — replace global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Candidate credentials.toml locations, most likely first: the XDG data dir
 * devin uses on POSIX, then the Windows app-data dirs.
 */
export function devinCredentialsPaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const paths = [
    path.join(
      env.XDG_DATA_HOME?.trim() || path.join(os.homedir(), ".local", "share"),
      "devin",
      "credentials.toml",
    ),
  ];
  for (const appData of [env.APPDATA, env.LOCALAPPDATA]) {
    if (appData?.trim()) paths.push(path.join(appData, "devin", "credentials.toml"));
  }
  return [...new Set(paths)];
}

/**
 * Read `windsurf_api_key` / `api_server_url` from the flat credentials file.
 * The file holds only top-level `key = "value"` scalars, so a line parser
 * covers it fully.
 */
export function readDevinCredentials(file: string): DevinCredentials | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch {
    return undefined;
  }
  const values = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/);
    if (match) values.set(match[1], match[2].trim());
  }
  const apiKey = values.get("windsurf_api_key");
  const apiServerUrl = values.get("api_server_url");
  if (!apiKey || !apiServerUrl) return undefined;
  return { apiKey, apiServerUrl };
}

const asNumber = (value: unknown): number | undefined => {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
};

/** planStatus → DevinQuota; absent quota fields stay absent, never zeroed. */
export function parseQuotaResponse(body: unknown): DevinQuota | undefined {
  const status = (body as { userStatus?: { planStatus?: unknown } } | undefined)?.userStatus
    ?.planStatus;
  if (typeof status !== "object" || status === null) return undefined;
  const plan = status as Record<string, unknown>;
  const planInfo = (plan.planInfo ?? {}) as Record<string, unknown>;

  const quota: DevinQuota = {};
  const used = (remaining: unknown): number | undefined => {
    const percent = asNumber(remaining);
    return percent === undefined
      ? undefined
      : Math.round(Math.min(100, Math.max(0, 100 - percent)));
  };

  if (planInfo.hideDailyQuota !== true) {
    quota.dailyUsedPercent = used(plan.dailyQuotaRemainingPercent);
    const reset = asNumber(plan.dailyQuotaResetAtUnix);
    if (reset !== undefined) quota.dailyResetAtMs = reset * 1000;
  }
  if (planInfo.hideWeeklyQuota !== true) {
    quota.weeklyUsedPercent = used(plan.weeklyQuotaRemainingPercent);
    const reset = asNumber(plan.weeklyQuotaResetAtUnix);
    if (reset !== undefined) quota.weeklyResetAtMs = reset * 1000;
  }
  const overage = asNumber(plan.overageBalanceMicros);
  if (overage !== undefined) quota.overageBalanceUsd = overage / 1_000_000;

  return quota;
}

/**
 * Fetch the quota snapshot /usage renders. Never throws: every failure —
 * missing credentials, network, Connect error, malformed body — comes back
 * as `{ ok: false, reason }` so the report can note it and move on.
 */
export async function fetchDevinQuota(
  options: FetchDevinQuotaOptions = {},
): Promise<DevinQuotaResult> {
  const env = options.env ?? process.env;
  const files = options.credentialsPath ? [options.credentialsPath] : devinCredentialsPaths(env);
  const credentials = files.map(readDevinCredentials).find((c) => c !== undefined);
  if (!credentials) return { ok: false, reason: "no devin credentials found" };

  const version = options.devinVersion ?? "0.0.0";
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(`${credentials.apiServerUrl}${GET_USER_STATUS_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", "connect-protocol-version": "1" },
      body: JSON.stringify({
        metadata: {
          apiKey: credentials.apiKey,
          ideName: "devin-cli",
          ideVersion: version,
          extensionName: "devin-cli",
          extensionVersion: version,
        },
      }),
      signal: AbortSignal.timeout(QUOTA_TIMEOUT_MS),
    });
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, reason: `quota response was not JSON (HTTP ${response.status})` };
  }
  const connectError = (body as { code?: string; message?: string } | undefined)?.message;
  if (!response.ok || connectError) {
    return { ok: false, reason: connectError ?? `HTTP ${response.status}` };
  }
  const quota = parseQuotaResponse(body);
  if (!quota) return { ok: false, reason: "no quota data in response" };
  return { ok: true, quota };
}
