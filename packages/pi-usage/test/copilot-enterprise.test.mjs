import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import usageExtension from "../index.ts";
import { queryCopilotUsage } from "../lib/providers.ts";

const USAGE = {
  copilot_plan: "business",
  quota_reset_date: "2026-11-01",
  token_based_billing: true,
  quota_snapshots: {
    premium_interactions: {
      percent_remaining: 31,
      quota_remaining: 7_787,
      entitlement: 25_000,
    },
  },
};

function mockUsage(t, response = () => Response.json(USAGE)) {
  return t.mock.method(globalThis, "fetch", async () => response());
}

for (const domain of [undefined, "github.com", "https://github.com/"]) {
  test(`Copilot public usage keeps the public endpoint (${domain ?? "default"})`, async (t) => {
    const fetch = mockUsage(t);
    const report = await queryCopilotUsage("public-token", undefined, 1000, 0, domain);
    assert.equal(fetch.mock.callCount(), 1);
    const [url, init] = fetch.mock.calls[0].arguments;
    assert.equal(url, "https://api.github.com/copilot_internal/user");
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer public-token");
    assert.equal(report.windows[0].credits, true);
    assert.equal(report.windows[0].remaining, 7_787);
  });
}

for (const domain of ["example.ghe.com", "https://example.ghe.com/", " EXAMPLE.GHE.COM "]) {
  test(`Copilot Enterprise usage uses its matching API domain (${domain})`, async (t) => {
    const fetch = mockUsage(t);
    const report = await queryCopilotUsage("enterprise-token", undefined, 1000, 0, domain);
    assert.equal(fetch.mock.callCount(), 1);
    const [url, init] = fetch.mock.calls[0].arguments;
    assert.equal(url, "https://api.example.ghe.com/copilot_internal/user");
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer enterprise-token");
    assert.equal(report.windows[0].credits, true);
    assert.equal(report.windows[0].entitlement, 25_000);
  });
}

for (const domain of [
  "",
  "   ",
  null,
  123,
  "https://example.ghe.com.evil.test",
  "https://example-ghe.com",
  "https://ghe.com",
  "http://example.ghe.com",
  "https://secret@example.ghe.com",
  "https://example.ghe.com:8443",
  "https://example.ghe.com:443",
  "https://example.ghe.com/path",
  "https://example.ghe.com?token=secret",
  "https://example.ghe.com#fragment",
  "https://localhost",
  "https://127.0.0.1",
  "https://git.company.test",
  "https://example.ghe.com\\evil.test",
  "https://%65xample.ghe.com",
]) {
  test(`invalid or unsupported Enterprise metadata fails before fetching (${JSON.stringify(domain)})`, async (t) => {
    const fetch = mockUsage(t);
    await assert.rejects(
      queryCopilotUsage("enterprise-token", undefined, 1000, 1, domain),
      /GitHub Enterprise/,
    );
    assert.equal(fetch.mock.callCount(), 0);
  });
}

test("Copilot quota requests do not follow HTTP redirects or replay on the public host", async (t) => {
  const fetch = mockUsage(
    t,
    () =>
      new Response("redirect", {
        status: 302,
        headers: { location: "https://api.github.com/copilot_internal/user" },
      }),
  );
  await assert.rejects(
    queryCopilotUsage("enterprise-token", undefined, 1000, 1, "example.ghe.com"),
    /302/,
  );
  assert.equal(fetch.mock.callCount(), 1);
  const [url, init] = fetch.mock.calls[0].arguments;
  assert.equal(url, "https://api.example.ghe.com/copilot_internal/user");
  assert.equal(init.redirect, "manual");
});

for (const status of [401, 403, 404]) {
  test(`Copilot Enterprise ${status} is not retried against another account domain`, async (t) => {
    const fetch = mockUsage(t, () => Response.json({ message: "not available" }, { status }));
    await assert.rejects(
      queryCopilotUsage("enterprise-token", undefined, 1000, 1, "example.ghe.com"),
      new RegExp(String(status)),
    );
    assert.equal(fetch.mock.callCount(), 1);
    assert.equal(
      fetch.mock.calls[0].arguments[0],
      "https://api.example.ghe.com/copilot_internal/user",
    );
  });
}

test("a valid Enterprise endpoint without quota snapshots does not fabricate a budget", async (t) => {
  const fetch = mockUsage(t, () => Response.json({ copilot_plan: "enterprise" }));
  await assert.rejects(
    queryCopilotUsage("enterprise-token", undefined, 1000, 0, "example.ghe.com"),
    /no quota snapshots/,
  );
  assert.equal(fetch.mock.callCount(), 1);
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setupExtension(t, enterpriseUrl) {
  for (const name of [
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GITHUB_COPILOT_TOKEN",
    "COPILOT_GITHUB_TOKEN",
    "ZAI_API_KEY",
    "ZAI_CODING_CN_API_KEY",
    "ZHIPU_API_KEY",
    "DEEPSEEK_API_KEY",
    "MIMO_API_KEY",
    "MIMO_COOKIE",
  ]) {
    const saved = process.env[name];
    delete process.env[name];
    t.after(() => {
      if (saved === undefined) delete process.env[name];
      else process.env[name] = saved;
    });
  }
  const auth = {
    "github-copilot": {
      type: "oauth",
      refresh: "enterprise-github-token",
      access: "short-lived-chat-token",
      ...(enterpriseUrl === undefined ? {} : { enterpriseUrl }),
    },
  };
  const authFile = path.join(getAgentDir(), "auth.json");
  const readFileSync = fs.readFileSync;
  t.mock.method(fs, "readFileSync", (...args) => {
    const file = String(args[0]);
    if (file === authFile) return JSON.stringify(auth);
    if (file.endsWith(path.join("github-copilot", "apps.json"))) return "{}";
    return readFileSync(...args);
  });
  const fetch = mockUsage(t);
  const events = new Map();
  const commands = new Map();
  usageExtension({
    on: (name, handler) => events.set(name, handler),
    registerCommand: (name, command) => commands.set(name, command),
  });
  const statuses = [];
  const menus = [];
  let changed = deferred();
  const ctx = {
    model: { provider: "github-copilot" },
    mode: "rpc",
    hasUI: true,
    modelRegistry: {
      getProviderAuthStatus: (provider) => ({ configured: provider === "github-copilot" }),
    },
    ui: {
      setStatus: (_key, value) => {
        statuses.push(value);
        changed.resolve();
      },
      notify: () => {},
      select: async (title) => {
        menus.push(title);
        return "Close";
      },
    },
  };
  t.after(async () => events.get("session_shutdown")({}, ctx));
  return {
    ctx,
    fetch,
    statuses,
    menus,
    commands,
    emit: (name) => events.get(name)({}, ctx),
    nextStatus: () => {
      changed = deferred();
      return changed.promise;
    },
  };
}

for (const event of ["session_start", "model_select", "turn_start"]) {
  test(`Enterprise ${event} forwards credential metadata and publishes the credits footer`, {
    timeout: 5000,
  }, async (t) => {
    const h = setupExtension(t, "example.ghe.com");
    const published = h.nextStatus();
    h.emit(event);
    await published;
    assert.match(h.statuses.at(-1), /copilot 31% credits/);
    assert.equal(h.fetch.mock.callCount(), 1);
    const [url, init] = h.fetch.mock.calls[0].arguments;
    assert.equal(url, "https://api.example.ghe.com/copilot_internal/user");
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer enterprise-github-token");
  });
}

test("Enterprise /usage and Refresh retain the domain and force one fresh query", async (t) => {
  const h = setupExtension(t, "https://example.ghe.com/");
  h.ctx.ui.select = async (title) => {
    h.menus.push(title);
    return h.menus.length === 1 ? "Refresh" : "Close";
  };
  await h.commands.get("usage").handler("", h.ctx);
  assert.equal(h.menus.length, 2);
  assert.equal(h.fetch.mock.callCount(), 2);
  for (const call of h.fetch.mock.calls) {
    assert.equal(call.arguments[0], "https://api.example.ghe.com/copilot_internal/user");
  }
  assert.ok(h.statuses.every((value) => /copilot 31% credits/.test(value)));
});

test("Enterprise footer reuses the existing provider cache until Refresh", {
  timeout: 5000,
}, async (t) => {
  const h = setupExtension(t, "example.ghe.com");
  for (const event of ["session_start", "model_select", "turn_start"]) {
    const published = h.nextStatus();
    h.emit(event);
    await published;
  }
  assert.equal(h.fetch.mock.callCount(), 1);
  assert.equal(
    h.fetch.mock.calls[0].arguments[0],
    "https://api.example.ghe.com/copilot_internal/user",
  );
});

test("invalid stored Enterprise metadata reaches /usage as an error without any HTTP request", async (t) => {
  const h = setupExtension(t, "http://example.ghe.com");
  await h.commands.get("usage").handler("", h.ctx);
  assert.equal(h.fetch.mock.callCount(), 0);
  assert.match(h.menus[0], /GitHub Enterprise/);
  assert.equal(h.statuses.at(-1), undefined);
});
