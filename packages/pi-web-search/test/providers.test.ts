import assert from "node:assert/strict";
import test from "node:test";
import { hidePiAuthFile } from "./helpers.ts";
import { searchExa, fetchExa } from "../lib/exa.ts";
import {
  resetFirecrawlKeylessState,
  searchFirecrawl,
  fetchFirecrawl,
} from "../lib/firecrawl.ts";
import { searchMonid, fetchMonid, getMonidWallet, listMonidRuns } from "../lib/monid.ts";
import { searchOllama, fetchOllama } from "../lib/ollama.ts";
import { searchOpenAI } from "../lib/openai.ts";
import { searchTavily, fetchTavily } from "../lib/tavily.ts";

test("searchOpenAI parses JSON Responses API output with citations", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENAI_API_KEY;

  try {
    process.env.OPENAI_API_KEY = "sk-test";

    const mockOutput = {
      output: [
        {
          type: "message",
          content: [
            {
              type: "text",
              text: "Here is the documentation about Node 26 features.",
              annotations: [
                {
                  type: "url_citation",
                  url: "https://nodejs.org/en/blog/release/v26",
                  title: "Node.js v26 Release Notes",
                  start_index: 26,
                  end_index: 42,
                },
              ],
            },
          ],
        },
        {
          type: "web_search_call",
          action: {
            sources: [
              {
                url: "https://nodejs.org/en/blog/release/v26",
                title: "Node.js v26 Release Notes",
              },
            ],
          },
        },
      ],
    };

    globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { store?: unknown };
      assert.equal(body.store, false);
      return new Response(JSON.stringify(mockOutput), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const res = await searchOpenAI("node 26 release");
    assert.equal(res.provider, "openai");
    assert.equal(res.answer, "Here is the documentation about Node 26 features.");
    assert.equal(res.results.length, 1);
    assert.equal(res.results[0].url, "https://nodejs.org/en/blog/release/v26");
    assert.equal(res.results[0].title, "Node.js v26 Release Notes");
  } finally {
    globalThis.fetch = originalFetch;
    process.env.OPENAI_API_KEY = originalKey;
  }
});

test("searchExa and fetchExa handle Exa API responses", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.EXA_API_KEY;

  try {
    process.env.EXA_API_KEY = "exa-key";

    globalThis.fetch = async (input, init) => {
      const urlStr = String(input);
      if (urlStr.includes("/search")) {
        return new Response(
          JSON.stringify({
            results: [
              {
                id: "https://example.com/exa-doc",
                title: "Exa Document",
                snippet: "Exa search snippet content",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (urlStr.includes("/contents")) {
        return new Response(
          JSON.stringify({
            results: [
              {
                id: "https://example.com/exa-doc",
                title: "Exa Document",
                text: "Full text content from Exa",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("Not found", { status: 404 });
    };

    const searchRes = await searchExa("test exa");
    assert.equal(searchRes.provider, "exa");
    assert.equal(searchRes.results.length, 1);
    assert.equal(searchRes.results[0].url, "https://example.com/exa-doc");

    const fetchRes = await fetchExa("https://example.com/exa-doc");
    assert.equal(fetchRes.provider, "exa");
    assert.equal(fetchRes.text, "Full text content from Exa");
  } finally {
    globalThis.fetch = originalFetch;
    process.env.EXA_API_KEY = originalKey;
  }
});

test("searchFirecrawl and fetchFirecrawl handle Firecrawl API responses", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.FIRECRAWL_API_KEY;
  const originalKeyless = process.env.FIRECRAWL_KEYLESS;

  try {
    // Opt out of the keyless tier so this exercises the keyed path.
    process.env.FIRECRAWL_API_KEY = "fc-key";
    process.env.FIRECRAWL_KEYLESS = "0";
    resetFirecrawlKeylessState();

    let sawAuthHeader = false;
    globalThis.fetch = async (input, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (headers.Authorization === "Bearer fc-key") sawAuthHeader = true;
      const urlStr = String(input);
      if (urlStr.includes("/search")) {
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              web: [
                {
                  url: "https://example.com/firecrawl-doc",
                  title: "Firecrawl Doc",
                  description: "Firecrawl search snippet",
                },
              ],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (urlStr.includes("/scrape")) {
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              markdown: "# Scraped Markdown\n\nContent body",
              metadata: { title: "Scraped Title" },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("Not found", { status: 404 });
    };

    const searchRes = await searchFirecrawl("test firecrawl");
    assert.equal(searchRes.provider, "firecrawl");
    assert.equal(searchRes.results.length, 1);
    assert.ok(sawAuthHeader, "keyed requests must carry the Bearer header");

    const fetchRes = await fetchFirecrawl("https://example.com/firecrawl-doc");
    assert.equal(fetchRes.provider, "firecrawl");
    assert.match(fetchRes.text, /# Scraped Markdown/);
    assert.equal(fetchRes.title, "Scraped Title");
  } finally {
    globalThis.fetch = originalFetch;
    resetFirecrawlKeylessState();
    process.env.FIRECRAWL_API_KEY = originalKey;
    if (originalKeyless !== undefined) {
      process.env.FIRECRAWL_KEYLESS = originalKeyless;
    } else {
      delete process.env.FIRECRAWL_KEYLESS;
    }
  }
});

test("firecrawl keyless tier omits the Authorization header", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.FIRECRAWL_API_KEY;
  const restoreFs = hidePiAuthFile();

  try {
    delete process.env.FIRECRAWL_API_KEY;
    delete process.env.FIRECRAWL_KEYLESS;
    resetFirecrawlKeylessState();

    const authHeaders: Array<string | undefined> = [];
    globalThis.fetch = async (_input, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      authHeaders.push(headers.Authorization);
      return new Response(
        JSON.stringify({
          success: true,
          data: [
            {
              url: "https://example.com/keyless",
              title: "Keyless Result",
              description: "keyless snippet",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const res = await searchFirecrawl("test keyless");
    assert.equal(res.provider, "firecrawl");
    assert.equal(res.results.length, 1);
    assert.deepEqual(authHeaders, [undefined]);
  } finally {
    globalThis.fetch = originalFetch;
    resetFirecrawlKeylessState();
    restoreFs();
    if (originalKey !== undefined) {
      process.env.FIRECRAWL_API_KEY = originalKey;
    } else {
      delete process.env.FIRECRAWL_API_KEY;
    }
  }
});

test("firecrawl keyless exhaustion overflows to the user key and is remembered", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.FIRECRAWL_API_KEY;
  const restoreFs = hidePiAuthFile();

  try {
    // Key present + keyless enabled: keyless first, key as overflow.
    process.env.FIRECRAWL_API_KEY = "fc-key";
    delete process.env.FIRECRAWL_KEYLESS;
    resetFirecrawlKeylessState();

    let keylessCalls = 0;
    let keyedCalls = 0;
    globalThis.fetch = async (_input, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (headers.Authorization === "Bearer fc-key") {
        keyedCalls += 1;
        return new Response(
          JSON.stringify({
            success: true,
            data: [{ url: "https://example.com/paid", title: "Paid", description: "d" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      keylessCalls += 1;
      return new Response("quota exhausted", { status: 402 });
    };

    const first = await searchFirecrawl("q1");
    assert.equal(first.results[0].url, "https://example.com/paid");
    assert.equal(keylessCalls, 1);
    assert.equal(keyedCalls, 1);

    // Exhaustion is remembered: the next call skips the keyless attempt.
    const second = await searchFirecrawl("q2");
    assert.equal(second.results[0].url, "https://example.com/paid");
    assert.equal(keylessCalls, 1);
    assert.equal(keyedCalls, 2);
  } finally {
    globalThis.fetch = originalFetch;
    resetFirecrawlKeylessState();
    restoreFs();
    if (originalKey !== undefined) {
      process.env.FIRECRAWL_API_KEY = originalKey;
    } else {
      delete process.env.FIRECRAWL_API_KEY;
    }
  }
});

test("firecrawl keyless exhaustion without a key surfaces a 402 error", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.FIRECRAWL_API_KEY;
  const restoreFs = hidePiAuthFile();

  try {
    delete process.env.FIRECRAWL_API_KEY;
    delete process.env.FIRECRAWL_KEYLESS;
    resetFirecrawlKeylessState();

    globalThis.fetch = async () => new Response("quota exhausted", { status: 402 });

    await assert.rejects(
      () => searchFirecrawl("q"),
      (err: Error) => /402/.test(err.message) && /keyless/.test(err.message),
    );
  } finally {
    globalThis.fetch = originalFetch;
    resetFirecrawlKeylessState();
    restoreFs();
    if (originalKey !== undefined) {
      process.env.FIRECRAWL_API_KEY = originalKey;
    } else {
      delete process.env.FIRECRAWL_API_KEY;
    }
  }
});

test("searchTavily and fetchTavily handle Tavily API responses", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.TAVILY_API_KEY;

  try {
    process.env.TAVILY_API_KEY = "tvly-key";

    globalThis.fetch = async (input, init) => {
      const urlStr = String(input);
      if (urlStr.includes("/search")) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        assert.equal(body.include_answer, true);
        return new Response(
          JSON.stringify({
            query: "test tavily",
            answer: "Tavily synthesized answer",
            results: [
              {
                title: "Tavily Doc",
                url: "https://example.com/tavily-doc",
                content: "Tavily search snippet",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (urlStr.includes("/extract")) {
        return new Response(
          JSON.stringify({
            results: [
              {
                url: "https://example.com/tavily-doc",
                raw_content: "# Extracted Markdown\n\nBody content",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("Not found", { status: 404 });
    };

    const searchRes = await searchTavily("test tavily");
    assert.equal(searchRes.provider, "tavily");
    assert.equal(searchRes.results.length, 1);
    assert.equal(searchRes.results[0].url, "https://example.com/tavily-doc");
    assert.equal(searchRes.results[0].snippet, "Tavily search snippet");
    assert.equal(searchRes.answer, "Tavily synthesized answer");

    const fetchRes = await fetchTavily("https://example.com/tavily-doc");
    assert.equal(fetchRes.provider, "tavily");
    assert.match(fetchRes.text, /# Extracted Markdown/);
  } finally {
    globalThis.fetch = originalFetch;
    process.env.TAVILY_API_KEY = originalKey;
  }
});

test("searchOllama and fetchOllama handle Ollama responses", async () => {
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async (input) => {
      const urlStr = String(input);
      if (urlStr.includes("web_search")) {
        return new Response(
          JSON.stringify({
            results: [
              {
                url: "https://example.com/ollama-result",
                title: "Ollama Result",
                snippet: "Ollama search snippet",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (urlStr.includes("web_fetch")) {
        return new Response(
          JSON.stringify({
            title: "Ollama Page",
            text: "Ollama fetched content",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("Not found", { status: 404 });
    };

    const searchRes = await searchOllama("test query");
    assert.equal(searchRes.provider, "ollama");
    assert.equal(searchRes.results.length, 1);
    assert.equal(searchRes.results[0].url, "https://example.com/ollama-result");

    const fetchRes = await fetchOllama("https://example.com/ollama-result");
    assert.equal(fetchRes.provider, "ollama");
    assert.equal(fetchRes.text, "Ollama fetched content");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("getMonidWallet and listMonidRuns read the Monid wallet API", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.MONID_API_KEY;
  const restoreFs = hidePiAuthFile();

  try {
    // Not configured -> both helpers report null instead of throwing.
    delete process.env.MONID_API_KEY;
    assert.equal(await getMonidWallet(), null);
    assert.equal(await listMonidRuns(), null);

    process.env.MONID_API_KEY = "monid_live_test";
    const paths: string[] = [];
    globalThis.fetch = async (input) => {
      const urlStr = String(input);
      paths.push(urlStr);
      if (urlStr.includes("/v1/wallet/balance")) {
        return new Response(
          JSON.stringify({
            balance: { value: 1, currency: "USD" },
            held: { value: 0, currency: "USD" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (urlStr.includes("/v1/runs")) {
        return new Response(
          JSON.stringify({
            items: [
              {
                runId: "01H",
                provider: "tinyfish",
                endpoint: "/search",
                status: "COMPLETED",
                cost: { value: 0, currency: "USD" },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("Not found", { status: 404 });
    };

    const wallet = await getMonidWallet();
    assert.equal(wallet?.balance.value, 1);
    const runs = await listMonidRuns(5);
    assert.equal(runs?.length, 1);
    assert.equal(runs?.[0].provider, "tinyfish");
    assert.ok(paths.some((p) => p.includes("limit=5")));
  } finally {
    globalThis.fetch = originalFetch;
    restoreFs();
    if (originalKey !== undefined) {
      process.env.MONID_API_KEY = originalKey;
    } else {
      delete process.env.MONID_API_KEY;
    }
  }
});

test("searchMonid and fetchMonid handle Monid (TinyFish) run responses", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.MONID_API_KEY;

  try {
    process.env.MONID_API_KEY = "monid_live_test";

    const requestBodies: unknown[] = [];
    globalThis.fetch = async (input, init) => {
      const urlStr = String(input);
      assert.ok(urlStr.startsWith("https://api.monid.ai/v1/run"));
      assert.equal(
        (init?.headers as Record<string, string>).Authorization,
        "Bearer monid_live_test",
      );
      const body = JSON.parse(String(init?.body)) as {
        provider: string;
        endpoint: string;
        input: Record<string, unknown>;
      };
      assert.equal(body.provider, "tinyfish");
      requestBodies.push(body);
      if (body.endpoint === "/search") {
        return new Response(
          JSON.stringify({
            status: "COMPLETED",
            providerResponse: { httpStatus: 200 },
            output: {
              results: [
                {
                  position: 1,
                  title: "TinyFish Result",
                  url: "https://example.com/tinyfish",
                  site_name: "example.com",
                  snippet: "TinyFish search snippet",
                  date: "2 days ago",
                },
                { position: 2, title: "No url" },
              ],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          status: "COMPLETED",
          providerResponse: { httpStatus: 200 },
          output: {
            results: [
              {
                url: "https://example.com/tinyfish",
                title: "TinyFish Page",
                text: "TinyFish fetched markdown",
              },
            ],
            errors: [],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const searchRes = await searchMonid("test monid", { numResults: 5 });
    assert.equal(searchRes.provider, "monid");
    assert.equal(searchRes.results.length, 1);
    assert.equal(searchRes.results[0].url, "https://example.com/tinyfish");
    assert.equal(searchRes.results[0].snippet, "TinyFish search snippet");

    const fetchRes = await fetchMonid("https://example.com/tinyfish");
    assert.equal(fetchRes.provider, "monid");
    assert.equal(fetchRes.title, "TinyFish Page");
    assert.equal(fetchRes.text, "TinyFish fetched markdown");

    const searchBody = requestBodies[0] as unknown as {
      input: { queryParams: Record<string, string> };
    };
    assert.equal(searchBody.input.queryParams.query, "test monid");
    const fetchBody = requestBodies[1] as unknown as {
      input: { body: { urls: string[]; format: string } };
    };
    assert.deepEqual(fetchBody.input.body.urls, ["https://example.com/tinyfish"]);
    assert.equal(fetchBody.input.body.format, "markdown");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey !== undefined) {
      process.env.MONID_API_KEY = originalKey;
    } else {
      delete process.env.MONID_API_KEY;
    }
  }
});

test("fetchMonid maps raw to html format and surfaces per-URL errors", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.MONID_API_KEY;

  try {
    process.env.MONID_API_KEY = "monid_live_test";

    globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        input: { body: { format: string } };
      };
      assert.equal(body.input.body.format, "html");
      return new Response(
        JSON.stringify({
          status: "COMPLETED",
          providerResponse: { httpStatus: 200 },
          output: {
            results: [],
            errors: [{ url: "https://blocked.example.com/", error: "bot_blocked" }],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    await assert.rejects(
      () => fetchMonid("https://blocked.example.com/", { raw: true }),
      /bot_blocked/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey !== undefined) {
      process.env.MONID_API_KEY = originalKey;
    } else {
      delete process.env.MONID_API_KEY;
    }
  }
});

test("searchMonid passes domain filters and respects a provider error status", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.MONID_API_KEY;

  try {
    process.env.MONID_API_KEY = "monid_live_test";

    let calls = 0;
    globalThis.fetch = async (_input, init) => {
      calls += 1;
      if (calls === 1) {
        const body = JSON.parse(String(init?.body)) as {
          input: { queryParams: Record<string, string> };
        };
        assert.equal(body.input.queryParams.include_domains, "example.com,docs.example.com");
        assert.equal(body.input.queryParams.exclude_domains, "pinterest.com");
        return new Response(
          JSON.stringify({
            status: "COMPLETED",
            providerResponse: { httpStatus: 200 },
            output: { results: [] },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      // Provider-side error: insufficient balance (402) mirrors through.
      return new Response(
        JSON.stringify({
          status: "COMPLETED",
          providerResponse: {
            httpStatus: 402,
            error: { message: "insufficient balance" },
          },
        }),
        { status: 402, headers: { "Content-Type": "application/json" } },
      );
    };

    const empty = await searchMonid("q", {
      domainFilter: ["example.com", "docs.example.com", "-pinterest.com"],
    });
    assert.equal(empty.results.length, 0);

    await assert.rejects(
      () => searchMonid("q"),
      (err: Error) => /402/.test(err.message) && /insufficient balance/.test(err.message),
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey !== undefined) {
      process.env.MONID_API_KEY = originalKey;
    } else {
      delete process.env.MONID_API_KEY;
    }
  }
});
