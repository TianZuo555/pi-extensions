import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import usageExtension from "../index.ts";

// Models magpie routes through its gateway keep the upstream provider as the
// model id's first segment ("magpie" provider, "copilot/claude-…" id). The
// footer must map that back to the matching usage provider.

const COPILOT_USAGE = {
  copilot_plan: "business",
  quota_reset_date: "2026-11-01",
  quota_snapshots: {
    premium_interactions: {
      percent_remaining: 31.1,
      quota_remaining: 7787.9,
      remaining: 7787,
      entitlement: 25_000,
      unlimited: false,
    },
  },
};

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setup(t, model) {
  const authFile = path.join(getAgentDir(), "auth.json");
  const readFileSync = fs.readFileSync;
  t.mock.method(fs, "readFileSync", (...args) => {
    const file = String(args[0]);
    if (file === authFile) {
      return JSON.stringify({
        "github-copilot": { type: "oauth", refresh: "gh-token" },
      });
    }
    if (file.endsWith(path.join("github-copilot", "apps.json"))) return "{}";
    return readFileSync(...args);
  });
  t.mock.method(globalThis, "fetch", async () => Response.json(COPILOT_USAGE));
  const events = new Map();
  usageExtension({
    on: (name, handler) => events.set(name, handler),
    registerCommand: () => {},
  });
  const statuses = [];
  let changed = deferred();
  const ctx = {
    model,
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
    },
  };
  t.after(async () => events.get("session_shutdown")({}, ctx));
  return {
    ctx,
    statuses,
    emit: (name) => events.get(name)({}, ctx),
    nextStatus: () => {
      changed = deferred();
      return changed.promise;
    },
  };
}

test("a magpie-routed Copilot model publishes the Copilot footer meter", {
  timeout: 5000,
}, async (t) => {
  const h = setup(t, { provider: "magpie", id: "copilot/claude-sonnet-5.5" });
  const published = h.nextStatus();
  h.emit("session_start");
  await published;
  assert.match(h.statuses.at(-1), /copilot 31% premium/);
});

test("a magpie model of an unsupported upstream clears the footer", {
  timeout: 5000,
}, async (t) => {
  const h = setup(t, { provider: "magpie", id: "kimi/kimi-k3" });
  const published = h.nextStatus();
  h.emit("session_start");
  await published;
  assert.equal(h.statuses.at(-1), undefined);
});
