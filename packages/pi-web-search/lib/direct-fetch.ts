import type { FetchOptions, FetchResponse } from "./types.ts";

const DEFAULT_FETCH_TIMEOUT_MS = 30_000;
const MAX_DIRECT_FETCH_BYTES = 100_000; // 100KB

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

async function readLimitedText(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maxBytes - total;
      const chunk = value.subarray(0, remaining);
      chunks.push(chunk);
      total += chunk.byteLength;
      if (value.byteLength > remaining) break;
    }
  } finally {
    if (total >= maxBytes) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }

  let text = Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    total,
  ).toString("utf8");
  while (Buffer.byteLength(text, "utf8") > maxBytes) text = text.slice(0, -1);
  return text;
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

export type DirectBodyKind = "html" | "text" | "binary";

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
    /(?:pdf|zip|tar|7z|rar|gzip|wasm|exe|dll|class|woff)/.test(ct)
  ) {
    return "binary";
  }

  // Unknown or generic type (missing, octet-stream, ...): sniff. NUL bytes
  // are a strong binary signal; otherwise only a real HTML document *start*
  // triggers conversion.
  const head = body.slice(0, 2000);
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
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
      "Accept-Language": "en-US,en;q=0.9",
    },
    signal: combinedSignal,
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch ${url} (${res.status} ${res.statusText})`);
  }

  const contentType = res.headers.get("content-type") || "";
  const rawBody = await readLimitedText(res, MAX_DIRECT_FETCH_BYTES);

  const kind = classifyBody(contentType, rawBody);
  if (kind === "binary") {
    throw new Error(
      `Direct fetch does not support binary content (${contentType || "unknown type"}): ${url}`,
    );
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
