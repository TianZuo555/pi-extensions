import assert from "node:assert/strict";
import test from "node:test";
import { hidePiAuthFile, stubPiAuthData } from "./helpers.ts";
import {
  DEFAULT_MONID_API_URL,
  DEFAULT_OPENAI_SYSTEM_PROMPT,
  getProviderStatuses,
  resolveExaConfig,
  resolveFetchProvider,
  resolveFirecrawlConfig,
  resolveMonidConfig,
  resolveOllamaConfig,
  resolveOpenAIConfig,
  resolveSearchProvider,
  resolveTavilyConfig,
} from "../lib/config.ts";

test("resolveOpenAIConfig prefers pi's openai-codex login over OPENAI_API_KEY", () => {
  const originalEnv = process.env.OPENAI_API_KEY;
  const restoreFs = stubPiAuthData({
    "openai-codex": { type: "oauth", access: "codex-access-token" },
  });
  try {
    process.env.OPENAI_API_KEY = "sk-test-openai-key";
    const res = resolveOpenAIConfig(undefined, {});
    assert.ok(res);
    assert.equal(res.apiKey, "codex-access-token");
    assert.equal(res.source, "~/.pi/agent/auth.json (openai-codex)");
  } finally {
    restoreFs();
    if (originalEnv !== undefined) {
      process.env.OPENAI_API_KEY = originalEnv;
    } else {
      delete process.env.OPENAI_API_KEY;
    }
  }
});

test("resolveOpenAIConfig skips an expired openai-codex login", () => {
  const originalEnv = process.env.OPENAI_API_KEY;
  const restoreFs = stubPiAuthData({
    "openai-codex": {
      type: "oauth",
      access: "codex-access-token",
      expires: Date.now() - 1_000, // ms, already past
    },
  });
  try {
    process.env.OPENAI_API_KEY = "sk-fallback-key";
    const res = resolveOpenAIConfig(undefined, {});
    assert.ok(res);
    assert.equal(res.apiKey, "sk-fallback-key");
    assert.equal(res.source, "OPENAI_API_KEY env");
  } finally {
    restoreFs();
    if (originalEnv !== undefined) {
      process.env.OPENAI_API_KEY = originalEnv;
    } else {
      delete process.env.OPENAI_API_KEY;
    }
  }
});

test("resolveOpenAIConfig respects OPENAI_API_KEY environment variable", () => {
  const originalEnv = process.env.OPENAI_API_KEY;
  const restoreFs = hidePiAuthFile();
  try {
    process.env.OPENAI_API_KEY = "sk-test-openai-key";
    const res = resolveOpenAIConfig(undefined, {});
    assert.ok(res);
    assert.equal(res.apiKey, "sk-test-openai-key");
    assert.equal(res.source, "OPENAI_API_KEY env");
    assert.equal(res.systemPrompt, DEFAULT_OPENAI_SYSTEM_PROMPT);
  } finally {
    restoreFs();
    if (originalEnv !== undefined) {
      process.env.OPENAI_API_KEY = originalEnv;
    } else {
      delete process.env.OPENAI_API_KEY;
    }
  }
});

test("resolveExaConfig respects EXA_API_KEY environment variable", () => {
  const originalEnv = process.env.EXA_API_KEY;
  try {
    process.env.EXA_API_KEY = "exa-test-key";
    const res = resolveExaConfig({});
    assert.ok(res);
    assert.equal(res.apiKey, "exa-test-key");
    assert.equal(res.source, "EXA_API_KEY env");
  } finally {
    if (originalEnv !== undefined) {
      process.env.EXA_API_KEY = originalEnv;
    } else {
      delete process.env.EXA_API_KEY;
    }
  }
});

test("resolveFirecrawlConfig respects FIRECRAWL_API_KEY environment variable", () => {
  const originalEnv = process.env.FIRECRAWL_API_KEY;
  const originalKeyless = process.env.FIRECRAWL_KEYLESS;
  try {
    // Keyed mode: opt out of the keyless tier to get the key as primary.
    process.env.FIRECRAWL_API_KEY = "fc-test-key";
    process.env.FIRECRAWL_KEYLESS = "0";
    const res = resolveFirecrawlConfig({});
    assert.ok(res);
    assert.equal(res.apiKey, "fc-test-key");
    assert.equal(res.source, "FIRECRAWL_API_KEY env");
  } finally {
    if (originalEnv !== undefined) {
      process.env.FIRECRAWL_API_KEY = originalEnv;
    } else {
      delete process.env.FIRECRAWL_API_KEY;
    }
    if (originalKeyless !== undefined) {
      process.env.FIRECRAWL_KEYLESS = originalKeyless;
    } else {
      delete process.env.FIRECRAWL_KEYLESS;
    }
  }
});

test("resolveTavilyConfig respects TAVILY_API_KEY environment variable", () => {
  const originalEnv = process.env.TAVILY_API_KEY;
  try {
    process.env.TAVILY_API_KEY = "tvly-test-key";
    const res = resolveTavilyConfig({});
    assert.ok(res);
    assert.equal(res.apiKey, "tvly-test-key");
    assert.equal(res.source, "TAVILY_API_KEY env");
    assert.equal(res.baseUrl, "https://api.tavily.com");
  } finally {
    if (originalEnv !== undefined) {
      process.env.TAVILY_API_KEY = originalEnv;
    } else {
      delete process.env.TAVILY_API_KEY;
    }
  }
});

test("resolveOllamaConfig defaults to localhost:11434", () => {
  const originalHost = process.env.OLLAMA_HOST;
  try {
    delete process.env.OLLAMA_HOST;
    const res = resolveOllamaConfig({});
    assert.equal(res.baseUrl, "http://localhost:11434");
  } finally {
    if (originalHost !== undefined) process.env.OLLAMA_HOST = originalHost;
  }
});

test("resolveSearchProvider falls back to ollama if no keys present", () => {
  const originalOpenAI = process.env.OPENAI_API_KEY;
  const originalExa = process.env.EXA_API_KEY;
  const originalFc = process.env.FIRECRAWL_API_KEY;

  try {
    delete process.env.OPENAI_API_KEY;
    delete process.env.EXA_API_KEY;
    delete process.env.FIRECRAWL_API_KEY;

    // With explicit request override
    assert.equal(resolveSearchProvider(undefined, "exa", {}), "exa");
  } finally {
    if (originalOpenAI !== undefined) process.env.OPENAI_API_KEY = originalOpenAI;
    if (originalExa !== undefined) process.env.EXA_API_KEY = originalExa;
    if (originalFc !== undefined) process.env.FIRECRAWL_API_KEY = originalFc;
  }
});

test("resolveFetchProvider defaults to keyless firecrawl, or direct when keyless is off", () => {
  const originalFc = process.env.FIRECRAWL_API_KEY;
  const originalKeyless = process.env.FIRECRAWL_KEYLESS;
  const originalExa = process.env.EXA_API_KEY;
  const originalTavily = process.env.TAVILY_API_KEY;
  const originalMonid = process.env.MONID_API_KEY;
  // Hide the real auth.json: stored keys (e.g. websearch-exa) would make
  // other providers available and break the zero-config expectations.
  const restoreFs = hidePiAuthFile();

  try {
    delete process.env.FIRECRAWL_API_KEY;
    delete process.env.EXA_API_KEY;
    delete process.env.TAVILY_API_KEY;
    delete process.env.MONID_API_KEY;

    // Keyless firecrawl is the zero-config default fetch head.
    delete process.env.FIRECRAWL_KEYLESS;
    assert.equal(resolveFetchProvider(undefined, {}), "firecrawl");
    assert.equal(resolveFetchProvider("tavily", {}), "tavily");

    // Opting out falls all the way back to the keyless direct fetch.
    process.env.FIRECRAWL_KEYLESS = "0";
    assert.equal(resolveFetchProvider(undefined, {}), "direct");
  } finally {
    restoreFs();
    if (originalFc !== undefined) process.env.FIRECRAWL_API_KEY = originalFc;
    if (originalKeyless !== undefined) process.env.FIRECRAWL_KEYLESS = originalKeyless;
    if (originalExa !== undefined) process.env.EXA_API_KEY = originalExa;
    if (originalTavily !== undefined) process.env.TAVILY_API_KEY = originalTavily;
    if (originalMonid !== undefined) process.env.MONID_API_KEY = originalMonid;
  }
});

test("resolveFirecrawlConfig keyless ladder: keyless first, user key as overflow", () => {
  const originalKey = process.env.FIRECRAWL_API_KEY;
  const originalKeyless = process.env.FIRECRAWL_KEYLESS;
  const restoreFs = hidePiAuthFile();

  try {
    delete process.env.FIRECRAWL_API_KEY;
    delete process.env.FIRECRAWL_KEYLESS;

    // No key: pure keyless mode.
    const keyless = resolveFirecrawlConfig({});
    assert.ok(keyless);
    assert.equal(keyless.keyless, true);
    assert.equal(keyless.apiKey, undefined);
    assert.equal(keyless.overflowApiKey, undefined);

    // Key + keyless on: keyless primary, key as overflow.
    process.env.FIRECRAWL_API_KEY = "fc-key";
    const ladder = resolveFirecrawlConfig({});
    assert.ok(ladder);
    assert.equal(ladder.keyless, true);
    assert.equal(ladder.apiKey, undefined);
    assert.equal(ladder.overflowApiKey, "fc-key");

    // Keyless opted out: keyed only, no overflow indirection.
    process.env.FIRECRAWL_KEYLESS = "0";
    const keyed = resolveFirecrawlConfig({});
    assert.ok(keyed);
    assert.equal(keyed.keyless, false);
    assert.equal(keyed.apiKey, "fc-key");
    assert.equal(keyed.overflowApiKey, undefined);

    // Opted out and no key: unavailable.
    delete process.env.FIRECRAWL_API_KEY;
    assert.equal(resolveFirecrawlConfig({}), null);

    // Config file opt-out behaves like the env var.
    delete process.env.FIRECRAWL_KEYLESS;
    assert.equal(resolveFirecrawlConfig({ firecrawl: { keyless: false } }), null);
  } finally {
    restoreFs();
    if (originalKey !== undefined) process.env.FIRECRAWL_API_KEY = originalKey;
    if (originalKeyless !== undefined) process.env.FIRECRAWL_KEYLESS = originalKeyless;
  }
});

test("resolveMonidConfig respects MONID_API_KEY environment variable", () => {
  const originalKey = process.env.MONID_API_KEY;
  try {
    process.env.MONID_API_KEY = "monid_live_test";
    const res = resolveMonidConfig({});
    assert.ok(res);
    assert.equal(res.apiKey, "monid_live_test");
    assert.equal(res.source, "MONID_API_KEY env");
    assert.equal(res.baseUrl, DEFAULT_MONID_API_URL);
  } finally {
    if (originalKey !== undefined) {
      process.env.MONID_API_KEY = originalKey;
    } else {
      delete process.env.MONID_API_KEY;
    }
  }
});

test("getProviderStatuses lists all 7 supported providers", () => {
  const statuses = getProviderStatuses();
  const names = statuses.map((s) => s.name);
  assert.deepEqual(names, ["openai", "exa", "tavily", "firecrawl", "monid", "ollama", "direct"]);
});
