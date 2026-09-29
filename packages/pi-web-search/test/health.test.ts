import assert from "node:assert/strict";
import test from "node:test";
import { hidePiAuthFile, hideStoredConfig, isolateProviderEnv } from "./helpers.ts";
import { createWebSearchRuntime, runWebSearch, WebSearchRuntime } from "../src/runtime.ts";

isolateProviderEnv();

/**
 * Session health must reflect the *provider*, never the page it was asked for.
 * A provider that answers "I could not read this URL" is healthy; only its own
 * quota, key and rate-limit errors may take it out of the chain.
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

interface Scenario {
  env: Record<string, string>;
  /** The provider's own API; return undefined for anything else (= the target site). */
  api: (requestUrl: string, requested: string, target: number) => Response | undefined;
}

// Each shape is how that provider's API reports a page it could not read:
// taken from the vendor docs, and observed live for Firecrawl.
const SCENARIOS: Record<string, Scenario> = {
  firecrawl: {
    env: { FIRECRAWL_API_KEY: "fc-key" },
    api: (u, requested, target) =>
      u.startsWith("https://api.firecrawl.dev/")
        ? json({
            success: true,
            data: { markdown: "", metadata: { sourceURL: requested, statusCode: target } },
          })
        : undefined,
  },
  exa: {
    env: { EXA_API_KEY: "exa-key" },
    api: (u, requested, target) =>
      u.startsWith("https://api.exa.ai/contents")
        ? json({
            results: [],
            statuses: [
              {
                id: requested,
                status: "error",
                error: { tag: "CRAWL_NOT_FOUND", httpStatusCode: target },
              },
            ],
          })
        : undefined,
  },
  tavily: {
    env: { TAVILY_API_KEY: "tvly-key" },
    api: (u, requested) =>
      u.startsWith("https://api.tavily.com/extract")
        ? json({
            results: [],
            failed_results: [{ url: requested, error: "Failed to retrieve content" }],
          })
        : undefined,
  },
  monid: {
    env: { MONID_API_KEY: "monid-key" },
    api: (u, requested, target) =>
      u.startsWith("https://api.monid.ai/v1/run")
        ? json({
            status: "COMPLETED",
            providerResponse: { httpStatus: 200 },
            output: {
              results: [],
              errors: [{ url: requested, error: "target_http_error", status: target }],
            },
          })
        : undefined,
  },
  ollama: {
    env: { OLLAMA_HOST: "http://localhost:11434" },
    api: (u) =>
      u.endsWith("/api/experimental/web_fetch")
        ? new Response("not found", { status: 404 })
        : u.endsWith("/api/web_fetch")
          ? json({ title: "", content: "" })
          : undefined,
  },
  parallel: {
    env: { PARALLEL_API_KEY: "par-key" },
    api: (u, requested, target) =>
      u.startsWith("https://api.parallel.ai/v1/extract")
        ? json({
            results: [],
            errors: [
              {
                url: requested,
                error_type: "fetch_error",
                http_status_code: target,
                content: null,
              },
            ],
          })
        : undefined,
  },
  tinyfish: {
    env: { TINYFISH_API_KEY: "tf-key" },
    api: (u, requested, target) =>
      u.startsWith("https://api.fetch.tinyfish.ai")
        ? json({
            results: [],
            errors: [
              {
                url: requested,
                error: target === 404 ? "page_not_found" : "target_http_error",
                status: target,
              },
            ],
          })
        : undefined,
  },
  direct: { env: {}, api: () => undefined },
};

/** The page answers with an error status; the URL text is innocent. */
const TARGET_REFUSES = [403, 402, 429].map((target) => ({
  label: `the target answers ${target}`,
  url: "https://news.example/story",
  target,
}));

/** The page is a plain 404, but the URL text looks like a status code or a billing problem. */
const URL_LOOKS_LIKE_A_PROBLEM = [
  "https://github.com/acme/app/issues/403",
  "https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/429",
  "https://shop.example/credit-cards/quota",
].map((url) => ({ label: `the URL is ${url}`, url, target: 404 }));

interface Outcome {
  attempted: string[];
  health: Array<{ provider: string; reason: string; msLeft: number | null }>;
}

async function fetchThroughRuntime(
  scenario: Scenario,
  url: string,
  target: number,
  respond?: (requestUrl: string) => Response | undefined,
): Promise<Outcome> {
  const originalFetch = globalThis.fetch;
  const restoreAuth = hidePiAuthFile();
  const restoreConfig = hideStoredConfig();
  const runtime = createWebSearchRuntime();
  try {
    Object.assign(process.env, { FIRECRAWL_KEYLESS: "0" }, scenario.env);
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const requestUrl = String(input);
      return (
        respond?.(requestUrl) ??
        scenario.api(requestUrl, url, target) ??
        new Response("", { status: target })
      );
    }) as typeof fetch;

    const service = runtime.runSync(WebSearchRuntime);
    let message = "";
    try {
      await runWebSearch(runtime, service.fetch(url));
    } catch (error) {
      message = (error as Error).message;
    }
    const attempted = [...message.matchAll(/• ([a-z]+):/g)].map((match) => match[1]);
    const health = [...(await runWebSearch(runtime, service.providerHealth))];
    return { attempted, health };
  } finally {
    await runtime.dispose();
    globalThis.fetch = originalFetch;
    restoreConfig();
    restoreAuth();
  }
}

for (const [name, scenario] of Object.entries(SCENARIOS)) {
  test(`${name}: pages it cannot read never take it out of the chain`, async () => {
    for (const { label, url, target } of [...TARGET_REFUSES, ...URL_LOOKS_LIKE_A_PROBLEM]) {
      const { attempted, health } = await fetchThroughRuntime(scenario, url, target);
      assert.ok(attempted.includes(name), `${label}: ${name} was never tried (${attempted})`);
      assert.deepEqual(health, [], `${label}: ${name} must stay healthy`);
    }
  });
}

test("a provider's own quota error still blocks it for the session, whatever the URL says", async () => {
  const { health } = await fetchThroughRuntime(
    SCENARIOS.exa,
    "https://github.com/acme/app/issues/403",
    404,
    (requestUrl) =>
      requestUrl.startsWith("https://api.exa.ai/contents")
        ? new Response("out of credits", { status: 402, statusText: "Payment Required" })
        : undefined,
  );
  assert.equal(health.length, 1);
  assert.equal(health[0].provider, "exa");
  assert.equal(health[0].msLeft, null, "402 blocks for the rest of the session");
  assert.match(health[0].reason, /402 Payment Required/);
});

test("a provider's own rate limit still starts a cooldown", async () => {
  const { health } = await fetchThroughRuntime(
    SCENARIOS.tavily,
    "https://news.example/story",
    404,
    (requestUrl) =>
      requestUrl.startsWith("https://api.tavily.com/extract")
        ? new Response("slow down", { status: 429, statusText: "Too Many Requests" })
        : undefined,
  );
  assert.equal(health.length, 1);
  assert.equal(health[0].provider, "tavily");
  assert.ok(typeof health[0].msLeft === "number" && health[0].msLeft > 0, "429 is a cooldown");
});

test("direct is never skipped, however often target sites refuse it", async () => {
  const originalFetch = globalThis.fetch;
  const restoreAuth = hidePiAuthFile();
  const restoreConfig = hideStoredConfig();
  const runtime = createWebSearchRuntime();
  try {
    process.env.FIRECRAWL_KEYLESS = "0";
    let targetHits = 0;
    globalThis.fetch = (async () => {
      targetHits += 1;
      return new Response("", { status: targetHits === 2 ? 429 : 403 });
    }) as typeof fetch;

    const service = runtime.runSync(WebSearchRuntime);
    for (let i = 1; i <= 3; i++) {
      await assert.rejects(
        () => runWebSearch(runtime, service.fetch(`https://news.example/story-${i}`)),
        /direct: Failed to fetch/,
      );
    }
    assert.equal(targetHits, 3, "every request must still reach the target");
    assert.deepEqual(await runWebSearch(runtime, service.providerHealth), []);
  } finally {
    await runtime.dispose();
    globalThis.fetch = originalFetch;
    restoreConfig();
    restoreAuth();
  }
});
