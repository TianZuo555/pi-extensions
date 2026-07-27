import assert from "node:assert/strict";
import test from "node:test";
import { queryCodexUsage, queryCopilotUsage } from "../packages/pi-usage/lib/providers.ts";
import { formatReport, formatStatusline } from "../packages/pi-usage/lib/format.ts";

const copilotSnapshot = (overrides = {}) => ({
  overage_count: 0,
  overage_permitted: false,
  percent_remaining: 100,
  quota_remaining: 0,
  unlimited: true,
  has_quota: true,
  remaining: 0,
  entitlement: 0,
  ...overrides,
});

const creditBilledCopilotUsage = {
  copilot_plan: "business",
  token_based_billing: true,
  quota_reset_date: "2026-08-01",
  quota_snapshots: {
    chat: copilotSnapshot(),
    completions: copilotSnapshot(),
    premium_interactions: copilotSnapshot({
      percent_remaining: 31.1,
      quota_remaining: 7787.9,
      unlimited: false,
      credits_used: 17_212,
      remaining: 7787,
      entitlement: 25_000,
      overage_permitted: true,
    }),
  },
};

const validCodexUsage = {
  plan_type: "plus",
  rate_limit: {
    primary_window: {
      used_percent: 25,
      limit_window_seconds: 18_000,
      reset_at: 1_800_000_000,
    },
  },
};

function jsonResponse(body, status = 200, statusText = "OK") {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { "content-type": "application/json" },
  });
}

test("Codex usage retries one transient network failure", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) throw new TypeError("temporary network failure");
    return jsonResponse(validCodexUsage);
  };

  const report = await queryCodexUsage("test-token", undefined, 50, 1);
  assert.equal(calls, 2);
  assert.equal(report.plan, "plus");
  assert.equal(report.windows[0]?.remainingPercent, 75);
});

test("Codex usage retries after a per-attempt timeout", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls += 1;
    if (calls === 1) {
      return new Promise((_resolve, reject) => {
        const signal = init?.signal;
        const rejectAbort = () => reject(new DOMException("aborted", "AbortError"));
        if (signal?.aborted) rejectAbort();
        else signal?.addEventListener("abort", rejectAbort, { once: true });
      });
    }
    return jsonResponse(validCodexUsage);
  };

  const report = await queryCodexUsage("test-token", undefined, 5, 1);
  assert.equal(calls, 2);
  assert.equal(report.windows.length, 1);
});

test("Codex usage does not retry authentication failures", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return jsonResponse({ detail: "invalid token" }, 401, "Unauthorized");
  };

  await assert.rejects(
    queryCodexUsage("test-token", undefined, 50, 1),
    /401 Unauthorized/,
  );
  assert.equal(calls, 1);
});

test("Codex usage honors caller cancellation without starting a request", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return jsonResponse(validCodexUsage);
  };

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    queryCodexUsage("test-token", controller.signal, 50, 1),
    (error) => error instanceof Error && error.name === "AbortError",
  );
  assert.equal(calls, 0);
});

test("Copilot usage hides the unmetered chat and completions buckets", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => jsonResponse(creditBilledCopilotUsage);

  const report = await queryCopilotUsage("test-token", undefined, 50, 0);
  assert.deepEqual(
    report.windows.map((window) => window.label),
    ["Premium credits"],
  );
});

test("Copilot usage reports premium quota as credits under token-based billing", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => jsonResponse(creditBilledCopilotUsage);

  const report = await queryCopilotUsage("test-token", undefined, 50, 0);
  const premium = report.windows[0];
  assert.equal(premium.credits, true);
  assert.equal(premium.remaining, 7787);
  assert.equal(premium.entitlement, 25_000);

  const body = formatReport({ id: report.id, name: report.name, status: "ready", report });
  assert.match(body, /Premium credits: {2}\[.+\] 31% left · 7,787 \/ 25,000 credits/);
  assert.doesNotMatch(body, /Chat|Completions/);
  assert.equal(formatStatusline(report), "copilot 31% credits");
});

test("Copilot usage keeps request wording when billing is not credit-based", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () =>
    jsonResponse({ ...creditBilledCopilotUsage, token_based_billing: false });

  const report = await queryCopilotUsage("test-token", undefined, 50, 0);
  assert.equal(report.windows[0].label, "Premium requests");
  assert.equal(report.windows[0].credits, false);
  assert.equal(formatStatusline(report), "copilot 31% premium");
});
