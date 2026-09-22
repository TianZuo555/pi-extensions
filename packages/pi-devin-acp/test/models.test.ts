import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clampDevinEffort,
  devinGroups,
  findDevinGroup,
  modelCacheTtlMs,
  parseDevinModels,
  parseRowMeta,
  planDevinConfigSet,
  resolveDevinModelRow,
  rowMarkers,
} from "../lib/models.ts";
import type { DevinConfigOption } from "../lib/acp-client.ts";

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
    base: "claude-opus-5",
    effort: "high",
    thinking: false,
    fast: false,
    contextVariant: undefined,
  });
  assert.deepEqual(rowMarkers("gpt-5-4-none-priority"), {
    base: "gpt-5-4",
    effort: "none",
    thinking: false,
    fast: true,
    contextVariant: undefined,
  });
  assert.deepEqual(rowMarkers("claude-sonnet-4-6-thinking-1m"), {
    base: "claude-sonnet-4-6",
    effort: undefined,
    thinking: true,
    fast: false,
    contextVariant: "1m",
  });
  assert.deepEqual(rowMarkers("MODEL_GPT_5_2_XHIGH"), {
    base: "MODEL_GPT_5_2",
    effort: "xhigh",
    thinking: false,
    fast: false,
    contextVariant: undefined,
  });
  assert.deepEqual(rowMarkers("swe-1-6-fast"), {
    base: "swe-1-6",
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

test("buildGroups splits context variants into separate pi models", () => {
  const families = parseDevinModels(MODELS_OUTPUT);
  const groups = devinGroups(families);
  const ids = groups.map((g) => g.id);
  assert.ok(ids.includes("claude-opus-5"));
  assert.ok(ids.includes("gpt-5.4"));
  // Serving tiers stay inside the family model: /devin-fast picks them.
  assert.ok(!ids.includes("claude-opus-5-fast"));
  assert.ok(!ids.includes("gpt-5.4-fast"));
  const opus = groups.find((g) => g.id === "claude-opus-5")!;
  assert.equal(opus.rows.length, 8);
  // claude-sonnet-4.6 splits by context variant: base + 1m
  assert.ok(ids.includes("claude-sonnet-4.6"));
  assert.ok(ids.includes("claude-sonnet-4.6-1m"));
  // swe-1.6-fast family has a single (fast) row → keeps its own slug
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

  // Below the family's effort floor → clamps to the lowest row, never up
  // to a higher-effort (e.g. -max) variant.
  const floorOnly: Parameters<typeof resolveDevinModelRow>[0] = {
    id: "swe-2",
    name: "SWE-2",
    contextWindow: 262_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: true,
    rows: [
      {
        id: "swe-2-high",
        name: "SWE-2 High",
        contextWindow: 262_000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        effort: "high",
      },
      {
        id: "swe-2-medium",
        name: "SWE-2 Medium",
        contextWindow: 262_000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        effort: "medium",
      },
      {
        id: "swe-2-max",
        name: "SWE-2 Max",
        contextWindow: 262_000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        effort: "max",
      },
    ],
  };
  assert.equal(resolveDevinModelRow(floorOnly, "low").id, "swe-2-medium");
  assert.equal(resolveDevinModelRow(floorOnly, "minimal").id, "swe-2-medium");

  // /devin-fast tier: same family resolves within its priority rows.
  const fast = findDevinGroup(families, "gpt-5.4")!;
  assert.equal(resolveDevinModelRow(fast, "high", true).id, "gpt-5-4-high-priority");
  assert.equal(resolveDevinModelRow(fast, "high", false).id, "gpt-5-4-high");
  // A family without a priority tier falls back to all its rows.
  assert.equal(resolveDevinModelRow(floorOnly, "high", true).id, "swe-2-high");

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

const select = (id: string, values: string[]): DevinConfigOption => ({
  id,
  options: values.map((value) => ({ value, name: value })),
});

/** devin 3000.11+ shape: family-anchor model values + variant options. */
const MODERN_OPTIONS = [
  select("model", ["swe-2-high", "claude-opus-5-medium", "adaptive"]),
  select("thought_level", ["medium", "high", "max"]),
];

/** devin 3000.10 shape: every catalog row is an accepted model value. */
const LEGACY_OPTIONS = [
  select("model", ["swe-2-high", "swe-2-medium", "swe-2-max", "claude-opus-5-medium"]),
  select("thought_level", ["medium", "high", "max"]),
];

test("rowMarkers parses fusion rows as lead + verbatim sidekick", () => {
  // The lead uid carries the markers — including a mid-id `-fast`.
  assert.deepEqual(rowMarkers("fusion-claude-opus-5-max-fast-sidekick-swe-2-medium"), {
    base: "fusion-claude-opus-5-sidekick-swe-2-medium",
    effort: "max",
    thinking: false,
    fast: true,
    contextVariant: undefined,
  });
  // The sidekick uid is anchor identity — its own tier marker stays verbatim.
  assert.deepEqual(
    rowMarkers("fusion-claude-fable-5-1-medium-sidekick-gpt-5-6-luna-high-priority"),
    {
      base: "fusion-claude-fable-5-1-sidekick-gpt-5-6-luna-high-priority",
      effort: "medium",
      thinking: false,
      fast: false,
      contextVariant: undefined,
    },
  );
});

test("planDevinConfigSet maps fusion rows onto the advertised anchor", () => {
  const options = [
    select("model", ["fusion-claude-opus-5-high-sidekick-swe-2-medium", "swe-2-high"]),
    select("thought_level", ["low", "medium", "high", "xhigh", "max"]),
    select("speed", ["standard", "fast"]),
  ];
  // Devin rejects concrete fusion rows as model values: pick the anchor for
  // the same lead family + sidekick, then carry the LEAD's effort and tier.
  const row = "fusion-claude-opus-5-max-fast-sidekick-swe-2-medium";
  assert.deepEqual(planDevinConfigSet("model", row, options), {
    configId: "model",
    value: "fusion-claude-opus-5-high-sidekick-swe-2-medium",
  });
  assert.deepEqual(planDevinConfigSet("thought_level", row, options), {
    configId: "thought_level",
    value: "max",
  });
  assert.deepEqual(planDevinConfigSet("speed", row, options), {
    configId: "speed",
    value: "fast",
  });
  // Sidekick variants without an anchor fall back to the closest one.
  assert.deepEqual(
    planDevinConfigSet("model", "fusion-claude-opus-5-high-sidekick-swe-2-max", options),
    { configId: "model", value: "fusion-claude-opus-5-high-sidekick-swe-2-medium" },
  );
});

test("clampDevinEffort clamps onto the advertised levels", () => {
  const levels = ["medium", "high", "max"];
  assert.equal(clampDevinEffort("max", levels), "max");
  assert.equal(clampDevinEffort("high", levels), "high");
  assert.equal(clampDevinEffort("xhigh", levels), "high");
  // Below the floor: lowest available, never upward past the request.
  assert.equal(clampDevinEffort("low", levels), "medium");
  assert.equal(clampDevinEffort("none", levels), "medium");
  assert.equal(clampDevinEffort(undefined, levels), undefined);
  assert.equal(clampDevinEffort("max", []), undefined);
});

test("planDevinConfigSet anchors the model and carries effort via thought_level", () => {
  // Anchor-only model select: the family anchor + thought_level carry the row.
  assert.deepEqual(planDevinConfigSet("model", "swe-2-max", MODERN_OPTIONS), {
    configId: "model",
    value: "swe-2-high",
  });
  assert.deepEqual(planDevinConfigSet("thought_level", "swe-2-max", MODERN_OPTIONS), {
    configId: "thought_level",
    value: "max",
  });
  assert.deepEqual(planDevinConfigSet("thought_level", "swe-2-medium", MODERN_OPTIONS), {
    configId: "thought_level",
    value: "medium",
  });
  // No speed option for this family → no write.
  assert.equal(planDevinConfigSet("speed", "swe-2-max", MODERN_OPTIONS), undefined);

  // A row id the model select accepts already encodes effort — write it as-is.
  assert.deepEqual(planDevinConfigSet("model", "swe-2-high", MODERN_OPTIONS), {
    configId: "model",
    value: "swe-2-high",
  });
  assert.equal(planDevinConfigSet("thought_level", "swe-2-high", MODERN_OPTIONS), undefined);

  // Legacy full-row selects keep the single-write behavior.
  assert.deepEqual(planDevinConfigSet("model", "swe-2-max", LEGACY_OPTIONS), {
    configId: "model",
    value: "swe-2-max",
  });
  assert.equal(planDevinConfigSet("thought_level", "swe-2-max", LEGACY_OPTIONS), undefined);

  // No advertised options (unknown/devin-less session) → single raw write.
  assert.deepEqual(planDevinConfigSet("model", "swe-2-max", []), {
    configId: "model",
    value: "swe-2-max",
  });
  assert.equal(planDevinConfigSet("thought_level", "swe-2-max", []), undefined);
});

test("planDevinConfigSet maps fast rows onto the speed option", () => {
  const options = [
    select("model", ["claude-opus-5-medium"]),
    select("thought_level", ["low", "medium", "high", "xhigh", "max"]),
    select("speed", ["standard", "fast"]),
  ];
  assert.deepEqual(planDevinConfigSet("model", "claude-opus-5-high-fast", options), {
    configId: "model",
    value: "claude-opus-5-medium",
  });
  assert.deepEqual(planDevinConfigSet("thought_level", "claude-opus-5-high-fast", options), {
    configId: "thought_level",
    value: "high",
  });
  assert.deepEqual(planDevinConfigSet("speed", "claude-opus-5-high-fast", options), {
    configId: "speed",
    value: "fast",
  });
  assert.deepEqual(planDevinConfigSet("speed", "claude-opus-5-high", options), {
    configId: "speed",
    value: "standard",
  });
});

test("planDevinConfigSet clamps effort onto the advertised thought_level", () => {
  const options = [
    select("model", ["gemini-3-8-flash-medium"]),
    select("thought_level", ["low", "high"]),
  ];
  assert.deepEqual(planDevinConfigSet("model", "gemini-3-8-flash-max", options), {
    configId: "model",
    value: "gemini-3-8-flash-medium",
  });
  assert.deepEqual(planDevinConfigSet("thought_level", "gemini-3-8-flash-max", options), {
    configId: "thought_level",
    value: "high",
  });
});
