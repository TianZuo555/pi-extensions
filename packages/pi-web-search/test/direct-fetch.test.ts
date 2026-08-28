import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyBody,
  decodeHtmlEntities,
  extractHtmlTitle,
  fetchDirect,
  htmlToMarkdown,
  maybeDecodeBase64Body,
} from "../lib/direct-fetch.ts";

test("classifyBody trusts Content-Type for text files", () => {
  // raw.githubusercontent.com serves every file as text/plain.
  assert.equal(classifyBody("text/plain; charset=utf-8", "any content"), "text");
  assert.equal(classifyBody("text/markdown", "# hi"), "text");
  assert.equal(classifyBody("application/json", "{}"), "text");
  assert.equal(classifyBody("application/typescript", "const x = 1;"), "text");
});

test("classifyBody never converts source code that mentions <html>", () => {
  // Regression: JSX templates, Python strings, and Markdown examples used to
  // be misdetected as HTML because "<html" appeared in the first 1000 chars.
  const jsx = "const tpl = `<html>\n  <body>hi</body>\n</html>`;\nexport default tpl;\n";
  const py = 'print("<html>demo</html>")\n';
  const md = "# Guide\n\n```html\n<html><body>hi</body></html>\n```\n";
  for (const body of [jsx, py, md]) {
    assert.equal(classifyBody("text/plain; charset=utf-8", body), "text");
  }
});

test("classifyBody detects HTML by Content-Type or document start", () => {
  assert.equal(classifyBody("text/html", "<p>fragment</p>"), "html");
  assert.equal(classifyBody("application/xhtml+xml", "<p>x</p>"), "html");
  // Missing Content-Type: sniff, but only a real document *start* counts.
  assert.equal(classifyBody("", '<!DOCTYPE html>\n<html lang="en">'), "html");
  assert.equal(classifyBody("", '<html lang="en"><body></body></html>'), "html");
  assert.equal(classifyBody("", "<div>loose fragment</div>"), "text");
  assert.equal(classifyBody("", "const tpl = `<html>`; // html mid-body, not a document"), "text");
});

test("classifyBody rejects binary content", () => {
  assert.equal(classifyBody("image/png", "\u0089PNG"), "binary");
  assert.equal(classifyBody("application/pdf", "%PDF-1.7"), "binary");
  assert.equal(classifyBody("application/zip", "PK\u0003\u0004"), "binary");
  // NUL bytes under a generic octet-stream type are a strong binary signal.
  assert.equal(classifyBody("application/octet-stream", "ab\u0000cd"), "binary");
});

test("fetchDirect returns text/plain source files unconverted", async () => {
  const originalFetch = globalThis.fetch;
  const jsx = "const tpl = `<html>\n  <body>hi</body>\n</html>`;\nexport default tpl;\n";
  globalThis.fetch = (async () =>
    new Response(jsx, {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    })) as typeof fetch;

  try {
    const response = await fetchDirect(
      "https://raw.githubusercontent.com/octocat/Repo/main/component.tsx",
    );
    assert.equal(response.text, jsx);
    assert.equal(response.title, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchDirect rejects binary responses instead of returning mojibake", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("\u0089PNG\u0000\u0000\u0000", {
      status: 200,
      headers: { "Content-Type": "image/png" },
    })) as typeof fetch;

  try {
    await assert.rejects(
      fetchDirect("https://example.com/logo.png"),
      /binary content \(image\/png\)/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("decodeHtmlEntities converts entities correctly", () => {
  assert.equal(
    decodeHtmlEntities("Hello &amp; welcome &lt;world&gt; &quot;quote&#39; &nbsp; &#65;"),
    "Hello & welcome <world> \"quote'   A",
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
  assert.equal(extractHtmlTitle("<html><body><h1>Main Heading</h1></body></html>"), "Main Heading");
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

test("maybeDecodeBase64Body decodes googlesource ?format=TEXT bodies", () => {
  const b64 = Buffer.from("// Copyright (C) 2016\nandroid_app {\n}\n", "utf8").toString("base64");
  // googlesource wraps base64 at 76 columns.
  const wrapped = b64.replace(/(.{20})/g, "$1\n");
  assert.equal(
    maybeDecodeBase64Body(
      "https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/Android.bp?format=TEXT",
      wrapped,
    ),
    "// Copyright (C) 2016\nandroid_app {\n}\n",
  );
});

test("maybeDecodeBase64Body leaves non-googlesource or invalid bodies untouched", () => {
  const b64 = Buffer.from("just plain ascii text\n").toString("base64");
  // Not a googlesource host: unchanged even if the body is valid base64.
  assert.equal(maybeDecodeBase64Body("https://raw.githubusercontent.com/a/b/c/d.txt", b64), b64);
  // googlesource without format=TEXT: unchanged.
  assert.equal(maybeDecodeBase64Body("https://android.googlesource.com/x/+/main/f", b64), b64);
  // googlesource but body is normal text: unchanged.
  assert.equal(
    maybeDecodeBase64Body(
      "https://android.googlesource.com/x/+/main/f?format=TEXT",
      "# plain markdown\n",
    ),
    "# plain markdown\n",
  );
  // googlesource but body is not valid base64 (length % 4 != 0): unchanged.
  assert.equal(
    maybeDecodeBase64Body("https://android.googlesource.com/x/+/main/f?format=TEXT", "abc"),
    "abc",
  );
});

test("fetchDirect prefers Defuddle main-content extraction for HTML", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      `<html><head><title>Docs</title></head><body>
        <nav>Home Products Pricing Blog Contact</nav>
        <article>
          <h1>Real Article Title</h1>
          <p>${"Real article content. ".repeat(30)}</p>
        </article>
        <footer>Copyright 2026 ExampleCorp</footer>
      </body></html>`,
      { status: 200, headers: { "Content-Type": "text/html" } },
    )) as typeof fetch;

  try {
    const response = await fetchDirect("https://example.com/article");
    assert.match(response.text, /Real Article Title/);
    assert.doesNotMatch(response.text, /Home Products Pricing/);
    assert.doesNotMatch(response.text, /Copyright 2026/);
  } finally {
    globalThis.fetch = originalFetch;
  }
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
