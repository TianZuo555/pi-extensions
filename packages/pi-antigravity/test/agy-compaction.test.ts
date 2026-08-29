import assert from "node:assert/strict";
import { test } from "node:test";
import {
  agyContextTokens,
  detectAgyCompaction,
  formatAgyContextTokens,
} from "../lib/agy-compaction.ts";

test("agyContextTokens combines uncached and cache-read input", () => {
  assert.equal(
    agyContextTokens({ input_tokens: 12_000, cache_read_tokens: 143_000, output_tokens: 500 }),
    155_000,
  );
  assert.equal(agyContextTokens(undefined), undefined);
  assert.equal(agyContextTokens({ input_tokens: 0, cache_read_tokens: 0 }), undefined);
});

test("detectAgyCompaction recognizes a conservative high-context collapse", () => {
  assert.deepEqual(detectAgyCompaction(178_000, 36_000), {
    beforeTokens: 178_000,
    afterTokens: 36_000,
  });
});

test("detectAgyCompaction rejects ordinary cache and phase variation", () => {
  assert.equal(detectAgyCompaction(90_000, 20_000), undefined, "previous context was too small");
  assert.equal(detectAgyCompaction(170_000, 130_000), undefined, "too few tokens were reclaimed");
  assert.equal(detectAgyCompaction(170_000, 115_000), undefined, "remaining ratio is too high");
  assert.equal(detectAgyCompaction(undefined, 20_000), undefined);
});

test("formatAgyContextTokens keeps compaction markers compact", () => {
  assert.equal(formatAgyContextTokens(178_000), "178k");
  assert.equal(formatAgyContextTokens(1_250_000), "1.3m");
  assert.equal(formatAgyContextTokens(800), "800");
});
