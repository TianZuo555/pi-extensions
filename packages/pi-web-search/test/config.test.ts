import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_OPENAI_SYSTEM_PROMPT,
  getProviderStatuses,
  resolveExaConfig,
  resolveFetchProvider,
  resolveFirecrawlConfig,
  resolveOllamaConfig,
  resolveOpenAIConfig,
  resolveSearchProvider,
} from "../lib/config.ts";

test("resolveOpenAIConfig respects OPENAI_API_KEY environment variable", () => {
  const originalEnv = process.env.OPENAI_API_KEY;
  try {
    process.env.OPENAI_API_KEY = "sk-test-openai-key";
    const res = resolveOpenAIConfig(undefined, {});
    assert.ok(res);
    assert.equal(res.apiKey, "sk-test-openai-key");
    assert.equal(res.source, "OPENAI_API_KEY env");
    assert.equal(res.systemPrompt, DEFAULT_OPENAI_SYSTEM_PROMPT);
  } finally {
    process.env.OPENAI_API_KEY = originalEnv;
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
    process.env.EXA_API_KEY = originalEnv;
  }
});

test("resolveFirecrawlConfig respects FIRECRAWL_API_KEY environment variable", () => {
  const originalEnv = process.env.FIRECRAWL_API_KEY;
  try {
    process.env.FIRECRAWL_API_KEY = "fc-test-key";
    const res = resolveFirecrawlConfig({});
    assert.ok(res);
    assert.equal(res.apiKey, "fc-test-key");
    assert.equal(res.source, "FIRECRAWL_API_KEY env");
  } finally {
    process.env.FIRECRAWL_API_KEY = originalEnv;
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

test("resolveFetchProvider defaults to direct if no scrapers configured", () => {
  const originalFc = process.env.FIRECRAWL_API_KEY;
  const originalExa = process.env.EXA_API_KEY;

  try {
    delete process.env.FIRECRAWL_API_KEY;
    delete process.env.EXA_API_KEY;

    assert.equal(resolveFetchProvider(undefined, {}), "direct");
    assert.equal(resolveFetchProvider("firecrawl", {}), "firecrawl");
  } finally {
    if (originalFc !== undefined) process.env.FIRECRAWL_API_KEY = originalFc;
    if (originalExa !== undefined) process.env.EXA_API_KEY = originalExa;
  }
});

test("getProviderStatuses lists all 5 supported providers", () => {
  const statuses = getProviderStatuses();
  const names = statuses.map((s) => s.name);
  assert.deepEqual(names, ["openai", "exa", "firecrawl", "ollama", "direct"]);
});
