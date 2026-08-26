import assert from "node:assert/strict";
import test from "node:test";
import { searchExa, fetchExa } from "../lib/exa.ts";
import { searchFirecrawl, fetchFirecrawl } from "../lib/firecrawl.ts";
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

  try {
    process.env.FIRECRAWL_API_KEY = "fc-key";

    globalThis.fetch = async (input) => {
      const urlStr = String(input);
      if (urlStr.includes("/search")) {
        return new Response(
          JSON.stringify({
            success: true,
            data: [
              {
                url: "https://example.com/firecrawl-doc",
                title: "Firecrawl Doc",
                description: "Firecrawl search snippet",
              },
            ],
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

    const fetchRes = await fetchFirecrawl("https://example.com/firecrawl-doc");
    assert.equal(fetchRes.provider, "firecrawl");
    assert.match(fetchRes.text, /# Scraped Markdown/);
    assert.equal(fetchRes.title, "Scraped Title");
  } finally {
    globalThis.fetch = originalFetch;
    process.env.FIRECRAWL_API_KEY = originalKey;
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
