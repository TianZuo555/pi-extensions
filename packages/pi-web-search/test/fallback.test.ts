import assert from "node:assert/strict";
import test from "node:test";
import { hidePiAuthFile } from "./helpers.ts";
import type {
  FetchProviderName,
  SearchProviderName,
  WebSearchConfig,
} from "../lib/types.ts";
import {
  classifyProviderFailure,
  createWebSearchRuntime,
  RATE_LIMIT_COOLDOWN_MS,
  runWebSearch,
  WebSearchRuntime,
} from "../src/runtime.ts";
import {
  availableFetchProviders,
  availableSearchProviders,
  resolveFetchChain,
  resolveSearchChain,
} from "../lib/config.ts";

const ENV_KEYS = [
  "OPENAI_API_KEY",
  "EXA_API_KEY",
  "FIRECRAWL_API_KEY",
  "TAVILY_API_KEY",
  "OLLAMA_HOST",
  "OPENAI_BASE_URL",
] as const;

function snapshotEnv(): Record<string, string | undefined> {
  return Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
}

function restoreEnv(snapshot: Record<string, string | undefined>): void {
  for (const key of ENV_KEYS) {
    const value = snapshot[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

interface MockControl {
  calls: string[];
  firecrawlStatus: number;
  exaStatus: number;
}

function installFetchMock(control: MockControl): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    control.calls.push(url);
    if (url.includes("firecrawl.dev")) {
      return new Response(
        JSON.stringify({ success: false, error: "out of credits" }),
        { status: control.firecrawlStatus },
      );
    }
    if (url.includes("api.exa.ai")) {
      if (control.exaStatus !== 200) {
        return new Response(
          JSON.stringify({ error: "exa failed" }),
          { status: control.exaStatus },
        );
      }
      const isFetch = url.includes("/contents");
      return new Response(
        JSON.stringify(
          isFetch
            ? { results: [{ url: "https://exa.example/doc", title: "Exa Doc", text: "Exa fetched content" }] }
            : { results: [{ title: "Exa Result", url: "https://exa.example/doc", text: "Exa snippet" }] },
        ),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.includes("api.openai.com") || url.includes("chatgpt.com")) {
      return new Response(
        JSON.stringify({ error: { message: "You exceeded your usage limit" } }),
        { status: 402 },
      );
    }
    if (url.includes("11434")) {
      return new Response("not found", { status: 404 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

function firecrawlCalls(control: MockControl): number {
  return control.calls.filter((u) => u.includes("firecrawl.dev")).length;
}

test("classifyProviderFailure distinguishes session, cooldown, and normal failures", () => {
  assert.equal(
    classifyProviderFailure("Firecrawl search failed (402 Payment Required): out of credits"),
    "session",
  );
  assert.equal(
    classifyProviderFailure("Exa search failed (403 Forbidden): invalid api key"),
    "session",
  );
  assert.equal(classifyProviderFailure("You exceeded your usage limit"), "session");
  assert.equal(classifyProviderFailure("plan limit reached"), "session");
  assert.equal(
    classifyProviderFailure("Exa search failed (429 Too Many Requests): rate limit"),
    "cooldown",
  );
  assert.equal(classifyProviderFailure("rate limit hit, slow down"), "cooldown");
  assert.equal(
    classifyProviderFailure("fetch failed ECONNREFUSED 127.0.0.1:11434"),
    null,
  );
  assert.equal(classifyProviderFailure("Ollama web_search endpoint not found"), null);
  assert.equal(RATE_LIMIT_COOLDOWN_MS, 120_000);
});

test("provider chains put the requested provider first and dedupe", () => {
  const env = snapshotEnv();
  const restoreFs = hidePiAuthFile();
  try {
    delete process.env.OPENAI_API_KEY;
    delete process.env.EXA_API_KEY;
    delete process.env.FIRECRAWL_API_KEY;
    delete process.env.TAVILY_API_KEY;
    delete process.env.OLLAMA_HOST;

    // Firecrawl becomes "available" purely through its env key.
    process.env.FIRECRAWL_API_KEY = "fc-key";
    const cfg = {};

    // Fetch chains never include OpenAI, so they are fully deterministic.
    assert.deepEqual(availableFetchProviders(cfg), ["firecrawl", "direct"]);
    assert.deepEqual(resolveFetchChain("ollama", cfg), [
      "ollama",
      "firecrawl",
      "direct",
    ]);
    assert.deepEqual(resolveFetchChain(undefined, cfg), [
      "firecrawl",
      "direct",
    ]);

    // Search chains may additionally include OpenAI when pi's auth.json has
    // credentials, so assert structural properties instead of exact lists.
    const available = availableSearchProviders(cfg);
    assert.equal(available[available.length - 1], "ollama");
    assert.ok(available.includes("firecrawl"));

    const chain = resolveSearchChain("exa", cfg);
    assert.equal(chain[0], "exa");
    assert.equal(chain[chain.length - 1], "ollama");
    assert.ok(chain.includes("firecrawl"));
    assert.equal(new Set(chain).size, chain.length);

    assert.equal(resolveSearchChain(undefined, cfg)[0], available[0]);
  } finally {
    restoreFs();
    restoreEnv(env);
  }
});

test("tavily joins search and fetch chains when configured", () => {
  const env = snapshotEnv();
  const restoreFs = hidePiAuthFile();
  try {
    delete process.env.OPENAI_API_KEY;
    delete process.env.EXA_API_KEY;
    delete process.env.FIRECRAWL_API_KEY;
    delete process.env.TAVILY_API_KEY;
    delete process.env.OLLAMA_HOST;

    process.env.TAVILY_API_KEY = "tvly-key";
    const cfg = {};

    // Fetch chains never include OpenAI, so they are fully deterministic.
    assert.deepEqual(availableFetchProviders(cfg), ["tavily", "direct"]);
    assert.deepEqual(resolveFetchChain("tavily", cfg), [
      "tavily",
      "direct",
    ]);

    // Search chains may include OpenAI from pi's auth.json; assert
    // structural properties instead of exact lists.
    const available = availableSearchProviders(cfg);
    assert.ok(available.includes("tavily"));
    assert.equal(
      available.indexOf("tavily"),
      available.includes("openai") ? 1 : 0,
    );
    assert.equal(available[available.length - 1], "ollama");

    const chain = resolveSearchChain("tavily", cfg);
    assert.equal(chain[0], "tavily");
    assert.equal(chain[chain.length - 1], "ollama");
    assert.equal(new Set(chain).size, chain.length);
  } finally {
    restoreFs();
    restoreEnv(env);
  }
});

test("searchOrder and fetchOrder configure the fallback sequence", () => {
  const env = snapshotEnv();
  const restoreFs = hidePiAuthFile();
  try {
    delete process.env.OPENAI_API_KEY;
    delete process.env.EXA_API_KEY;
    delete process.env.FIRECRAWL_API_KEY;
    delete process.env.TAVILY_API_KEY;
    delete process.env.OLLAMA_HOST;

    process.env.EXA_API_KEY = "exa-key";
    process.env.TAVILY_API_KEY = "tvly-key";
    process.env.FIRECRAWL_API_KEY = "fc-key";
    const cfg = {
      searchOrder: ["firecrawl", "tavily"] as SearchProviderName[],
      fetchOrder: ["direct", "tavily"] as FetchProviderName[],
    };

    // Unlisted credentialed providers still join the end in canonical order.
    assert.deepEqual(
      resolveSearchChain(undefined, cfg),
      ["firecrawl", "tavily", "exa", "ollama"],
    );
    assert.deepEqual(
      resolveFetchChain(undefined, cfg),
      ["direct", "tavily", "firecrawl", "exa"],
    );

    // A requested provider still jumps the queue; the configured order
    // follows, then the remaining available providers.
    assert.deepEqual(
      resolveFetchChain("ollama", cfg),
      ["ollama", "direct", "tavily", "firecrawl", "exa"],
    );
  } finally {
    restoreFs();
    restoreEnv(env);
  }
});

test("order entries without credentials or with unknown names are dropped", () => {
  const env = snapshotEnv();
  const restoreFs = hidePiAuthFile();
  try {
    delete process.env.OPENAI_API_KEY;
    delete process.env.EXA_API_KEY;
    delete process.env.FIRECRAWL_API_KEY;
    delete process.env.TAVILY_API_KEY;
    delete process.env.OLLAMA_HOST;

    process.env.TAVILY_API_KEY = "tvly-key";
    // Config files arrive as untyped JSON, so bogus names are possible.
    const cfg = JSON.parse(
      '{"searchOrder": ["firecrawl", "bogus"], "fetchOrder": ["exa", "bogus"]}',
    ) as WebSearchConfig;

    assert.deepEqual(resolveSearchChain(undefined, cfg), ["tavily", "ollama"]);
    assert.deepEqual(resolveFetchChain(undefined, cfg), ["tavily", "direct"]);
  } finally {
    restoreFs();
    restoreEnv(env);
  }
});

test("search: quota-exhausted provider is skipped for the rest of the session", async () => {
  const originalFetch = globalThis.fetch;
  const restoreFs = hidePiAuthFile();
  const env = snapshotEnv();
  const control: MockControl = { calls: [], firecrawlStatus: 402, exaStatus: 200 };
  try {
    delete process.env.OPENAI_API_KEY;
    process.env.EXA_API_KEY = "exa-key";
    process.env.FIRECRAWL_API_KEY = "fc-key";
    delete process.env.TAVILY_API_KEY;
    delete process.env.OLLAMA_HOST;
    installFetchMock(control);

    const runtime = createWebSearchRuntime();
    const service = runtime.runSync(WebSearchRuntime);

    // First call: firecrawl answers 402 -> falls back to exa within the call.
    const first = await runWebSearch(
      runtime,
      service.search("fallback test", {}, "firecrawl"),
    );
    assert.equal(first.provider, "exa");
    assert.ok(
      first.fallbacks?.some(
        (f) => f.provider === "firecrawl" && f.reason.includes("402"),
      ),
    );
    const callsAfterFirst = firecrawlCalls(control);
    assert.ok(callsAfterFirst >= 1);

    // Session health records firecrawl as blocked for the session.
    const health = await runWebSearch(runtime, service.providerHealth);
    const firecrawlHealth = health.find((h) => h.provider === "firecrawl");
    assert.ok(firecrawlHealth);
    assert.equal(firecrawlHealth.msLeft, null);

    // Second call: goes straight to exa without touching firecrawl again.
    const second = await runWebSearch(
      runtime,
      service.search("fallback test again", {}, "firecrawl"),
    );
    assert.equal(second.provider, "exa");
    assert.equal(firecrawlCalls(control), callsAfterFirst);
    assert.equal(second.fallbacks, undefined);

    await runtime.dispose();
  } finally {
    globalThis.fetch = originalFetch;
    restoreFs();
    restoreEnv(env);
  }
});

test("search: walks the whole chain and reports an aggregated error", async () => {
  const originalFetch = globalThis.fetch;
  const restoreFs = hidePiAuthFile();
  const env = snapshotEnv();
  const control: MockControl = { calls: [], firecrawlStatus: 402, exaStatus: 402 };
  try {
    delete process.env.OPENAI_API_KEY;
    process.env.EXA_API_KEY = "exa-key";
    process.env.FIRECRAWL_API_KEY = "fc-key";
    delete process.env.TAVILY_API_KEY;
    delete process.env.OLLAMA_HOST;
    installFetchMock(control);

    const runtime = createWebSearchRuntime();
    const service = runtime.runSync(WebSearchRuntime);

    // First call: firecrawl (402) -> exa (402) -> ollama (404 endpoints) all fail.
    await assert.rejects(
      async () => {
        await runWebSearch(runtime, service.search("q", {}, "firecrawl"));
      },
      (err: Error) => /firecrawl/i.test(err.message) && /exa/i.test(err.message),
    );

    // Second call: firecrawl and exa are session-blocked, only ollama is tried.
    await assert.rejects(
      async () => {
        await runWebSearch(runtime, service.search("q", {}, "firecrawl"));
      },
      (err: Error) =>
        /ollama/i.test(err.message) && !/firecrawl/i.test(err.message),
    );

    await runtime.dispose();
  } finally {
    globalThis.fetch = originalFetch;
    restoreFs();
    restoreEnv(env);
  }
});

test("fetch: falls back through firecrawl -> exa -> direct within one call", async () => {
  const originalFetch = globalThis.fetch;
  const restoreFs = hidePiAuthFile();
  const env = snapshotEnv();
  const control: MockControl = { calls: [], firecrawlStatus: 402, exaStatus: 402 };
  try {
    delete process.env.OPENAI_API_KEY;
    process.env.EXA_API_KEY = "exa-key";
    process.env.FIRECRAWL_API_KEY = "fc-key";
    delete process.env.TAVILY_API_KEY;
    delete process.env.OLLAMA_HOST;

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      control.calls.push(url);
      if (url.includes("firecrawl.dev")) {
        return new Response("out of credits", { status: 402 });
      }
      if (url.includes("api.exa.ai")) {
        return new Response("quota exceeded", { status: 402 });
      }
      return new Response(
        "<html><head><title>Direct Page</title></head><body><p>Body</p></body></html>",
        { status: 200, headers: { "Content-Type": "text/html" } },
      );
    }) as typeof fetch;

    const runtime = createWebSearchRuntime();
    const service = runtime.runSync(WebSearchRuntime);

    const res = await runWebSearch(
      runtime,
      service.fetch("https://example.com/article", {}, "firecrawl"),
    );
    assert.equal(res.provider, "direct");
    assert.deepEqual(
      res.fallbacks?.map((f) => f.provider),
      ["firecrawl", "exa"],
    );

    await runtime.dispose();
  } finally {
    globalThis.fetch = originalFetch;
    restoreFs();
    restoreEnv(env);
  }
});
