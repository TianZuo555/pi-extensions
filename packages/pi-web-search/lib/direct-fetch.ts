import type { FetchOptions, FetchResponse } from "./types.ts";

const DEFAULT_FETCH_TIMEOUT_MS = 30_000;
const MAX_DIRECT_FETCH_BYTES = 100_000; // 100KB

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

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
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16)),
    );
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
  text = text.replace(/<pre\b[^>]*><code\b[^>]*>([\s\S]*?)<\/code><\/pre>/gi, (_, code) => `\n\`\`\`\n${decodeHtmlEntities(code)}\n\`\`\`\n`);
  text = text.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, code) => `\n\`\`\`\n${decodeHtmlEntities(code)}\n\`\`\`\n`);
  text = text.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_, code) => `\`${decodeHtmlEntities(code)}\``);

  // Headings
  text = text.replace(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi, (_, c) => `\n\n# ${c.trim()}\n\n`);
  text = text.replace(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi, (_, c) => `\n\n## ${c.trim()}\n\n`);
  text = text.replace(/<h3\b[^>]*>([\s\S]*?)<\/h3>/gi, (_, c) => `\n\n### ${c.trim()}\n\n`);
  text = text.replace(/<h[4-6]\b[^>]*>([\s\S]*?)<\/h[4-6]>/gi, (_, c) => `\n\n#### ${c.trim()}\n\n`);

  // Links: <a href="url">text</a> -> [text](url)
  text = text.replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, content) => {
    const cleanContent = content.replace(/<[^>]+>/g, "").trim();
    if (!cleanContent || cleanContent === href) return href;
    if (href.startsWith("javascript:") || href.startsWith("#")) return cleanContent;
    return `[${cleanContent}](${href})`;
  });

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

export async function fetchDirect(
  url: string,
  options: FetchOptions = {},
): Promise<FetchResponse> {
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
  const rawBody = await res.text();

  if (rawBody.length > MAX_DIRECT_FETCH_BYTES) {
    // Truncate to size limit
  }

  const isHtml = contentType.includes("html") || /<html/i.test(rawBody.slice(0, 1000));
  const title = isHtml ? extractHtmlTitle(rawBody) : undefined;
  const text = options.raw || !isHtml ? rawBody : htmlToMarkdown(rawBody);

  return {
    url,
    title,
    text,
    provider: "direct",
    contentType: contentType || (isHtml ? "text/html" : "text/plain"),
  };
}
