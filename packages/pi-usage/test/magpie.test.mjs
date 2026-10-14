import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { magpieReport, queryMagpieQuotas } from "../lib/magpie.ts";
import { formatReport, formatStatusline } from "../lib/format.ts";

const codexSpec = { id: "openai-codex", name: "OpenAI Codex", magpieId: "codex" };
const copilotSpec = { id: "github-copilot", name: "GitHub Copilot", magpieId: "copilot" };
const zaiCnSpec = { id: "zai-coding-cn", name: "GLM Coding Plan (China)", magpieId: "zhipu" };
const deepseekSpec = { id: "deepseek", name: "DeepSeek", magpieId: "deepseek" };

test("magpie Codex quota maps windows, account and resets", () => {
  const report = magpieReport(codexSpec, [
    {
      provider: "codex",
      plan: "plus",
      user: "a@example.com",
      windows: [
        { name: "5 hours", used: 12, remaining: 88, resetsAt: "2026-10-14T19:38:15+08:00" },
        { name: "7 days", used: 16, remaining: 84 },
      ],
      resets: { count: 3 },
    },
  ]);

  assert.equal(report.plan, "plus");
  assert.deepEqual(
    report.windows.map((w) => [w.label, w.remainingPercent]),
    [
      ["5 hours", 88],
      ["7 days", 84],
    ],
  );
  assert.equal(
    report.windows[0].resetsAt,
    Math.round(Date.parse("2026-10-14T19:38:15+08:00") / 1000),
  );
  assert.deepEqual(report.notes, ["Account: a@example.com", "Rate-limit resets: 3"]);
  assert.equal(formatStatusline(report), "codex 88% 5h 84% 7d");
});

test("magpie Copilot quota drops unmetered buckets and reads used/total display", () => {
  const report = magpieReport(copilotSpec, [
    {
      provider: "copilot",
      plan: "Business",
      user: "someone",
      windows: [
        {
          name: "Premium requests",
          used: 7.97,
          remaining: 92.03,
          resetsAt: "2026-11-01T00:00:00Z",
          display: "1992.3 / 25000",
        },
        { unlimited: true, name: "Chat requests", used: 0, remaining: 100 },
        { unlimited: true, name: "Completions", used: 0, remaining: 100 },
      ],
    },
  ]);

  assert.equal(report.windows.length, 1);
  const premium = report.windows[0];
  assert.equal(premium.label, "Premium requests");
  assert.equal(premium.remainingPercent, 92.03);
  assert.equal(premium.entitlement, 25_000);
  assert.equal(premium.remaining, 25_000 - 1992.3);
  assert.equal(formatStatusline(report), "copilot 92% premium");
});

test("magpie quota keeps all-unlimited windows when nothing is metered", () => {
  const report = magpieReport(copilotSpec, [
    {
      provider: "copilot",
      plan: "free",
      windows: [{ unlimited: true, name: "Chat requests", remaining: 100 }],
    },
  ]);
  assert.equal(report.windows[0].unlimited, true);
  assert.equal(formatStatusline(report), "copilot unlimited");
});

test("magpie Zhipu quota feeds the GLM China statusline", () => {
  const report = magpieReport(zaiCnSpec, [
    {
      provider: "zhipu",
      plan: "lite",
      windows: [
        { name: "MCP · Month", used: 4, remaining: 96 },
        { name: "5 hours", used: 3, remaining: 97, resetsAt: "2026-10-14T21:00:00+08:00" },
      ],
    },
  ]);
  assert.equal(report.plan, "lite");
  assert.equal(report.windows.length, 2);
  assert.equal(formatStatusline(report), "zai-cn 97% 5h");
});

test("magpie balance strings map to the provider currency", () => {
  for (const [balance, currency, amount] of [
    ["¥16.82", "CNY", 16.82],
    ["$5.00", "USD", 5],
    ["16.82 CNY", "CNY", 16.82],
  ]) {
    const report = magpieReport(deepseekSpec, [{ provider: "deepseek", balance }]);
    assert.deepEqual(report.windows, [{ label: "Balance", remaining: amount, currency }]);
    assert.equal(
      formatStatusline(report),
      `deepseek ${currency === "CNY" ? "¥" : "$"}${amount.toFixed(2)}`,
    );
  }
});

test("magpie quota prefers usable entries and merges multiple accounts", () => {
  const report = magpieReport(codexSpec, [
    {
      provider: "codex",
      plan: "plus",
      user: "a@example.com",
      windows: [{ name: "5 hours", remaining: 88 }],
    },
    { provider: "codex", user: "b@example.com", error: "token expired" },
    {
      provider: "codex",
      plan: "team",
      user: "b@example.com",
      windows: [{ name: "5 hours", remaining: 50 }],
    },
  ]);

  assert.equal(report.plan, "plus, team");
  assert.deepEqual(
    report.windows.map((w) => w.label),
    ["a@example.com · 5 hours", "b@example.com · 5 hours"],
  );
  assert.deepEqual(report.notes, []);
});

test("magpie quota reports nothing usable as undefined for the pi fallback", () => {
  assert.equal(magpieReport(codexSpec, []), undefined);
  assert.equal(magpieReport(codexSpec, [{ provider: "codex", error: "not signed in" }]), undefined);
  assert.equal(
    magpieReport(codexSpec, [{ provider: "copilot", windows: [{ name: "x", remaining: 1 }] }]),
    undefined,
  );
  // A balance that cannot be parsed is not usable data.
  assert.equal(magpieReport(deepseekSpec, [{ provider: "deepseek", balance: "soon" }]), undefined);
});

test("magpie report renders through the shared formatter", () => {
  const report = magpieReport(codexSpec, [
    {
      provider: "codex",
      plan: "plus",
      windows: [{ name: "5 hours", remaining: 88, resetsAt: "2026-10-14T19:38:15+08:00" }],
    },
  ]);
  const body = formatReport({ id: report.id, name: report.name, status: "ready", report });
  assert.match(body, /OpenAI Codex · Plus/);
  assert.match(body, /5 hours:.*88% left/);
});

const posix = process.platform === "win32" ? { skip: "POSIX-only spawn test" } : {};

test("queryMagpieQuotas parses a real quota process output", posix, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-usage-magpie-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, "magpie");
  fs.writeFileSync(
    bin,
    '#!/bin/sh\nprintf \'[{"provider":"deepseek","name":"DeepSeek","kind":"balance","balance":"¥16.82","windows":[]}]\'\n',
    { mode: 0o755 },
  );
  process.env.PI_USAGE_MAGPIE_BIN = bin;
  t.after(() => delete process.env.PI_USAGE_MAGPIE_BIN);

  const quotas = await queryMagpieQuotas({ fresh: true });
  assert.equal(quotas.length, 1);
  assert.equal(quotas[0].provider, "deepseek");
  const report = magpieReport(deepseekSpec, quotas);
  assert.equal(report.windows[0].remaining, 16.82);
});

test("queryMagpieQuotas reports an absent binary as no data", posix, async () => {
  process.env.PI_USAGE_MAGPIE_BIN = "/nonexistent/magpie";
  try {
    assert.deepEqual(await queryMagpieQuotas({ fresh: true }), []);
  } finally {
    delete process.env.PI_USAGE_MAGPIE_BIN;
  }
});

test("queryMagpieQuotas prefers a running gateway over the binary", async (t) => {
  const server = http.createServer((_req, res) => {
    res.end(
      JSON.stringify({
        object: "list",
        data: [{ provider: "deepseek", kind: "balance", balance: "$5.00", windows: [] }],
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  // A binary that would fail proves the gateway answered instead of it.
  process.env.PI_USAGE_MAGPIE_BIN = "/nonexistent/magpie";
  process.env.PI_USAGE_MAGPIE_GATEWAY = `http://127.0.0.1:${server.address().port}`;
  t.after(() => {
    delete process.env.PI_USAGE_MAGPIE_BIN;
    delete process.env.PI_USAGE_MAGPIE_GATEWAY;
  });

  const quotas = await queryMagpieQuotas({ fresh: true });
  assert.equal(quotas.length, 1);
  assert.equal(quotas[0].provider, "deepseek");
  const report = magpieReport(deepseekSpec, quotas);
  assert.equal(report.windows[0].remaining, 5);
});

test("queryMagpieQuotas falls back to the binary when no gateway answers", posix, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-usage-magpie-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, "magpie");
  fs.writeFileSync(
    bin,
    '#!/bin/sh\nprintf \'[{"provider":"deepseek","kind":"balance","balance":"¥16.82","windows":[]}]\'\n',
    { mode: 0o755 },
  );
  // Nothing listens on this port; a closed server guarantees that.
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  server.close();
  process.env.PI_USAGE_MAGPIE_GATEWAY = `http://127.0.0.1:${port}`;
  process.env.PI_USAGE_MAGPIE_BIN = bin;
  t.after(() => {
    delete process.env.PI_USAGE_MAGPIE_GATEWAY;
    delete process.env.PI_USAGE_MAGPIE_BIN;
  });

  const quotas = await queryMagpieQuotas({ fresh: true });
  assert.equal(quotas.length, 1);
  assert.equal(quotas[0].provider, "deepseek");
});
