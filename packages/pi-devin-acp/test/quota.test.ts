import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  devinCredentialsPaths,
  fetchDevinQuota,
  formatDevinQuotaStatusline,
  parseQuotaResponse,
  readDevinCredentials,
} from "../lib/quota.ts";

function tempCredentials(text: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devin-quota-"));
  const file = path.join(dir, "credentials.toml");
  fs.writeFileSync(file, text);
  return file;
}

const PLAN_STATUS = {
  planInfo: { billingStrategy: "BILLING_STRATEGY_QUOTA" },
  dailyQuotaRemainingPercent: 100,
  weeklyQuotaRemainingPercent: 81,
  overageBalanceMicros: "10000000",
  dailyQuotaResetAtUnix: "1789804800",
  weeklyQuotaResetAtUnix: "1789891200",
};

function stubFetch(body: unknown, init?: { ok?: boolean; status?: number }) {
  const calls: { url: string; body: string }[] = [];
  const fetchImpl = (async (url: string | URL, options: { body?: string }) => {
    calls.push({ url: String(url), body: String(options.body) });
    return {
      ok: init?.ok ?? true,
      status: init?.status ?? 200,
      json: async () => body,
    };
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

test("readDevinCredentials parses flat scalars", () => {
  const file = tempCredentials(
    'windsurf_api_key = "key-123"\napi_server_url = "https://server.example.com"\ndevin_api_url = "https://api.example.com"\n',
  );
  assert.deepEqual(readDevinCredentials(file), {
    apiKey: "key-123",
    apiServerUrl: "https://server.example.com",
  });
});

test("readDevinCredentials is undefined when file or fields are missing", () => {
  assert.equal(readDevinCredentials("/nonexistent/credentials.toml"), undefined);
  const noKey = tempCredentials('api_server_url = "https://server.example.com"\n');
  assert.equal(readDevinCredentials(noKey), undefined);
});

test("devinCredentialsPaths honors XDG_DATA_HOME and app-data fallbacks", () => {
  assert.deepEqual(devinCredentialsPaths({ XDG_DATA_HOME: "/data" }), [
    path.join("/data", "devin", "credentials.toml"),
  ]);
  assert.deepEqual(devinCredentialsPaths({ APPDATA: "/roam", LOCALAPPDATA: "/roam" }), [
    path.join(os.homedir(), ".local", "share", "devin", "credentials.toml"),
    path.join("/roam", "devin", "credentials.toml"),
  ]);
});

test("parseQuotaResponse maps planStatus fields", () => {
  const quota = parseQuotaResponse({ userStatus: { planStatus: PLAN_STATUS } });
  assert.deepEqual(quota, {
    dailyUsedPercent: 0,
    weeklyUsedPercent: 19,
    dailyResetAtMs: 1789804800000,
    weeklyResetAtMs: 1789891200000,
    overageBalanceUsd: 10,
  });
});

test("parseQuotaResponse clamps and skips hidden or absent fields", () => {
  const quota = parseQuotaResponse({
    userStatus: {
      planStatus: {
        planInfo: { hideDailyQuota: true },
        dailyQuotaRemainingPercent: 150,
        weeklyQuotaRemainingPercent: -10,
      },
    },
  });
  assert.equal(quota?.dailyUsedPercent, undefined);
  assert.equal(quota?.dailyResetAtMs, undefined);
  assert.equal(quota?.weeklyUsedPercent, 100);
  assert.equal(quota?.overageBalanceUsd, undefined);
});

test("parseQuotaResponse is undefined without planStatus", () => {
  assert.equal(parseQuotaResponse({}), undefined);
  assert.equal(parseQuotaResponse({ userStatus: {} }), undefined);
});

test("fetchDevinQuota posts Connect metadata and parses the response", async () => {
  const file = tempCredentials(
    'windsurf_api_key = "key-123"\napi_server_url = "https://server.example.com"\n',
  );
  const { fetchImpl, calls } = stubFetch({ userStatus: { planStatus: PLAN_STATUS } });
  const result = await fetchDevinQuota({
    credentialsPath: file,
    devinVersion: "3000.10.27",
    fetchImpl,
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.quota.weeklyUsedPercent, 19);
    assert.equal(result.quota.overageBalanceUsd, 10);
  }
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    "https://server.example.com/exa.seat_management_pb.SeatManagementService/GetUserStatus",
  );
  const sent = JSON.parse(calls[0].body);
  assert.deepEqual(sent.metadata, {
    apiKey: "key-123",
    ideName: "devin-cli",
    ideVersion: "3000.10.27",
    extensionName: "devin-cli",
    extensionVersion: "3000.10.27",
  });
});

test("fetchDevinQuota reports missing credentials and server errors", async () => {
  const noCreds = await fetchDevinQuota({ credentialsPath: "/nonexistent/credentials.toml" });
  assert.deepEqual(noCreds, { ok: false, reason: "no devin credentials found" });

  const file = tempCredentials(
    'windsurf_api_key = "key-123"\napi_server_url = "https://server.example.com"\n',
  );
  const { fetchImpl } = stubFetch(
    { code: "unauthenticated", message: "bad api key" },
    { ok: false, status: 401 },
  );
  const denied = await fetchDevinQuota({ credentialsPath: file, fetchImpl });
  assert.deepEqual(denied, { ok: false, reason: "bad api key" });

  const failing = (async () => {
    throw new Error("offline");
  }) as unknown as typeof fetch;
  const offline = await fetchDevinQuota({ credentialsPath: file, fetchImpl: failing });
  assert.deepEqual(offline, { ok: false, reason: "offline" });
});

test("formatDevinQuotaStatusline renders remaining percents like pi-usage", () => {
  assert.equal(
    formatDevinQuotaStatusline({ dailyUsedPercent: 0, weeklyUsedPercent: 19 }),
    "devin 100% day 81% wk",
  );
  // Single-window plans render just that window.
  assert.equal(formatDevinQuotaStatusline({ weeklyUsedPercent: 42 }), "devin 58% wk");
  assert.equal(formatDevinQuotaStatusline({ dailyUsedPercent: 99 }), "devin 1% day");
  // An exhausted window floors at 0%, never negative.
  assert.equal(
    formatDevinQuotaStatusline({ dailyUsedPercent: 100, weeklyUsedPercent: 100 }),
    "devin 0% day 0% wk",
  );
  // No reported windows leaves the footer empty.
  assert.equal(formatDevinQuotaStatusline({}), undefined);
  assert.equal(formatDevinQuotaStatusline({ overageBalanceUsd: 10 }), undefined);
});
