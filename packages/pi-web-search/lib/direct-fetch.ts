import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { setImmediate } from "node:timers/promises";
import type { FetchOptions, FetchResponse } from "./types.ts";

const DEFAULT_FETCH_TIMEOUT_MS = 30_000;
const MAX_DIRECT_FETCH_BYTES = 100_000; // 100KB
const MAX_PDF_FETCH_BYTES = 20 * 1024 * 1024; // 20MB
const PDF_SNIFF_BYTES = 1_024;
const DEFAULT_MAX_PDF_PAGES = 100;
/** Absolute ceiling for pages persisted to the on-disk copy. */
const MAX_PDF_FILE_PAGES = 10_000;
const MAX_PDF_TEXT_CHARS = 200_000;
const PDF_PREVIEW_CHARS = 4_000;
/** Real PDF header: `%PDF-` followed by a version digit, within 1KB of start. */
const PDF_MAGIC_RE = /%PDF-\d/;
const PDF_URL_RE = /\.pdf$/i;
const PDF_FETCH_DIR = path.join(os.homedir(), ".pi", "web-search", "fetches");

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

interface DirectBody {
  bytes: Buffer;
  /** True when the stream still had data at the read cap. */
  truncated: boolean;
}

/**
 * Read a response body with a two-phase cap: buffer PDF_SNIFF_BYTES first so
 * the content can be classified; bodies that sniff as PDF are then allowed to
 * grow to MAX_PDF_FETCH_BYTES while everything else stays at the small text
 * cap.
 */
async function readBody(response: Response): Promise<DirectBody> {
  const reader = response.body?.getReader();
  if (!reader) return { bytes: Buffer.alloc(0), truncated: false };

  const contentType = response.headers.get("content-type") || "";
  const chunks: Uint8Array[] = [];
  const head = Buffer.alloc(PDF_SNIFF_BYTES);
  let headBytes = 0;
  let total = 0;
  let sniffed = classifyBody(contentType, "") === "pdf";
  let cap = sniffed ? MAX_PDF_FETCH_BYTES : MAX_DIRECT_FETCH_BYTES;
  let streamDone = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        streamDone = true;
        break;
      }
      // Classify BEFORE clipping this chunk. A single read can exceed the
      // text cap, and the PDF header can straddle earlier, smaller chunks.
      if (!sniffed) {
        const prefix = value.subarray(0, PDF_SNIFF_BYTES - headBytes);
        head.set(prefix, headBytes);
        headBytes += prefix.byteLength;
        if (headBytes === PDF_SNIFF_BYTES) {
          sniffed = true;
          if (classifyBody(contentType, head.toString("utf8")) === "pdf") {
            cap = MAX_PDF_FETCH_BYTES;
          }
        }
      }
      const remaining = cap - total;
      const chunk = value.subarray(0, remaining);
      chunks.push(chunk);
      total += chunk.byteLength;
      if (value.byteLength > remaining) break;
      // PDFs need one more read at the cap to distinguish an exact-size
      // document from an oversized one. Text can stop immediately.
      if (total === cap && cap === MAX_DIRECT_FETCH_BYTES) break;
    }
  } finally {
    if (!streamDone) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }

  return {
    bytes: Buffer.concat(chunks, total),
    truncated: !streamDone,
  };
}

export function decodeHtmlEntities(html: string): string {
  return html
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, num) => String.fromCharCode(parseInt(num, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

export function extractHtmlTitle(html: string): string | undefined {
  const ogTitleMatch = /<meta\s+[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i.exec(
    html,
  );
  if (ogTitleMatch?.[1]) return decodeHtmlEntities(ogTitleMatch[1].trim());

  const titleMatch = /<title[^>]*>([^<]+)<\/title>/i.exec(html);
  if (titleMatch?.[1]) return decodeHtmlEntities(titleMatch[1].trim());

  const h1Match = /<h1[^>]*>([^<]+)<\/h1>/i.exec(html);
  if (h1Match?.[1]) return decodeHtmlEntities(h1Match[1].trim());

  return undefined;
}

export function htmlToMarkdown(html: string): string {
  let text = html;

  // Remove script, style, noscript, svg, nav, footer, header tags and their content
  text = text.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "");
  text = text.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "");
  text = text.replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, "");
  text = text.replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, "");

  // Preformatted blocks
  text = text.replace(
    /<pre\b[^>]*><code\b[^>]*>([\s\S]*?)<\/code><\/pre>/gi,
    (_, code) => `\n\`\`\`\n${decodeHtmlEntities(code)}\n\`\`\`\n`,
  );
  text = text.replace(
    /<pre\b[^>]*>([\s\S]*?)<\/pre>/gi,
    (_, code) => `\n\`\`\`\n${decodeHtmlEntities(code)}\n\`\`\`\n`,
  );
  text = text.replace(
    /<code\b[^>]*>([\s\S]*?)<\/code>/gi,
    (_, code) => `\`${decodeHtmlEntities(code)}\``,
  );

  // Headings
  text = text.replace(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi, (_, c) => `\n\n# ${c.trim()}\n\n`);
  text = text.replace(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi, (_, c) => `\n\n## ${c.trim()}\n\n`);
  text = text.replace(/<h3\b[^>]*>([\s\S]*?)<\/h3>/gi, (_, c) => `\n\n### ${c.trim()}\n\n`);
  text = text.replace(
    /<h[4-6]\b[^>]*>([\s\S]*?)<\/h[4-6]>/gi,
    (_, c) => `\n\n#### ${c.trim()}\n\n`,
  );

  // Links: <a href="url">text</a> -> [text](url)
  text = text.replace(
    /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_, href, content) => {
      const cleanContent = content.replace(/<[^>]+>/g, "").trim();
      if (!cleanContent || cleanContent === href) return href;
      if (href.startsWith("javascript:") || href.startsWith("#")) return cleanContent;
      return `[${cleanContent}](${href})`;
    },
  );

  // Paragraphs and breaks
  text = text.replace(/<p\b[^>]*>/gi, "\n\n");
  text = text.replace(/<\/p>/gi, "\n\n");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<hr\s*\/?>/gi, "\n---\n");

  // Lists
  text = text.replace(/<li\b[^>]*>/gi, "\n* ");
  text = text.replace(/<\/li>/gi, "");
  text = text.replace(/<\/(?:ul|ol)>/gi, "\n\n");

  // Bold and italic
  text = text.replace(/<(?:strong|b)\b[^>]*>([\s\S]*?)<\/(?:strong|b)>/gi, "**$1**");
  text = text.replace(/<(?:em|i)\b[^>]*>([\s\S]*?)<\/(?:em|i)>/gi, "*$1*");

  // Strip remaining HTML tags
  text = text.replace(/<[^>]+>/g, " ");

  // Decode HTML entities
  text = decodeHtmlEntities(text);

  // Normalize whitespace: collapse multiple horizontal spaces and excessive blank lines
  text = text
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return text;
}

/**
 * Minimum extracted length for Defuddle output to be trusted over the naive
 * regex converter. Shorter results mean Defuddle could not find main content
 * (SPAs, non-article pages) and we fall back to htmlToMarkdown.
 */
const MIN_DEFUDDLE_CONTENT_CHARS = 200;

export type DirectBodyKind = "html" | "text" | "pdf" | "binary";

/**
 * An HTML document *starts* with a doctype or <html tag. Source code that
 * merely contains "<html" somewhere (JSX templates, Python strings, Markdown
 * examples) must not be mistaken for a web page.
 */
const HTML_DOCUMENT_START_RE = /^\s*(?:<!doctype\s+html|<html[\s>])/i;

/**
 * Decide how to treat a response body: convert as HTML, return as text, or
 * reject as binary.
 *
 * The server's Content-Type is authoritative: raw.githubusercontent.com and
 * similar file hosts serve source files as text/plain, and running the HTML
 * converter on them would corrupt the code. Content sniffing is only a
 * last resort for unknown or generic types.
 */
export function classifyBody(contentType: string, body: string): DirectBodyKind {
  const ct = contentType.trim().toLowerCase();

  if (ct.includes("html")) return "html";
  if (ct.includes("pdf")) return "pdf";

  // Known textual content: text/* plus JSON/JS/TS/XML/YAML/TOML/CSV and
  // structured +json/+xml suffix types (also covers image/svg+xml).
  if (
    ct.startsWith("text/") ||
    ct.includes("json") ||
    ct.includes("javascript") ||
    ct.includes("typescript") ||
    ct.includes("xml") ||
    ct.includes("yaml") ||
    ct.includes("toml") ||
    ct.includes("csv") ||
    ct.includes("sql")
  ) {
    return "text";
  }

  // Known binary families that can never be useful as model-facing text.
  if (
    /^(?:image|audio|video|font)\//.test(ct) ||
    /(?:zip|tar|7z|rar|gzip|wasm|exe|dll|class|woff)/.test(ct)
  ) {
    return "binary";
  }

  // Unknown or generic type (missing, octet-stream, ...): sniff. The %PDF-
  // header (required within the first 1024 bytes) is checked before NULs,
  // which PDFs legitimately contain; NULs otherwise remain a strong binary
  // signal, and only a real HTML document *start* triggers conversion.
  const head = body.slice(0, 2000);
  if (PDF_MAGIC_RE.test(head.slice(0, 1024))) return "pdf";
  if (head.includes("\0")) return "binary";
  return HTML_DOCUMENT_START_RE.test(head) ? "html" : "text";
}

const BASE64_BODY_RE = /^[A-Za-z0-9+/=\r\n]+$/;

/**
 * android.googlesource.com (and friends) serve raw file content as base64
 * behind `?format=TEXT` — with Content-Type text/plain. Decode it back to
 * the real file body so the model sees source instead of gibberish.
 *
 * Strictly validated: only exact *.googlesource.com hosts with the TEXT
 * format parameter, body fully base64, length a multiple of 4, and the
 * decoded bytes free of NULs. Anything else returns the body unchanged.
 */
export function maybeDecodeBase64Body(url: string, body: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return body;
  }
  if (!/(^|\.)googlesource\.com$/.test(parsed.hostname)) return body;
  if (!/^TEXT$/i.test(parsed.searchParams.get("format") ?? "")) return body;

  const compact = body.replace(/[\r\n]+/g, "");
  if (compact.length === 0 || compact.length % 4 !== 0) return body;
  if (!BASE64_BODY_RE.test(compact)) return body;

  const decoded = Buffer.from(compact, "base64");
  if (decoded.includes(0)) return body;
  return decoded.toString("utf8");
}

interface PdfExtraction {
  /** Inline text: the first `maxPages` pages, `<!-- Page N -->`-delimited. */
  text: string;
  /** Pages beyond the inline limit, same format — set only when truncated. */
  remaining?: string;
  /** True when the document still had pages beyond the file cap. */
  fileTruncated?: boolean;
  title?: string;
  totalPages: number;
  extractedPages: number;
}

/**
 * Extract a PDF's embedded text layer with unpdf (serverless PDF.js), one
 * page at a time so `maxPages` bounds the inline work. Pages are delimited
 * with `<!-- Page N -->` markers. When the page limit cuts the document
 * short, the remaining pages are still extracted (into `remaining`) so the
 * caller can persist the complete document to disk — the inline text never
 * strands content the model cannot reach. Scanned documents have no text
 * layer and throw, letting the fallback chain reach an OCR-capable provider.
 */
async function extractPdfText(
  bytes: Buffer,
  maxPages: number | undefined,
  signal: AbortSignal,
): Promise<PdfExtraction> {
  signal.throwIfAborted();
  const { getDocumentProxy, getMeta } = await import("unpdf");
  signal.throwIfAborted();
  const limit = Math.min(Math.max(Math.floor(maxPages ?? DEFAULT_MAX_PDF_PAGES), 1), 10_000);

  let doc: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    // unpdf requires a real Uint8Array (not a Buffer subclass view).
    doc = await getDocumentProxy(new Uint8Array(bytes));
  } catch (err) {
    signal.throwIfAborted();
    throw new Error(
      `Failed to parse PDF: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300),
    );
  }

  // Destroy pending PDF.js work on abort as well as on normal/error exits.
  // Reuse the cleanup promise so the abort handler and finally cannot race.
  let cleanup: Promise<void> | undefined;
  const destroy = () => (cleanup ??= doc.loadingTask.destroy().catch(() => undefined));
  const onAbort = () => {
    void destroy();
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    signal.throwIfAborted();
    const totalPages = doc.numPages ?? 0;
    const extractedPages = Math.min(totalPages, limit);
    // The on-disk copy is allowed to run past maxPages (it is the "rest" the
    // inline answer points at) but remains bounded and cancellable.
    const filePages = Math.min(totalPages, MAX_PDF_FILE_PAGES);

    const extractPage = async (i: number): Promise<string> => {
      // PDF.js can resolve pages through microtasks only. Yield to the event
      // loop so user cancellation and timeout timers can run between pages.
      await setImmediate();
      signal.throwIfAborted();
      const page = await doc.getPage(i);
      signal.throwIfAborted();
      const content = await page.getTextContent();
      signal.throwIfAborted();
      let text = "";
      for (const item of content.items) {
        if (!("str" in item)) continue;
        text += item.str;
        if (item.hasEOL) text += "\n";
      }
      return `<!-- Page ${i} -->\n\n${text.trim()}`;
    };

    const pageTexts: string[] = [];
    for (let i = 1; i <= extractedPages; i++) {
      pageTexts.push(await extractPage(i));
    }

    let remaining: string | undefined;
    if (filePages > extractedPages) {
      const rest: string[] = [];
      for (let i = extractedPages + 1; i <= filePages; i++) {
        rest.push(await extractPage(i));
      }
      remaining = rest.join("\n\n");
    }

    let title: string | undefined;
    try {
      const meta = await getMeta(doc);
      const t = meta?.info?.Title;
      if (typeof t === "string" && t.trim()) title = t.trim();
    } catch {
      // Metadata is best-effort, but cancellation must not be swallowed.
    }
    signal.throwIfAborted();

    const joined = pageTexts.join("\n\n");
    const fullText = remaining === undefined ? joined : `${joined}\n\n${remaining}`;
    if (!fullText.replace(/<!-- Page \d+ -->/g, "").trim()) {
      throw new Error("PDF has no extractable text layer (likely a scanned document)");
    }

    return {
      text: joined,
      remaining,
      fileTruncated: filePages < totalPages,
      title,
      totalPages,
      extractedPages,
    };
  } catch (err) {
    // Destroying a document may reject pending PDF.js promises with its own
    // error. Preserve AbortError/TimeoutError for the provider fallback chain.
    signal.throwIfAborted();
    throw err;
  } finally {
    signal.removeEventListener("abort", onAbort);
    await destroy();
  }
}

/** Persist an oversized extraction under ~/.pi so the model can read it on
 * demand instead of holding the whole document in context. */
function spillPdfToFile(url: string, markdown: string): string {
  const base = path.basename(new URL(url).pathname).replace(/\.pdf$/i, "");
  const slug = base
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  const hash = crypto.createHash("sha1").update(url).digest("hex").slice(0, 8);
  const filePath = path.join(PDF_FETCH_DIR, `${slug || "document"}-${hash}.md`);
  fs.mkdirSync(PDF_FETCH_DIR, { recursive: true });
  fs.writeFileSync(filePath, markdown, "utf8");
  return filePath;
}

async function pdfFetchResponse(
  url: string,
  bytes: Buffer,
  contentType: string,
  options: FetchOptions,
  signal: AbortSignal,
): Promise<FetchResponse> {
  const pdf = await extractPdfText(bytes, options.maxPages, signal);
  signal.throwIfAborted();
  const truncatedByPages = pdf.extractedPages < pdf.totalPages;
  const overChars = pdf.text.length > MAX_PDF_TEXT_CHARS;

  if (truncatedByPages || overChars) {
    // Persist the complete extraction (pages past maxPages included) so the
    // inline answer can point at the rest instead of dropping it.
    let fileContent = pdf.remaining === undefined ? pdf.text : `${pdf.text}\n\n${pdf.remaining}`;
    if (pdf.fileTruncated) {
      fileContent += `\n\n*[File truncated at ${MAX_PDF_FILE_PAGES} of ${pdf.totalPages} pages]*`;
    }
    const filePath = spillPdfToFile(url, fileContent);

    if (overChars) {
      return {
        url,
        title: pdf.title,
        text: [
          `PDF extracted and saved to: ${filePath}`,
          `Pages: ${pdf.fileTruncated ? `${MAX_PDF_FILE_PAGES} of ${pdf.totalPages}` : pdf.totalPages}`,
          `Characters: ${fileContent.length}`,
          "",
          "--- Preview ---",
          fileContent.slice(0, PDF_PREVIEW_CHARS),
        ].join("\n"),
        provider: "direct",
        contentType: contentType || "application/pdf",
        pages: pdf.totalPages,
        savedTo: filePath,
      };
    }

    return {
      url,
      title: pdf.title,
      text:
        pdf.text +
        `\n\n*[Truncated: showing the first ${pdf.extractedPages} of ${pdf.totalPages} pages. ` +
        `The complete document was extracted to: ${filePath} — read or grep that file for the rest, ` +
        `or raise maxPages.]*`,
      provider: "direct",
      contentType: contentType || "application/pdf",
      pages: pdf.totalPages,
      savedTo: filePath,
    };
  }

  return {
    url,
    title: pdf.title,
    text: pdf.text,
    provider: "direct",
    contentType: contentType || "application/pdf",
    pages: pdf.totalPages,
  };
}

export async function fetchDirect(url: string, options: FetchOptions = {}): Promise<FetchResponse> {
  const parsedUrl = new URL(url);
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error(`Direct fetch only supports http and https URLs: ${url}`);
  }

  const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS);
  const combinedSignal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;

  const res = await fetch(url, {
    method: "GET",
    headers: {
      "User-Agent": DEFAULT_USER_AGENT,
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf;q=0.9,text/plain;q=0.8,*/*;q=0.5",
      "Accept-Language": "en-US,en;q=0.9",
    },
    signal: combinedSignal,
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch ${url} (${res.status} ${res.statusText})`);
  }

  const contentType = res.headers.get("content-type") || "";
  const pdfHint = contentType.toLowerCase().includes("pdf") || PDF_URL_RE.test(parsedUrl.pathname);

  // Fail fast on oversized PDFs before downloading the body.
  const declaredLength = Number(res.headers.get("content-length") ?? "");
  if (pdfHint && Number.isFinite(declaredLength) && declaredLength > MAX_PDF_FETCH_BYTES) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error(
      `PDF is ${(declaredLength / 1024 / 1024).toFixed(1)}MB — exceeds the 20MB direct-fetch limit: ${url}`,
    );
  }

  const { bytes, truncated } = await readBody(res);
  const head = bytes.subarray(0, 2048).toString("utf8");

  const kind = classifyBody(contentType, head);
  if (kind === "binary") {
    throw new Error(
      `Direct fetch does not support binary content (${contentType || "unknown type"}): ${url}`,
    );
  }
  if (kind === "pdf") {
    if (truncated) {
      throw new Error(`PDF exceeds the 20MB direct-fetch limit: ${url}`);
    }
    return pdfFetchResponse(url, bytes, contentType, options, combinedSignal);
  }

  // Bound bytes before decoding, dropping any partial trailing UTF-8 code
  // point. Invalid input can expand into replacement characters; cap that
  // output in one more linear pass rather than trimming one character at a time.
  let rawBody = new StringDecoder("utf8").write(bytes.subarray(0, MAX_DIRECT_FETCH_BYTES));
  const encodedBody = Buffer.from(rawBody, "utf8");
  if (encodedBody.byteLength > MAX_DIRECT_FETCH_BYTES) {
    rawBody = new StringDecoder("utf8").write(encodedBody.subarray(0, MAX_DIRECT_FETCH_BYTES));
  }

  const isHtml = kind === "html";
  let title = isHtml ? extractHtmlTitle(rawBody) : undefined;
  let text = options.raw || !isHtml ? rawBody : htmlToMarkdown(rawBody);
  if (!isHtml) text = maybeDecodeBase64Body(url, text);

  // Prefer real main-content extraction for HTML pages: Defuddle removes nav,
  // sidebars, cookie banners, etc. and returns clean Markdown. Fall back to
  // the naive converter when it finds nothing usable (SPAs, tiny fragments).
  if (isHtml && !options.raw) {
    try {
      const [{ parseHTML }, { Defuddle }] = await Promise.all([
        import("linkedom"),
        import("defuddle/node"),
      ]);
      const { document } = parseHTML(rawBody);
      const result = await Defuddle(document, url, { markdown: true });
      const content = typeof result?.content === "string" ? result.content.trim() : "";
      if (content.length >= MIN_DEFUDDLE_CONTENT_CHARS) {
        text = content;
        if (result.title) title = result.title;
      }
    } catch {
      // Keep the naive-conversion text.
    }
  }

  return {
    url,
    title,
    text,
    provider: "direct",
    contentType: contentType || (isHtml ? "text/html" : "text/plain"),
  };
}
