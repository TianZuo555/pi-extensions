import assert from "node:assert/strict";
import test from "node:test";
import { hideStoredConfig } from "./helpers.ts";
import { createWebSearchRuntime, runWebSearch, WebSearchRuntime } from "../src/runtime.ts";

test("WebSearchRuntime search dispatches to resolved provider and returns results", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  const originalFirecrawlKey = process.env.FIRECRAWL_API_KEY;
  const originalKeyless = process.env.FIRECRAWL_KEYLESS;
  // Ignore the developer machine's real ~/.pi/web-search.json:
  // a configured searchProvider would win over the env-key canonical head.
  const restoreConfig = hideStoredConfig();

  try {
    process.env.OPENAI_API_KEY = "sk-test-key";
    // Keyless firecrawl would otherwise lead the canonical chain; opt this
    // scenario out so the resolved head is openai.
    delete process.env.FIRECRAWL_API_KEY;
    process.env.FIRECRAWL_KEYLESS = "0";

    const mockOutput = {
      output: [
        {
          type: "message",
          content: [
            {
              type: "text",
              text: "Search answer summary.",
              annotations: [
                {
                  type: "url_citation",
                  url: "https://example.com/result",
                  title: "Example Result",
                  start_index: 0,
                  end_index: 20,
                },
              ],
            },
          ],
        },
      ],
    };

    globalThis.fetch = async () =>
      new Response(JSON.stringify(mockOutput), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    const runtime = createWebSearchRuntime();
    const service = runtime.runSync(WebSearchRuntime);

    const res = await runWebSearch(runtime, service.search("effect v4 guide"));
    assert.equal(res.provider, "openai");
    assert.equal(res.answer, "Search answer summary.");
    assert.equal(res.results.length, 1);
    assert.equal(res.results[0].url, "https://example.com/result");

    await runtime.dispose();
  } finally {
    globalThis.fetch = originalFetch;
    restoreConfig();
    process.env.OPENAI_API_KEY = originalKey;
    if (originalFirecrawlKey !== undefined) {
      process.env.FIRECRAWL_API_KEY = originalFirecrawlKey;
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

test("WebSearchRuntime fetch handles fallback to direct fetch when scraper fails", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.FIRECRAWL_API_KEY;
  const originalMonidKey = process.env.MONID_API_KEY;
  const restoreConfig = hideStoredConfig();

  try {
    process.env.FIRECRAWL_API_KEY = "fc-key";
    delete process.env.MONID_API_KEY;

    globalThis.fetch = async (input) => {
      const urlStr = String(input);
      if (urlStr.includes("firecrawl.dev")) {
        return new Response("Scraper rate limited", { status: 429 });
      }
      return new Response(
        "<html><head><title>Direct Page</title></head><body><h1>Fallback Direct</h1><p>Body</p></body></html>",
        {
          status: 200,
          headers: { "Content-Type": "text/html" },
        },
      );
    };

    const runtime = createWebSearchRuntime();
    const service = runtime.runSync(WebSearchRuntime);

    const res = await runWebSearch(
      runtime,
      service.fetch("https://example.com/article", {}, "firecrawl"),
    );
    assert.equal(res.provider, "direct");
    assert.equal(res.title, "Direct Page");
    assert.match(res.text, /# Fallback Direct/);

    await runtime.dispose();
  } finally {
    globalThis.fetch = originalFetch;
    restoreConfig();
    process.env.FIRECRAWL_API_KEY = originalKey;
    if (originalMonidKey !== undefined) {
      process.env.MONID_API_KEY = originalMonidKey;
    } else {
      delete process.env.MONID_API_KEY;
    }
  }
});

test("WebSearchRuntime handles abort signals gracefully", async () => {
  const runtime = createWebSearchRuntime();
  const service = runtime.runSync(WebSearchRuntime);

  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    async () => {
      await runWebSearch(runtime, service.fetch("https://example.com/aborted"), {
        signal: controller.signal,
      });
    },
    (err: Error) => {
      return err.name === "AbortError" || err.message.includes("aborted");
    },
  );

  await runtime.dispose();
});
