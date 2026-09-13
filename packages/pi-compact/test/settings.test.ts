import assert from "node:assert/strict";
import test from "node:test";
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

test("parseCompactionModelRef splits on the first slash only", () => {
  assert.deepEqual(parseCompactionModelRef("openai-codex/gpt-5.6-luna"), {
    provider: "openai-codex",
    modelId: "gpt-5.6-luna",
  });
  assert.deepEqual(parseCompactionModelRef("openrouter/openai/gpt-5.6-luna"), {
    provider: "openrouter",
    modelId: "openai/gpt-5.6-luna",
  });
  assert.equal(parseCompactionModelRef("gpt-5.6-luna"), undefined);
  assert.equal(parseCompactionModelRef("openai-codex/"), undefined);
  assert.equal(parseCompactionModelRef("/gpt-5.6-luna"), undefined);
});

test("normalizeCompactSettings defaults compactionModel to luna", () => {
  assert.equal(normalizeCompactSettings({})?.compactionModel, "openai-codex/gpt-5.6-luna");
  assert.equal(
    normalizeCompactSettings({ compactionModel: "openai-codex/gpt-5.6-sol" })?.compactionModel,
    "openai-codex/gpt-5.6-sol",
  );
  assert.equal(normalizeCompactSettings({ compactionModel: "" })?.compactionModel, "");
  assert.equal(normalizeCompactSettings({ compactionModel: "noslash" }), undefined);
  assert.equal(normalizeCompactSettings({ compactionModel: 42 }), undefined);
});

const codexModel = (id: string) => ({
  id,
  name: id,
  api: "openai-codex-responses",
  provider: "openai-codex",
  baseUrl: "https://chatgpt.com/backend-api",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0 },
  contextWindow: 272000,
  maxTokens: 128000,
});
const claudeModel = {
  ...codexModel("claude-sonnet-5"),
  api: "anthropic-messages",
  provider: "anthropic",
};

function fakeCtx(models: ReturnType<typeof codexModel>[]) {
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
    },
  };
}

test("pickCompactionModel uses the configured model on the same provider", () => {
  const sol = codexModel("gpt-5.6-sol");
  const luna = codexModel("gpt-5.6-luna");
  const { ctx, notifications } = fakeCtx([sol, luna]);
  const picked = pickCompactionModel(ctx as never, sol as never, settings());
  assert.equal(picked?.id, "gpt-5.6-luna");
  assert.deepEqual(notifications, []);
});

test("pickCompactionModel falls back when the configured model is missing", () => {
  const sol = codexModel("gpt-5.6-sol");
  const { ctx, notifications } = fakeCtx([sol]);
  const picked = pickCompactionModel(ctx as never, sol as never, settings(), new Set());
  assert.equal(picked?.id, "gpt-5.6-sol");
  assert.equal(notifications.length, 1);
});

test("pickCompactionModel falls back on cross-provider refs", () => {
  const sol = codexModel("gpt-5.6-sol");
  const claude = claudeModel;
  const { ctx } = fakeCtx([sol, claude]);
  const picked = pickCompactionModel(
    ctx as never,
    sol as never,
    settings({ compactionModel: "anthropic/claude-sonnet-5" }),
  );
  assert.equal(picked?.id, "gpt-5.6-sol");
});

test("pickCompactionModel falls back when the ref is not a Responses model", () => {
  const sol = codexModel("gpt-5.6-sol");
  const odd = { ...codexModel("weird"), api: "openai-completions" };
  const { ctx, notifications } = fakeCtx([sol, odd]);
  const picked = pickCompactionModel(
    ctx as never,
    sol as never,
    settings({ compactionModel: "openai-codex/weird" }),
    new Set(),
  );
  assert.equal(picked?.id, "gpt-5.6-sol");
  assert.equal(notifications.length, 1);
});

test("pickCompactionModel rejects another endpoint on the same provider", () => {
  const sol = codexModel("gpt-5.6-sol");
  const luna = { ...codexModel("gpt-5.6-luna"), baseUrl: "https://other.invalid/backend-api" };
  const { ctx, notifications } = fakeCtx([sol, luna]);
  const picked = pickCompactionModel(ctx as never, sol as never, settings(), new Set());
  assert.equal(picked?.id, sol.id);
  assert.equal(notifications.length, 1);
});

test("pickCompactionModel honors an empty ref (session model)", () => {
  const sol = codexModel("gpt-5.6-sol");
  const luna = codexModel("gpt-5.6-luna");
  const { ctx } = fakeCtx([sol, luna]);
  const picked = pickCompactionModel(ctx as never, sol as never, settings({ compactionModel: "" }));
  assert.equal(picked?.id, "gpt-5.6-sol");
});
