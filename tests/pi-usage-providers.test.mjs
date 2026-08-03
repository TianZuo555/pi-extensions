import assert from "node:assert/strict";
import test from "node:test";
import { queryCodexUsage, queryCopilotUsage, queryZaiUsage } from "../packages/pi-usage/lib/providers.ts";
import { formatReport, formatReports, formatStatusline } from "../packages/pi-usage/lib/format.ts";
import { hasProviderLoginInfo } from "../packages/pi-usage/lib/auth.ts";

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

const validZaiUsage = {
  code: 200,
  msg: "Operation successful",
  success: true,
  data: {
    level: "lite",
    limits: [
      {
        type: "TIME_LIMIT",
        unit: 5,
        percentage: 0,
        nextResetTime: 1_785_478_127_985,
        usageDetails: [{ modelCode: "search-prime", usage: 0 }],
      },
      { type: "TOKENS_LIMIT", unit: 3, percentage: 41, nextResetTime: 1_785_226_974_785 },
    ],
  },
};

function jsonResponse(body, status = 200, statusText = "OK") {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { "content-type": "application/json" },
  });
}

function authContext(configured) {
  return {
    modelRegistry: {
      getProviderAuthStatus: () => ({ configured }),
    },
  };
}

test("usage preflight skips a provider with no login information", async () => {
  let queryCalls = 0;
  if (hasProviderLoginInfo(authContext(false), "test-provider")) {
    queryCalls += 1;
  }
  assert.equal(queryCalls, 0);
});

test("usage preflight accepts pi and extension-local login information", () => {
  assert.equal(hasProviderLoginInfo(authContext(true), "test-provider"), true);

  const staleContext = {
    modelRegistry: {
      getProviderAuthStatus: () => {
        throw new Error("stale context");
      },
    },
  };
  assert.equal(hasProviderLoginInfo(staleContext, "test-provider", () => true), true);
  assert.equal(hasProviderLoginInfo(staleContext, "test-provider"), false);
});

test("usage reports omit providers without login information", () => {
  const unconfigured = [
    {
      id: "openai-codex",
      name: "OpenAI Codex",
      status: "unconfigured",
      message: "sign in",
    },
    {
      id: "github-copilot",
      name: "GitHub Copilot",
      status: "unconfigured",
      message: "sign in",
    },
    {
      id: "zai",
      name: "GLM Coding Plan",
      status: "unconfigured",
      message: "sign in",
    },
  ];

  assert.equal(formatReports(unconfigured), "");
  assert.match(
    formatReports([
      ...unconfigured,
      {
        id: "zai",
        name: "GLM Coding Plan",
        status: "ready",
        report: { id: "zai", name: "GLM Coding Plan", windows: [], notes: [] },
      },
    ]),
    /GLM Coding Plan/,
  );
});

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

test("Copilot usage treats a zero-entitlement 100% placeholder as unlimited", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () =>
    jsonResponse({
      copilot_plan: "business",
      token_based_billing: true,
      quota_snapshots: {
        chat: copilotSnapshot(),
        completions: copilotSnapshot(),
        premium_interactions: copilotSnapshot({
          unlimited: false,
          percent_remaining: 100,
          quota_remaining: 0,
          remaining: 0,
          entitlement: 0,
          overage_permitted: true,
        }),
      },
    });

  const report = await queryCopilotUsage("test-token", undefined, 50, 0);
  const premium = report.windows[0];
  assert.equal(premium.unlimited, true);
  assert.equal(premium.remaining, undefined);
  assert.equal(premium.entitlement, undefined);
  assert.equal(formatStatusline(report), "copilot unlimited");

  const body = formatReport({ id: report.id, name: report.name, status: "ready", report });
  assert.match(body, /Premium credits: {2}unlimited/);
  assert.doesNotMatch(body, /0 \/ 0/);
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
  assert.equal(premium.remaining, 7787.9);
  assert.equal(premium.entitlement, 25_000);

  const body = formatReport({ id: report.id, name: report.name, status: "ready", report });
  assert.match(body, /Premium credits: {2}\[.+\] 31% left · 7,788 \/ 25,000 credits/);
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

test("Z.ai usage treats percentage as used and converts ms resets to seconds", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => jsonResponse(validZaiUsage);

  const report = await queryZaiUsage("test-key", undefined, 50, 0);
  assert.equal(report.plan, "lite");

  const tokens = report.windows.find((window) => window.label === "5h tokens");
  assert.equal(tokens?.remainingPercent, 59); // 100 - 41
  assert.equal(tokens?.resetsAt, 1_785_226_975); // ms -> s, rounded

  const body = formatReport({ id: report.id, name: report.name, status: "ready", report });
  assert.match(body, /GLM Coding Plan · Lite/);
  assert.match(body, /5h tokens:/);
  assert.doesNotMatch(body, /MCP tools/);
  assert.equal(formatStatusline(report), "zai 59% 5h");
});

test("Z.ai usage surfaces in-body error messages", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () =>
    jsonResponse({ code: 401, msg: "invalid api key", success: false });

  await assert.rejects(
    queryZaiUsage("test-key", undefined, 50, 0),
    /Z.ai usage error: invalid api key/,
  );
});

test("Z.ai usage skips unknown limit types", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () =>
    jsonResponse({
      ...validZaiUsage,
      data: {
        level: "pro",
        limits: [
          { type: "SOMETHING_NEW", unit: 9, percentage: 50, nextResetTime: 1_785_000_000_000 },
          ...validZaiUsage.data.limits,
        ],
      },
    });

  const report = await queryZaiUsage("test-key", undefined, 50, 0);
  assert.deepEqual(
    report.windows.map((window) => window.label),
    ["5h tokens"],
  );
});
