import assert from "node:assert/strict";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { pickCompactionModel } from "../src/compact.ts";
import type { CompactSettings } from "../src/settings.ts";
import {
  DEFAULT_CODEX_COMPACT_SETTINGS,
  normalizeCompactSettings,
  parseCompactionModelRef,
} from "../src/settings.ts";

const settings = (patch: Partial<CompactSettings> = {}): CompactSettings => ({
  ...DEFAULT_CODEX_COMPACT_SETTINGS,
  ...patch,
});

test("model refs accept provider-relative IDs and split qualified refs once", () => {
  assert.deepEqual(parseCompactionModelRef("gpt-6-luna"), { modelId: "gpt-6-luna" });
  assert.deepEqual(parseCompactionModelRef("openai-codex/gpt-6-luna"), {
    provider: "openai-codex",
    modelId: "gpt-6-luna",
  });
  assert.deepEqual(parseCompactionModelRef("openrouter/openai/gpt-6-luna"), {
    provider: "openrouter",
    modelId: "openai/gpt-6-luna",
  });
  for (const ref of ["", "openai-codex/", "/gpt-6-luna", " gpt-6-luna "]) {
    assert.equal(parseCompactionModelRef(ref), undefined);
  }
});

test("settings default to provider-relative GPT-6 Luna and preserve explicit choices", () => {
  assert.equal(normalizeCompactSettings({})?.compactionModel, "gpt-6-luna");
  for (const ref of ["openai-codex/gpt-5.6-luna", "openai/gpt-6-sol", "gpt-6-sol", ""]) {
    assert.equal(normalizeCompactSettings({ compactionModel: ref })?.compactionModel, ref);
  }
  assert.equal(normalizeCompactSettings({ compactionModel: "/invalid" }), undefined);
  assert.equal(normalizeCompactSettings({ compactionModel: 42 }), undefined);
});

test("settings keep the lossy fallback opt-in", () => {
  assert.equal(normalizeCompactSettings({})?.allowLossyNativeFallback, false);
  assert.equal(
    normalizeCompactSettings({ allowLossyNativeFallback: true })?.allowLossyNativeFallback,
    true,
  );
  assert.equal(normalizeCompactSettings({ allowLossyNativeFallback: "yes" }), undefined);
});

function model(id: string, provider = "openai-codex"): Model<Api> {
  return {
    id,
    name: id,
    api: provider === "openai" ? "openai-responses" : "openai-codex-responses",
    provider,
    baseUrl:
      provider === "openai" ? "https://api.openai.com/v1" : "https://chatgpt.com/backend-api",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 272000,
    maxTokens: 128000,
  };
}

function fakeCtx(models: Model<Api>[]) {
  const notifications: string[] = [];
  return {
    notifications,
    ctx: {
      hasUI: true,
      ui: { notify: (msg: string) => notifications.push(msg) },
      modelRegistry: {
        find: (provider: string, modelId: string) =>
          models.find((m) => m.provider === provider && m.id === modelId),
      },
    } as unknown as ExtensionContext,
  };
}

for (const provider of ["openai", "openai-codex"]) {
  test(`default selects Luna 6 on the session's ${provider} backend`, () => {
    const sol = model("gpt-6-sol", provider);
    const luna = model("gpt-6-luna", provider);
    const { ctx, notifications } = fakeCtx([
      sol,
      luna,
      model("gpt-6-luna", provider === "openai" ? "openai-codex" : "openai"),
    ]);
    assert.equal(pickCompactionModel(ctx, sol, settings()), luna);
    assert.deepEqual(notifications, []);
  });

  test(`qualified model choice on ${provider} still works`, () => {
    const sol = model("gpt-6-sol", provider);
    const luna = model("gpt-6-luna", provider);
    const { ctx } = fakeCtx([sol, luna]);
    assert.equal(
      pickCompactionModel(ctx, sol, settings({ compactionModel: `${provider}/gpt-6-luna` })),
      luna,
    );
  });
}

test("missing model falls back with one warning", () => {
  const sol = model("gpt-6-sol");
  const { ctx, notifications } = fakeCtx([sol]);
  const warned = new Set<string>();
  for (let i = 0; i < 2; i++) assert.equal(pickCompactionModel(ctx, sol, settings(), warned), sol);
  assert.equal(notifications.length, 1);
});

test("cross-provider refs fall back instead of sending history to another backend", () => {
  const sol = model("gpt-6-sol");
  const other = model("gpt-6-luna", "openai");
  const { ctx } = fakeCtx([sol, other]);
  assert.equal(
    pickCompactionModel(ctx, sol, settings({ compactionModel: "openai/gpt-6-luna" })),
    sol,
  );
});

for (const [name, patch] of [
  ["API", { api: "openai-completions" }],
  ["endpoint", { baseUrl: "https://other.invalid/backend-api" }],
] as const) {
  test(`rejects a different ${name} on the same provider`, () => {
    const sol = model("gpt-6-sol");
    const luna = { ...model("gpt-6-luna"), ...patch };
    const { ctx, notifications } = fakeCtx([sol, luna]);
    assert.equal(pickCompactionModel(ctx, sol, settings(), new Set()), sol);
    assert.equal(notifications.length, 1);
  });
}

test("empty ref keeps the session model", () => {
  const sol = model("gpt-6-sol");
  const { ctx } = fakeCtx([sol, model("gpt-6-luna")]);
  assert.equal(pickCompactionModel(ctx, sol, settings({ compactionModel: "" })), sol);
});
