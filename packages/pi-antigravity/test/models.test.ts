import assert from "node:assert/strict";
import { test } from "node:test";
import {
  capabilitiesForModel,
  FALLBACK_MODELS,
  modelCacheTtlMs,
  parseAgyModels,
  pricingForModel,
  resolveAgyModelEffort,
} from "../lib/models.ts";
import { MODELS_OUTPUT } from "./fixtures.ts";

test("parseAgyModels parses tab-separated model lines, collapses effort variants, and skips noise", () => {
  const models = parseAgyModels(MODELS_OUTPUT);
  assert.equal(models.length, 7);
  assert.deepEqual(models[0], {
    id: "gemini-3.7-flash",
    name: "Gemini 3.7 Flash",
    supportedEfforts: ["high", "medium"],
    defaultEffort: "high",
  });
  assert.equal(models[1].id, "gemini-3.6-flash");
  assert.deepEqual(models[4], {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6 (Thinking)",
    supportedEfforts: [],
    defaultEffort: undefined,
  });
  assert.equal(models[5].id, "claude-opus-4-6-thinking");
  assert.deepEqual(models[6], {
    id: "gpt-oss-120b",
    name: "GPT-OSS 120B",
    supportedEfforts: ["medium"],
    defaultEffort: "medium",
  });
});

test("parseAgyModels dedupes ids and rejects malformed lines", () => {
  const models = parseAgyModels(
    ["a\tA", "a\tA duplicate", "no-tab-line", "\tleading-tab", "b\tB"].join("\n"),
  );
  assert.deepEqual(
    models.map((m) => m.id),
    ["a", "b"],
  );
});

test("parseAgyModels returns empty for empty output", () => {
  assert.deepEqual(parseAgyModels(""), []);
});

test("resolveAgyModelEffort never launches a normalized model with an invalid effort", () => {
  const [gemini, , , pro, claude, , gpt] = FALLBACK_MODELS;
  assert.equal(resolveAgyModelEffort(gemini, "low"), "low");
  assert.equal(resolveAgyModelEffort(pro, "medium"), "high");
  assert.equal(resolveAgyModelEffort(claude, "high"), undefined);
  assert.equal(resolveAgyModelEffort(gpt, "high"), "medium");
});

test("pricingForModel uses vendor-specific reference rates and no cross-vendor fallback", () => {
  assert.deepEqual(pricingForModel("gemini-3.7-flash"), {
    input: 0.75,
    output: 3.75,
    cacheRead: 0.075,
    cacheWrite: 0.75,
  });
  assert.equal(pricingForModel("gemini-3.1-pro").output, 12);
  assert.equal(pricingForModel("claude-sonnet-4-6").input, 3);
  assert.equal(pricingForModel("claude-opus-4-6-thinking").output, 25);
  assert.deepEqual(pricingForModel("gpt-oss-120b"), {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  });
});

test("capabilitiesForModel gives agy ownership with a 1M Pi scheduling window", () => {
  assert.deepEqual(capabilitiesForModel("gemini-3.7-flash"), {
    contextWindow: 1_000_000,
    maxTokens: 65_536,
  });
  assert.deepEqual(capabilitiesForModel("claude-sonnet-4-6"), {
    contextWindow: 1_000_000,
    maxTokens: 64_000,
  });
  assert.deepEqual(capabilitiesForModel("claude-opus-4-6-thinking"), {
    contextWindow: 1_000_000,
    maxTokens: 128_000,
  });
  assert.deepEqual(capabilitiesForModel("gpt-oss-120b"), {
    contextWindow: 1_000_000,
    maxTokens: 131_072,
  });
});

test("fallback catalog mirrors all current agy model families", () => {
  assert.deepEqual(
    FALLBACK_MODELS.map(({ id }) => id),
    [
      "gemini-3.7-flash",
      "gemini-3.6-flash",
      "gemini-3.5-flash",
      "gemini-3.1-pro",
      "claude-sonnet-4-6",
      "claude-opus-4-6-thinking",
      "gpt-oss-120b",
    ],
  );
});

test("modelCacheTtlMs expires fallback caches fast, live caches slow", () => {
  assert.equal(modelCacheTtlMs("live"), 24 * 60 * 60 * 1000);
  assert.equal(modelCacheTtlMs("fallback"), 5 * 60 * 1000);
  // Unknown/undefined source (old caches) is treated as live.
  assert.equal(modelCacheTtlMs(undefined), 24 * 60 * 60 * 1000);
});
