/**
 * ripgrep `--json` stream decoding.
 *
 * rg emits one JSON object per line: begin/match/context/end/summary. Match and
 * context events already carry the surrounding lines, so unlike a naive grep
 * implementation we never re-read the file to build a context block — rg did
 * the work and re-reading would both cost I/O and risk showing a version of the
 * file that changed since the search.
 *
 * Text may arrive as `{ text }` or, for invalid UTF-8, as `{ bytes }` (base64).
 */

export interface RgSubmatch {
  readonly start: number;
  readonly end: number;
}

export interface RgLine {
  readonly kind: "match" | "context";
  readonly path: string;
  readonly lineNumber: number;
  readonly text: string;
  readonly submatches: readonly RgSubmatch[];
}

interface RgData {
  readonly text?: string;
  readonly bytes?: string;
}

function decodeText(value: RgData | string | undefined): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value.text === "string") return value.text;
  if (typeof value.bytes === "string") {
    try {
      return Buffer.from(value.bytes, "base64").toString("utf8");
    } catch {
      return "";
    }
  }
  return "";
}

/**
 * Decode one line of rg's JSON stream. Returns undefined for events we do not
 * render (begin/end/summary) and for unparseable lines, so a single malformed
 * record cannot abort an otherwise good search.
 */
export function decodeRgEvent(line: string): RgLine | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0) return undefined;

  let event: {
    type?: string;
    data?: {
      path?: RgData;
      lines?: RgData;
      line_number?: number;
      submatches?: Array<{ start?: number; end?: number }>;
    };
  };
  try {
    event = JSON.parse(trimmed);
  } catch {
    return undefined;
  }

  if (event.type !== "match" && event.type !== "context") return undefined;
  const data = event.data;
  if (!data || typeof data.line_number !== "number") return undefined;

  const path = decodeText(data.path);
  if (path.length === 0) return undefined;

  // rg keeps the trailing newline on `lines`; strip it and any CR so callers
  // can treat the value as one display line.
  const text = decodeText(data.lines).replace(/\r?\n$/, "").replace(/\r/g, "");

  const submatches = (data.submatches ?? [])
    .filter(
      (s): s is { start: number; end: number } =>
        typeof s.start === "number" && typeof s.end === "number",
    )
    .map((s) => ({ start: s.start, end: s.end }));

  return {
    kind: event.type,
    path,
    lineNumber: data.line_number,
    text,
    submatches,
  };
}
