/** Strip tracking params and hashes from search URLs. YouTube query strings stay. */
export function normalizeSearchUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    const host = parsed.hostname.toLowerCase();
    const isYouTube = host === "youtu.be" || host === "youtube.com" || host.endsWith(".youtube.com");
    if (!isYouTube) {
      for (const name of ["ref", "referral_type", "openLinerExtension", "_clear", "lang", "api-mode"]) {
        parsed.searchParams.delete(name);
      }
      for (const name of [...parsed.searchParams.keys()]) {
        if (name.toLowerCase().startsWith("utm_")) parsed.searchParams.delete(name);
      }
    }
    const query = parsed.searchParams.toString();
    parsed.search = query ? `?${query}` : "";
    return parsed.toString();
  } catch {
    return url.replace(/[?&]utm_source=openai$/, "");
  }
}

const JUNK_SUFFIXES = [
  ".gz",
  ".zip",
  ".tgz",
  ".tar",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".webm",
  ".mp4",
  ".mp3",
  ".wav",
  ".eps",
  ".sql",
  ".csv",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
];

export function isLikelyJunkSearchUrl(url: string | undefined): boolean {
  if (!url) return true;
  try {
    const parsed = new URL(url);
    const decodedPath = decodeURIComponent(parsed.pathname).toLowerCase();
    if (JUNK_SUFFIXES.some((suffix) => decodedPath.endsWith(suffix))) return true;
    return decodedPath === "/%" || decodedPath.endsWith("/%");
  } catch {
    return false;
  }
}

export function titleFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const lastSegment = parsed.pathname.split("/").filter(Boolean).pop();
    return lastSegment || parsed.hostname || url;
  } catch {
    return url;
  }
}

export interface UrlCitation {
  endIndex?: number;
  title: string;
  url: string;
}

/** Insert `[n]` markers at citation end indexes; `n` is 1-based in `urls` order. */
export function applyIndexCitations(text: string, citations: UrlCitation[], urls: string[]): string {
  const indexByUrl = new Map<string, number>();
  urls.forEach((url, index) => {
    if (!indexByUrl.has(url)) indexByUrl.set(url, index);
  });

  const insertions = citations
    .filter((citation) => citation.url && citation.endIndex !== undefined)
    .map((citation) => {
      const index = indexByUrl.get(citation.url);
      return {
        index: Math.max(0, Math.min(citation.endIndex ?? 0, text.length)),
        marker: index === undefined ? "" : `[${index + 1}]`,
      };
    })
    .filter((insertion) => insertion.marker.length > 0)
    .sort((a, b) => b.index - a.index);

  let result = text;
  const seen = new Set<string>();
  for (const insertion of insertions) {
    const key = `${insertion.index}:${insertion.marker}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result = result.slice(0, insertion.index) + insertion.marker + result.slice(insertion.index);
  }
  return result;
}
