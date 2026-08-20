import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeHtmlEntities,
  extractHtmlTitle,
  fetchDirect,
  htmlToMarkdown,
} from "../lib/direct-fetch.ts";

test("decodeHtmlEntities converts entities correctly", () => {
  assert.equal(
    decodeHtmlEntities("Hello &amp; welcome &lt;world&gt; &quot;quote&#39; &nbsp; &#65;"),
    'Hello & welcome <world> "quote\'   A',
  );
});

test("extractHtmlTitle parses <title>, og:title, and <h1>", () => {
  assert.equal(
    extractHtmlTitle("<html><head><title>My Documentation</title></head></html>"),
    "My Documentation",
  );
  assert.equal(
    extractHtmlTitle(
      '<html><head><meta property="og:title" content="OG Page Title" /></head></html>',
    ),
    "OG Page Title",
  );
  assert.equal(
    extractHtmlTitle("<html><body><h1>Main Heading</h1></body></html>"),
    "Main Heading",
  );
});

test("htmlToMarkdown strips scripts, styles, and extracts readable content", () => {
  const html = `
    <html>
      <head>
        <title>Test Page</title>
        <style>body { color: red; }</style>
        <script>console.log("bad");</script>
      </head>
      <body>
        <h1>Main Title</h1>
        <p>This is a paragraph with <strong>bold</strong> and <em>italic</em> text.</p>
        <p>Check out <a href="https://example.com/docs">the docs</a> for more.</p>
        <ul>
          <li>First item</li>
          <li>Second item</li>
        </ul>
        <pre><code>function test() { return true; }</code></pre>
      </body>
    </html>
  `;

  const md = htmlToMarkdown(html);
  assert.match(md, /# Main Title/);
  assert.match(md, /\*\*bold\*\*/);
  assert.match(md, /\*italic\*/);
  assert.match(md, /\[the docs\]\(https:\/\/example\.com\/docs\)/);
  assert.match(md, /\* First item/);
  assert.match(md, /\* Second item/);
  assert.match(md, /```\s+function test\(\) \{ return true; \}\s+```/);
  assert.doesNotMatch(md, /console\.log/);
  assert.doesNotMatch(md, /body \{ color: red; \}/);
});

test("fetchDirect enforces its response byte limit", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("x".repeat(110_000), {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    })) as typeof fetch;

  try {
    const response = await fetchDirect("https://example.com/large", { raw: true });
    assert.equal(Buffer.byteLength(response.text, "utf8"), 100_000);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
