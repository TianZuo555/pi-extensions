import assert from "node:assert/strict";
import test from "node:test";
import { hidePiAuthFile, hideStoredConfig, isolateProviderEnv, stubFetch } from "./helpers.ts";
import { searchBrave } from "../lib/brave.ts";
import { fetchParallel, searchParallel } from "../lib/parallel.ts";
import { fetchTinyfish, searchTinyfish } from "../lib/tinyfish.ts";

isolateProviderEnv();

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Statuses a target site can answer with; none may leak into a provider's error text. */
const TARGET_STATUSES = [403, 402, 429, 404];

// ---------------------------------------------------------------- Brave

test("searchBrave asks for plain-text web results and maps them", async (t) => {
  process.env.BRAVE_API_KEY = "brave-key";
  const stub = stubFetch(() =>
    json({
      web: {
        results: [
          { title: "Scala 3", url: "https://a.example/scala", description: "The next Scala" },
          { title: "", url: "https://b.example/" },
          { title: "No URL", description: "dropped: nothing to link to" },
        ],
      },
    }),
  );
  t.after(stub.restore);

  const res = await searchBrave("scala 3");

  const [call] = stub.calls;
  assert.equal(
    call.url.origin + call.url.pathname,
    "https://api.search.brave.com/res/v1/web/search",
  );
  assert.equal(call.url.searchParams.get("q"), "scala 3");
  assert.equal(call.url.searchParams.get("count"), "8", "defaults to 8 results");
  assert.equal(call.url.searchParams.get("result_filter"), "web");
  assert.equal(
    call.url.searchParams.get("text_decorations"),
    "false",
    "without this Brave wraps matches in <strong> tags",
  );
  assert.equal(call.headers["X-Subscription-Token"], "brave-key");
  assert.deepEqual(res, {
    query: "scala 3",
    provider: "brave",
    results: [
      { title: "Scala 3", url: "https://a.example/scala", snippet: "The next Scala" },
      { title: "https://b.example/", url: "https://b.example/", snippet: "" },
    ],
  });
});

test("searchBrave caps count at Brave's maximum of 20 and trims the result list", async (t) => {
  process.env.BRAVE_API_KEY = "brave-key";
  const many = Array.from({ length: 20 }, (_, i) => ({
    title: `T${i}`,
    url: `https://x.example/${i}`,
    description: "d",
  }));
  const stub = stubFetch(() => json({ web: { results: many } }));
  t.after(stub.restore);

  const res = await searchBrave("q", { numResults: 20 });
  assert.equal(stub.calls[0].url.searchParams.get("count"), "20");
  assert.equal(res.results.length, 20);

  const few = await searchBrave("q", { numResults: 3 });
  assert.equal(few.results.length, 3);
});

test("searchBrave scopes the query with site: operators for domain filters", async (t) => {
  process.env.BRAVE_API_KEY = "brave-key";
  const stub = stubFetch(() => json({ web: { results: [] } }));
  t.after(stub.restore);

  await searchBrave("rust", { domainFilter: ["docs.rs", "doc.rust-lang.org", "-pinterest.com"] });
  assert.equal(
    stub.calls[0].url.searchParams.get("q"),
    "rust (site:docs.rs OR site:doc.rust-lang.org) -site:pinterest.com",
  );
});

test("searchBrave surfaces API errors and a missing key", async (t) => {
  t.after(hidePiAuthFile());
  t.after(hideStoredConfig());
  await assert.rejects(() => searchBrave("q"), /BRAVE_API_KEY/);

  process.env.BRAVE_API_KEY = "brave-key";
  const stub = stubFetch(
    () => new Response("slow down", { status: 429, statusText: "Too Many Requests" }),
  );
  t.after(stub.restore);
  await assert.rejects(
    () => searchBrave("q"),
    /Brave search failed \(429 Too Many Requests\): slow down/,
  );
});

// -------------------------------------------------------------- Parallel

test("searchParallel asks for fast mode and maps excerpts to snippets", async (t) => {
  process.env.PARALLEL_API_KEY = "par-key";
  const stub = stubFetch(() =>
    json({
      results: [
        { title: "Doc", url: "https://a.example/doc", excerpts: ["first", "second"] },
        { title: null, url: "https://b.example/long", excerpts: ["x".repeat(500)] },
        { title: "Bare", url: "https://c.example/" },
      ],
    }),
  );
  t.after(stub.restore);

  const res = await searchParallel("effect v4", {
    numResults: 30,
    domainFilter: ["effect.website", "-pinterest.com"],
  });

  const [call] = stub.calls;
  assert.equal(String(call.url), "https://api.parallel.ai/v1/search");
  assert.equal(call.method, "POST");
  assert.equal(call.headers["x-api-key"], "par-key");
  assert.deepEqual(call.body, {
    objective: "effect v4",
    search_queries: ["effect v4"],
    mode: "fast",
    advanced_settings: {
      max_results: 20,
      source_policy: { include_domains: ["effect.website"], exclude_domains: ["pinterest.com"] },
    },
  });
  assert.equal(res.provider, "parallel");
  assert.deepEqual(res.results[0], {
    title: "Doc",
    url: "https://a.example/doc",
    snippet: "first ... second",
  });
  assert.equal(
    res.results[1].title,
    "https://b.example/long",
    "a null title falls back to the URL",
  );
  assert.equal(res.results[1].snippet.length, 400, "snippets are capped like Tavily's");
  assert.equal(res.results[2].snippet, "");
});

test("searchParallel sends no advanced settings when there is nothing to tune", async (t) => {
  process.env.PARALLEL_API_KEY = "par-key";
  const stub = stubFetch(() => json({ results: [] }));
  t.after(stub.restore);

  await searchParallel("q");
  assert.deepEqual(stub.calls[0].body, { objective: "q", search_queries: ["q"], mode: "fast" });
});

test("Parallel calls go to the configured base URL without a doubled slash", async (t) => {
  process.env.PARALLEL_API_KEY = "par-key";
  process.env.PARALLEL_BASE_URL = "https://parallel.internal/";
  const stub = stubFetch(() =>
    json({ results: [{ url: "https://x.example/p", full_content: "body" }], errors: [] }),
  );
  t.after(stub.restore);

  await searchParallel("q");
  await fetchParallel("https://x.example/p");
  assert.deepEqual(
    stub.calls.map((call) => String(call.url)),
    ["https://parallel.internal/v1/search", "https://parallel.internal/v1/extract"],
  );
});

test("fetchParallel requests full content and maps the page", async (t) => {
  process.env.PARALLEL_API_KEY = "par-key";
  const url = "https://x.example/page";
  const stub = stubFetch(() =>
    json({ results: [{ url, title: "Page", full_content: "# Hello" }], errors: [] }),
  );
  t.after(stub.restore);

  const res = await fetchParallel(url);

  const [call] = stub.calls;
  assert.equal(String(call.url), "https://api.parallel.ai/v1/extract");
  assert.deepEqual(call.body, { urls: [url], advanced_settings: { full_content: true } });
  assert.deepEqual(res, {
    url,
    title: "Page",
    text: "# Hello",
    provider: "parallel",
    contentType: "text/markdown",
  });
});

test("fetchParallel reports unreadable pages without the target's HTTP status", async () => {
  process.env.PARALLEL_API_KEY = "par-key";
  const url = "https://x.example/page";
  for (const status of TARGET_STATUSES) {
    const stub = stubFetch(() =>
      json({
        results: [],
        errors: [{ url, error_type: "fetch_error", http_status_code: status, content: null }],
      }),
    );
    try {
      await assert.rejects(
        () => fetchParallel(url),
        (err: Error) => {
          // The runtime reads 402/403/429 in an error as the provider's own quota.
          assert.equal(err.message, `Parallel could not extract ${url}: fetch_error`);
          return true;
        },
        `target status ${status}`,
      );
    } finally {
      stub.restore();
    }
  }
});

test("fetchParallel rejects an empty page and an API error", async (t) => {
  process.env.PARALLEL_API_KEY = "par-key";
  const url = "https://x.example/page";
  let respond = () => json({ results: [{ url, full_content: "  " }], errors: [] });
  const stub = stubFetch(() => respond());
  t.after(stub.restore);

  await assert.rejects(() => fetchParallel(url), /returned no full content/);

  respond = () => new Response("bad key", { status: 401, statusText: "Unauthorized" });
  await assert.rejects(() => fetchParallel(url), /Parallel extract failed \(401 Unauthorized\)/);
});

// -------------------------------------------------------------- TinyFish

test("searchTinyfish queries its search endpoint and caps results locally", async (t) => {
  process.env.TINYFISH_API_KEY = "tf-key";
  const stub = stubFetch(() =>
    json({
      results: Array.from({ length: 10 }, (_, i) => ({
        position: i + 1,
        title: `T${i}`,
        url: `https://x.example/${i}`,
        snippet: `s${i}`,
      })),
    }),
  );
  t.after(stub.restore);

  const res = await searchTinyfish("rust async", {
    numResults: 3,
    domainFilter: ["docs.rs", "tokio.rs", "-pinterest.com"],
  });

  const [call] = stub.calls;
  assert.equal(call.url.origin, "https://api.search.tinyfish.ai");
  assert.equal(call.url.searchParams.get("query"), "rust async");
  assert.equal(call.url.searchParams.get("include_domains"), "docs.rs,tokio.rs");
  assert.equal(call.url.searchParams.get("exclude_domains"), "pinterest.com");
  assert.equal(call.headers["X-API-Key"], "tf-key");
  assert.equal(res.provider, "tinyfish");
  assert.deepEqual(
    res.results.map((r) => r.title),
    ["T0", "T1", "T2"],
    "TinyFish has no count parameter, so the cap is applied here",
  );
});

test("fetchTinyfish asks for bounded-age markdown within a 30s page budget", async (t) => {
  process.env.TINYFISH_API_KEY = "tf-key";
  const url = "https://x.example/page";
  const stub = stubFetch(() =>
    json({ results: [{ url, final_url: url, title: "Page", text: "# Hello" }], errors: [] }),
  );
  t.after(stub.restore);

  const res = await fetchTinyfish(url);

  const [call] = stub.calls;
  assert.equal(String(call.url), "https://api.fetch.tinyfish.ai/");
  assert.equal(call.method, "POST");
  assert.equal(call.headers["X-API-Key"], "tf-key");
  assert.deepEqual(call.body, {
    urls: [url],
    format: "markdown",
    ttl: 172_800,
    per_url_timeout_ms: 30_000,
  });
  assert.deepEqual(res, {
    url,
    title: "Page",
    text: "# Hello",
    provider: "tinyfish",
    contentType: "text/markdown",
  });
});

test("fetchTinyfish honours raw by asking for HTML", async (t) => {
  process.env.TINYFISH_API_KEY = "tf-key";
  const url = "https://x.example/page";
  const stub = stubFetch(() => json({ results: [{ url, text: "<h1>Hello</h1>" }], errors: [] }));
  t.after(stub.restore);

  const res = await fetchTinyfish(url, { raw: true });
  assert.equal((stub.calls[0].body as { format: string }).format, "html");
  assert.equal(res.contentType, "text/html");
  assert.equal(res.text, "<h1>Hello</h1>");
});

test("fetchTinyfish reports unreadable pages without the target's HTTP status", async () => {
  process.env.TINYFISH_API_KEY = "tf-key";
  const url = "https://x.example/page";
  for (const status of TARGET_STATUSES) {
    const code = status === 404 ? "page_not_found" : "target_http_error";
    const stub = stubFetch(() => json({ results: [], errors: [{ url, error: code, status }] }));
    try {
      await assert.rejects(
        () => fetchTinyfish(url),
        (err: Error) => {
          // The runtime reads 402/403/429 in an error as the provider's own quota.
          assert.equal(err.message, `TinyFish could not fetch ${url}: ${code}`);
          return true;
        },
        `target status ${status}`,
      );
    } finally {
      stub.restore();
    }
  }
});

test("fetchTinyfish rejects an empty page and an API error", async (t) => {
  process.env.TINYFISH_API_KEY = "tf-key";
  const url = "https://x.example/page";
  let respond = () => json({ results: [{ url, text: " " }], errors: [] });
  const stub = stubFetch(() => respond());
  t.after(stub.restore);

  await assert.rejects(() => fetchTinyfish(url), /returned no readable content/);

  respond = () => new Response("nope", { status: 429, statusText: "Too Many Requests" });
  await assert.rejects(() => fetchTinyfish(url), /TinyFish fetch failed \(429 Too Many Requests\)/);
});

test("TinyFish search and fetch use separate, configurable endpoints", async (t) => {
  process.env.TINYFISH_API_KEY = "tf-key";
  process.env.TINYFISH_BASE_URL = "https://search.internal/q";
  process.env.TINYFISH_FETCH_URL = "https://fetch.internal/f";
  const url = "https://x.example/page";
  const stub = stubFetch((call) =>
    call.method === "GET"
      ? json({ results: [] })
      : json({ results: [{ url, text: "body" }], errors: [] }),
  );
  t.after(stub.restore);

  await searchTinyfish("q");
  await fetchTinyfish(url);
  assert.deepEqual(
    stub.calls.map((call) => call.url.origin + call.url.pathname),
    ["https://search.internal/q", "https://fetch.internal/f"],
  );
});
