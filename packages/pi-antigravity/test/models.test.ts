import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAgyModels } from "../lib/models.ts";
import { MODELS_OUTPUT } from "./fixtures.ts";

test("parseAgyModels parses tab-separated model lines and skips noise", () => {
  const models = parseAgyModels(MODELS_OUTPUT);
  assert.equal(models.length, 4);
  assert.deepEqual(models[0], { id: "gemini-3.7-flash-high", name: "Gemini 3.7 Flash (High)" });
  assert.equal(models[3].id, "gemini-3.6-flash-high");
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
