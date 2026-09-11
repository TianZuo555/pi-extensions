import assert from "node:assert/strict";
import { test } from "node:test";
import {
  devinGroups,
  findDevinGroup,
  modelCacheTtlMs,
  parseDevinModels,
  parseRowMeta,
  resolveDevinModelRow,
  rowMarkers,
} from "../lib/models.ts";

const MODELS_OUTPUT = `Available models (47 families)

Adaptive (adaptive)
  adaptive                               Adaptive  [$0.5 / 1M Input · $0.1 / 1M Cached input · $2 / 1M Output]

Claude Opus 5 (claude-opus-5)
  aliases: opus
  claude-opus-5-low                      Claude Opus 5 Low  [1M context, $5 / 1M Input · $0.5 / 1M Cached input · $25 / 1M Output]
  claude-opus-5-medium                   Claude Opus 5 Medium  [1M context, $5 / 1M Input · $0.5 / 1M Cached input · $25 / 1M Output]
  claude-opus-5-high                     Claude Opus 5 High  [1M context, $5 / 1M Input · $0.5 / 1M Cached input · $25 / 1M Output]
  claude-opus-5-xhigh                    Claude Opus 5 XHigh  [1M context, $5 / 1M Input · $0.5 / 1M Cached input · $25 / 1M Output]
  claude-opus-5-max                      Claude Opus 5 Max  [1M context, $5 / 1M Input · $0.5 / 1M Cached input · $25 / 1M Output]
  claude-opus-5-low-fast                 Claude Opus 5 Low Fast  [1M context, $10 / 1M Input · $1 / 1M Cached input · $50 / 1M Output]
  claude-opus-5-medium-fast              Claude Opus 5 Medium Fast  [1M context, $10 / 1M Input · $1 / 1M Cached input · $50 / 1M Output]
  claude-opus-5-high-fast                Claude Opus 5 High Fast  [1M context, $10 / 1M Input · $1 / 1M Cached input · $50 / 1M Output]

GPT-5.4 (gpt-5.4)
  gpt-5-4-none                           GPT-5.4 No Thinking  [272K context, $2.5 / 1M Input · $0.25 / 1M Cached input · $15 / 1M Output]
  gpt-5-4-low                            GPT-5.4 Low Thinking  [272K context, $2.5 / 1M Input · $0.25 / 1M Cached input · $15 / 1M Output]
  gpt-5-4-medium                         GPT-5.4 Medium Thinking  [272K context, $2.5 / 1M Input · $0.25 / 1M Cached input · $15 / 1M Output]
  gpt-5-4-high                           GPT-5.4 High Thinking  [272K context, $2.5 / 1M Input · $0.25 / 1M Cached input · $15 / 1M Output]
  gpt-5-4-none-priority                  GPT-5.4 No Thinking Fast  [272K context, $5 / 1M Input · $0.5 / 1M Cached input · $30 / 1M Output]
  gpt-5-4-high-priority                  GPT-5.4 High Thinking Fast  [272K context, $5 / 1M Input · $0.5 / 1M Cached input · $30 / 1M Output]

GPT-5.2 (gpt-5.2)
  MODEL_GPT_5_2_LOW                      GPT-5.2 Low Thinking  [384K context, $1.75 / 1M Input · $0.17 / 1M Cached input · $14 / 1M Output]
  MODEL_GPT_5_2_MEDIUM                   GPT-5.2 Medium Thinking  [384K context, $1.75 / 1M Input · $0.17 / 1M Cached input · $14 / 1M Output]
  MODEL_GPT_5_2_NONE                     GPT-5.2 No Thinking  [384K context, $1.75 / 1M Input · $0.17 / 1M Cached input · $14 / 1M Output]
  MODEL_GPT_5_2_HIGH                     GPT-5.2 High Thinking  [384K context, $1.75 / 1M Input · $0.17 / 1M Cached input · $14 / 1M Output]

Claude Sonnet 4.6 (claude-sonnet-4.6)
  claude-sonnet-4-6                      Claude Sonnet 4.6  [200K context, $3 / 1M Input · $0.3 / 1M Cached input · $15 / 1M Output]
  claude-sonnet-4-6-thinking             Claude Sonnet 4.6 Thinking  [200K context, $3 / 1M Input · $0.3 / 1M Cached input · $15 / 1M Output]
  claude-sonnet-4-6-1m                   Claude Sonnet 4.6 1M  [1M context, $3 / 1M Input · $0.3 / 1M Cached input · $15 / 1M Output]
  claude-sonnet-4-6-thinking-1m          Claude Sonnet 4.6 Thinking 1M  [1M context, $3 / 1M Input · $0.3 / 1M Cached input · $15 / 1M Output]

SWE-2 (swe-2)
  aliases: swe
  swe-2-high                             SWE-2 High  [262K context, Free]
  swe-2-medium                           SWE-2 Medium  [262K context, Free]
  swe-2-max                              SWE-2 Max  [262K context, Free]

SWE-1.6 Fast (swe-1.6-fast)
  swe-1-6-fast                           SWE-1.6 Fast  [200K context, $0.5 / 1M Input · $0.2 / 1M Cached input · $2.5 / 1M Output]

Pass a family slug, alias, or model UID to \`--model\` (e.g. \`--model opus\`)
or switch models in a session with \`/model <name>\`.
`;

test("rowMarkers extracts effort/fast/context suffixes", () => {
  assert.deepEqual(rowMarkers("claude-opus-5-high"), {
    effort: "high",
    thinking: false,
    fast: false,
    contextVariant: undefined,
  });
  assert.deepEqual(rowMarkers("gpt-5-4-none-priority"), {
    effort: "none",
    thinking: false,
    fast: true,
    contextVariant: undefined,
  });
  assert.deepEqual(rowMarkers("claude-sonnet-4-6-thinking-1m"), {
    effort: undefined,
    thinking: true,
    fast: false,
    contextVariant: "1m",
  });
  assert.deepEqual(rowMarkers("MODEL_GPT_5_2_XHIGH"), {
    effort: "xhigh",
    thinking: false,
    fast: false,
    contextVariant: undefined,
  });
  assert.deepEqual(rowMarkers("swe-1-6-fast"), {
    effort: undefined,
    thinking: false,
    fast: true,
    contextVariant: undefined,
  });
});

test("parseRowMeta parses context window and pricing", () => {
  const meta = parseRowMeta("1M context, $5 / 1M Input · $0.5 / 1M Cached input · $25 / 1M Output");
  assert.equal(meta.contextWindow, 1_000_000);
  assert.equal(meta.cost.input, 5);
  assert.equal(meta.cost.cacheRead, 0.5);
  assert.equal(meta.cost.output, 25);
  const free = parseRowMeta("262K context, Free");
  assert.equal(free.contextWindow, 262_000);
  assert.equal(free.cost.input, 0);
});

test("parseDevinModels parses families, aliases, and rows; skips noise", () => {
  const families = parseDevinModels(MODELS_OUTPUT);
  assert.equal(families.length, 7);
  const opus = families.find((f) => f.id === "claude-opus-5");
  assert.ok(opus);
  assert.equal(opus.name, "Claude Opus 5");
  assert.deepEqual(opus.aliases, ["opus"]);
  assert.equal(opus.rows.length, 8);
  assert.equal(opus.rows[0].id, "claude-opus-5-low");
  assert.equal(opus.rows[0].effort, "low");
  assert.equal(opus.rows[5].fast, true);
  const gpt52 = families.find((f) => f.id === "gpt-5.2");
  assert.equal(gpt52?.rows[0].id, "MODEL_GPT_5_2_LOW");
});

test("buildGroups splits fast and context variants into separate pi models", () => {
  const families = parseDevinModels(MODELS_OUTPUT);
  const groups = devinGroups(families);
  const ids = groups.map((g) => g.id);
  assert.ok(ids.includes("claude-opus-5"));
  assert.ok(ids.includes("claude-opus-5-fast"));
  assert.ok(ids.includes("gpt-5.4"));
  assert.ok(ids.includes("gpt-5.4-fast"));
  // claude-sonnet-4.6 splits by context variant: base + 1m
  assert.ok(ids.includes("claude-sonnet-4.6"));
  assert.ok(ids.includes("claude-sonnet-4.6-1m"));
  // swe-1.6-fast family has a single (fast) group → keeps its own slug
  const sweFast = groups.find((g) => g.id === "swe-1.6-fast");
  assert.ok(sweFast);
  assert.equal(sweFast.rows.length, 1);
});

test("resolveDevinModelRow maps thinking levels to concrete variants", () => {
  const families = parseDevinModels(MODELS_OUTPUT);
  const opus = findDevinGroup(families, "claude-opus-5")!;
  assert.equal(resolveDevinModelRow(opus, "high").id, "claude-opus-5-high");
  assert.equal(resolveDevinModelRow(opus, "max").id, "claude-opus-5-max");
  assert.equal(resolveDevinModelRow(opus, undefined).id, "claude-opus-5-medium");
  assert.equal(resolveDevinModelRow(opus, "off").id, "claude-opus-5-medium");

  const gpt = findDevinGroup(families, "gpt-5.4")!;
  assert.equal(resolveDevinModelRow(gpt, "off").id, "gpt-5-4-none");
  // xhigh missing in fixture → falls back to highest at-or-below
  assert.equal(resolveDevinModelRow(gpt, "xhigh").id, "gpt-5-4-high");

  const fast = findDevinGroup(families, "gpt-5.4-fast")!;
  assert.equal(resolveDevinModelRow(fast, "high").id, "gpt-5-4-high-priority");

  // Binary-thinking family: any level → thinking row; off → plain row
  const sonnet = findDevinGroup(families, "claude-sonnet-4.6")!;
  assert.equal(resolveDevinModelRow(sonnet, "high").id, "claude-sonnet-4-6-thinking");
  assert.equal(resolveDevinModelRow(sonnet, "off").id, "claude-sonnet-4-6");

  // MODEL_* enum-style ids resolve through the same path
  const gpt52 = findDevinGroup(families, "gpt-5.2")!;
  assert.equal(resolveDevinModelRow(gpt52, "medium").id, "MODEL_GPT_5_2_MEDIUM");

  const adaptive = findDevinGroup(families, "adaptive")!;
  assert.equal(resolveDevinModelRow(adaptive, "high").id, "adaptive");
});

test("modelCacheTtlMs distinguishes live and fallback caches", () => {
  assert.ok(modelCacheTtlMs("live") > modelCacheTtlMs("fallback"));
});
