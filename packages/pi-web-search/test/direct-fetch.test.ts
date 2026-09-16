import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  classifyBody,
  decodeHtmlEntities,
  extractHtmlTitle,
  fetchDirect,
  htmlToMarkdown,
  maybeDecodeBase64Body,
} from "../lib/direct-fetch.ts";

const PDF_FIXTURE = new Uint8Array(
  fs.readFileSync(new URL("./fixtures/hello.pdf", import.meta.url)),
);

/** Build a minimal valid multi-page PDF in memory (uncompressed streams). */
function buildPdf(pageTexts: string[]): Uint8Array {
  // Object numbering: 1 = catalog, 2 = pages, page i uses objects
  // (3 + 2i) for the page and (4 + 2i) for its content stream; the font
  // object comes last.
  const fontRef = 3 + pageTexts.length * 2;
  const objs: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageTexts.map((_, i) => `${3 + i * 2} 0 R`).join(" ")}] /Count ${pageTexts.length} >>`,
  ];
  pageTexts.forEach((text, i) => {
    // pdf.js clips glyphs outside the MediaBox: keep lines short enough for
    // the page width and few enough for the page height (~72 lines at 8pt).
    const lines = text.match(/.{1,80}/g) ?? [""];
    const ops = lines
      .map((line, j) => `${j === 0 ? "36 760" : "0 -10"} Td (${line}) Tj`)
      .join("\n");
    const stream = `BT /F1 8 Tf ${ops} ET`;
    objs.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontRef} 0 R >> >> /Contents ${4 + i * 2} 0 R >>`,
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    );
  });
  objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");

  let out = "%PDF-1.4\n";
  const offsets = [0];
  objs.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefStart = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objs.length; i++) {
    out += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, "latin1"));
}

function mockPdfResponse(body: Uint8Array, headers: Record<string, string> = {}): void {
  globalThis.fetch = (async () =>
    new Response(Buffer.from(body), {
      status: 200,
      headers: { "Content-Type": "application/pdf", ...headers },
    })) as typeof fetch;
}

/** Observe real PDF.js lifecycle methods without replacing the parser. */
async function pdfPrototypes() {
  const { getDocumentProxy } = await import("unpdf");
  const doc = await getDocumentProxy(new Uint8Array(PDF_FIXTURE));
  const document = Object.getPrototypeOf(doc) as typeof doc;
  const loadingTask = Object.getPrototypeOf(doc.loadingTask) as typeof doc.loadingTask;
  await doc.loadingTask.destroy();
  return { document, loadingTask };
}

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
  assert.equal(classifyBody("application/zip", "PK\u0003\u0004"), "binary");
  // NUL bytes under a generic octet-stream type are a strong binary signal.
  assert.equal(classifyBody("application/octet-stream", "ab\u0000cd"), "binary");
});

test("classifyBody detects PDFs by Content-Type and %PDF- magic", () => {
  assert.equal(classifyBody("application/pdf", "%PDF-1.7"), "pdf");
  assert.equal(classifyBody("application/x-pdf", "%PDF-1.4"), "pdf");
  // octet-stream with a real PDF header: magic wins over the NUL bytes that
  // follow it in any real PDF body.
  assert.equal(classifyBody("application/octet-stream", "%PDF-1.7\n%\u0000\u0000\u0000"), "pdf");
  assert.equal(classifyBody("", "%PDF-1.6\nrest"), "pdf");
  // Text that merely mentions "%PDF-" beyond the 1KB header window falls
  // through to the NUL/text sniff like any other unknown payload.
  assert.equal(
    classifyBody("application/octet-stream", `notes\n${"x".repeat(1500)}%PDF-1.7`),
    "text",
  );
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

for (const contentType of ["text/plain", "text/html"]) {
  test(`fetchDirect keeps the text cap for .pdf URLs returning ${contentType}`, async (t) => {
    let chunksRead = 0;
    let cancelled = false;
    const response = new Response(
      new ReadableStream(
        {
          pull(controller) {
            chunksRead++;
            assert.ok(chunksRead <= 2, "do not read past the text cap");
            controller.enqueue(Buffer.alloc(50_000, "x"));
          },
          cancel() {
            cancelled = true;
          },
        },
        { highWaterMark: 0 },
      ),
      { headers: { "Content-Type": contentType } },
    );
    t.mock.method(globalThis, "fetch", async () => response);

    const result = await fetchDirect("https://example.com/error.pdf", { raw: true });
    assert.equal(result.text, "x".repeat(100_000));
    assert.equal(chunksRead, 2, "do not download up to 20MB based on the URL alone");
    assert.equal(cancelled, true);
  });
}

test("fetchDirect bounds UTF-8 output without repeatedly measuring large strings", async (t) => {
  const byteLength = Buffer.byteLength;
  let oversizedMeasurements = 0;
  t.mock.method(Buffer, "byteLength", (...args: Parameters<typeof Buffer.byteLength>) => {
    const length = byteLength(...args);
    if (typeof args[0] === "string" && length > 100_000) {
      // Fail the old quadratic loop promptly without a wall-clock assertion.
      assert.ok(++oversizedMeasurements < 10, "repeatedly rescanning an oversized string");
    }
    return length;
  });
  const bodies = [
    { bytes: Buffer.from(`a${"😀".repeat(50_000)}`), expected: `a${"😀".repeat(24_999)}` },
    { bytes: Buffer.alloc(110_000, 0xff), expected: "\ufffd".repeat(33_333) },
  ];
  for (const { bytes, expected } of bodies) {
    t.mock.method(
      globalThis,
      "fetch",
      async () =>
        new Response(bytes, {
          headers: { "Content-Type": "text/plain" },
        }),
    );
    const result = await fetchDirect("https://example.com/error.pdf", { raw: true });
    assert.equal(result.text, expected);
    assert.ok(byteLength(result.text, "utf8") <= 100_000);
  }
});

test("fetchDirect extracts text from PDF responses and releases the document", async (t) => {
  const { loadingTask } = await pdfPrototypes();
  const destroy = t.mock.method(loadingTask, "destroy");
  const originalFetch = globalThis.fetch;
  mockPdfResponse(PDF_FIXTURE);
  try {
    const response = await fetchDirect("https://example.com/report.pdf");
    assert.equal(response.provider, "direct");
    assert.equal(response.pages, 2);
    assert.equal(response.title, "Fixture Title");
    assert.match(response.text, /<!-- Page 1 -->\n\nHello PDF world from the extraction fixture/);
    assert.match(response.text, /<!-- Page 2 -->\n\nSecond page carries different marker text/);
    assert.equal(destroy.mock.callCount(), 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchDirect detects PDFs served as application/octet-stream", async () => {
  const originalFetch = globalThis.fetch;
  mockPdfResponse(PDF_FIXTURE, { "Content-Type": "application/octet-stream" });
  try {
    // No .pdf suffix and no pdf content-type — the %PDF- magic must carry it.
    const response = await fetchDirect("https://example.com/download?id=42");
    assert.match(response.text, /Hello PDF world/);
    assert.equal(response.pages, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

for (const firstChunkBytes of [0, 3, 65_536]) {
  test(`fetchDirect sniffs a PDF before clipping a large chunk (prefix ${firstChunkBytes})`, async (t) => {
    const body = Buffer.concat([PDF_FIXTURE, Buffer.alloc(200_000, " ")]);
    let offset = 0;
    t.mock.method(
      globalThis,
      "fetch",
      async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              if (offset === body.length) {
                controller.close();
                return;
              }
              const end = offset === 0 && firstChunkBytes > 0 ? firstChunkBytes : body.length;
              controller.enqueue(body.subarray(offset, end));
              offset = end;
            },
          }),
          { headers: { "Content-Type": "application/octet-stream" } },
        ),
    );

    const response = await fetchDirect("https://example.com/download?id=42");
    assert.equal(response.pages, 2);
    assert.match(response.text, /Second page carries different marker text/);
  });
}

for (const extraBytes of [0, 1]) {
  test(`fetchDirect accepts the exact PDF byte cap, rejects cap + 1 (${extraBytes})`, async (t) => {
    const body = Buffer.concat([
      PDF_FIXTURE,
      Buffer.alloc(20 * 1024 * 1024 - PDF_FIXTURE.length + extraBytes, " "),
    ]);
    let cancelled = false;
    let sent = false;
    t.mock.method(
      globalThis,
      "fetch",
      async () =>
        new Response(
          new ReadableStream(
            {
              pull(controller) {
                if (sent) {
                  controller.close();
                  return;
                }
                sent = true;
                controller.enqueue(body);
              },
              cancel() {
                cancelled = true;
              },
            },
            { highWaterMark: 0 },
          ),
          { headers: { "Content-Type": "application/octet-stream" } },
        ),
    );

    const result = fetchDirect("https://example.com/download");
    if (extraBytes === 0) {
      assert.equal((await result).pages, 2);
      assert.equal(cancelled, false);
    } else {
      await assert.rejects(result, /exceeds the 20MB/);
      assert.equal(cancelled, true);
    }
  });
}

for (const mode of ["inline", "remaining", "between-pages", "timeout"] as const) {
  test(`fetchDirect cancels PDF extraction and releases resources (${mode})`, async (t) => {
    const { document, loadingTask } = await pdfPrototypes();
    const destroy = t.mock.method(loadingTask, "destroy");
    const write = t.mock.method(fs, "writeFileSync", () => {});
    const controller = new AbortController();
    const reason = new DOMException(
      "PDF extraction stopped",
      mode === "timeout" ? "TimeoutError" : "AbortError",
    );
    if (mode === "timeout") t.mock.method(AbortSignal, "timeout", () => controller.signal);
    const abortPage = mode === "remaining" ? 2 : 1;
    const originalGetPage = document.getPage;
    const getPage = t.mock.method(
      document,
      "getPage",
      async function (this: typeof document, n: number) {
        const page = await originalGetPage.call(this, n);
        if (n === abortPage) {
          const getText = page.getTextContent.bind(page);
          t.mock.method(page, "getTextContent", async () => {
            const content = await getText();
            if (mode === "between-pages") {
              const handle = setImmediate(() => controller.abort(reason));
              t.after(() => clearImmediate(handle));
            } else {
              controller.abort(reason);
            }
            return content;
          });
        }
        return page;
      },
    );
    t.mock.method(
      globalThis,
      "fetch",
      async () =>
        new Response(Buffer.from(buildPdf(["first", "second", "third"])), {
          headers: { "Content-Type": "application/pdf" },
        }),
    );

    await assert.rejects(
      fetchDirect("https://example.com/cancel.pdf", {
        maxPages: 1,
        signal: mode === "timeout" ? new AbortController().signal : controller.signal,
      }),
      (error) => error === reason,
    );
    assert.equal(getPage.mock.callCount(), abortPage, "do not start another page after abort");
    assert.equal(destroy.mock.callCount(), 1);
    assert.equal(write.mock.callCount(), 0, "do not persist cancelled extractions");
  });
}

test("fetchDirect honors maxPages and saves the rest to a file", async () => {
  const originalFetch = globalThis.fetch;
  mockPdfResponse(PDF_FIXTURE);
  try {
    const response = await fetchDirect("https://example.com/report.pdf", { maxPages: 1 });
    assert.match(response.text, /Hello PDF world/);
    assert.doesNotMatch(response.text, /Second page/);
    // The truncation note must tell the model where the rest of the
    // document lives — the inline text alone is not the whole PDF.
    assert.match(response.text, /Truncated: showing the first 1 of 2 pages/);
    assert.match(response.text, /complete document was extracted to: .+/);
    assert.equal(response.pages, 2);
    assert.ok(response.savedTo);
    const written = fs.readFileSync(response.savedTo!, "utf8");
    assert.match(written, /<!-- Page 2 -->\n\nSecond page carries different marker text/);
    fs.rmSync(response.savedTo!);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchDirect rejects corrupt PDFs with a parse error", async () => {
  const originalFetch = globalThis.fetch;
  mockPdfResponse(Buffer.from("%PDF-1.7\nnot a real document", "latin1"));
  try {
    await assert.rejects(fetchDirect("https://example.com/broken.pdf"), /Failed to parse PDF/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchDirect rejects scanned PDFs and releases the document", async (t) => {
  const { loadingTask } = await pdfPrototypes();
  const destroy = t.mock.method(loadingTask, "destroy");
  const originalFetch = globalThis.fetch;
  mockPdfResponse(buildPdf(["", ""]));
  try {
    await assert.rejects(
      fetchDirect("https://example.com/scanned.pdf"),
      /no extractable text layer/,
    );
    assert.equal(destroy.mock.callCount(), 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchDirect refuses oversized PDFs from content-length alone", async () => {
  const originalFetch = globalThis.fetch;
  mockPdfResponse(PDF_FIXTURE, {
    "Content-Length": String(21 * 1024 * 1024),
  });
  try {
    await assert.rejects(fetchDirect("https://example.com/huge.pdf"), /exceeds the 20MB/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchDirect spills oversized extractions to a file under ~/.pi", async () => {
  const originalFetch = globalThis.fetch;
  // ~210K chars of extracted text, over the 200K inline limit.
  const big = buildPdf(Array.from({ length: 60 }, () => "x".repeat(3600)));
  mockPdfResponse(big);
  try {
    const response = await fetchDirect("https://example.com/big-report.pdf");
    assert.ok(response.savedTo);
    assert.equal(
      path.dirname(response.savedTo),
      path.join(os.homedir(), ".pi", "web-search", "fetches"),
    );
    assert.match(path.basename(response.savedTo), /^big-report-[0-9a-f]{8}\.md$/);
    assert.match(response.text, /saved to: .+/);
    assert.match(response.text, /Characters: 2\d{5}/);
    assert.match(response.text, /--- Preview ---/);
    // The file holds the full extraction with page markers.
    const written = fs.readFileSync(response.savedTo!, "utf8");
    assert.match(written, /<!-- Page 60 -->/);
    fs.rmSync(response.savedTo!);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
