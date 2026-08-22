import assert from "node:assert/strict";
import { test } from "node:test";
import { modelCacheTtlMs, parseAgyModels, pricingForModel } from "../lib/models.ts";
import { MODELS_OUTPUT } from "./fixtures.ts";

test("parseAgyModels parses tab-separated model lines, collapses effort variants, and skips noise", () => {
  const models = parseAgyModels(MODELS_OUTPUT);
  assert.equal(models.length, 3);
  assert.deepEqual(models[0], { id: "gemini-3.7-flash", name: "Gemini 3.7 Flash" });
  assert.deepEqual(models[1], { id: "gemini-3.7-pro", name: "Gemini 3.7 Pro" });
  assert.equal(models[2].id, "gemini-3.6-flash");
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

test("pricingForModel picks the flash or pro reference tier", () => {
  const flash = pricingForModel("gemini-3.7-flash");
  assert.equal(flash.input, 0.3);
  assert.equal(flash.output, 2.5);
  const pro = pricingForModel("gemini-3.7-pro");
  assert.equal(pro.input, 1.25);
  assert.equal(pro.output, 10);
});

test("modelCacheTtlMs expires fallback caches fast, live caches slow", () => {
  assert.equal(modelCacheTtlMs("live"), 24 * 60 * 60 * 1000);
  assert.equal(modelCacheTtlMs("fallback"), 5 * 60 * 1000);
  // Unknown/undefined source (old caches) is treated as live.
  assert.equal(modelCacheTtlMs(undefined), 24 * 60 * 60 * 1000);
});
