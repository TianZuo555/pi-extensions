/**
 * ripgrep `--json` stream decoding.
 *
 * rg emits one JSON object per line. Decode matches and surrounding context;
 * begin/end/summary and malformed records are ignored.
 *
 * Text may arrive as `{ text }` or, for invalid UTF-8, as `{ bytes }` (base64).
 */

export interface RgLine {
  readonly path: string;
  readonly lineNumber: number;
  readonly text: string;
  readonly isContext: boolean;
  /** UTF-16 offsets in text, converted from ripgrep's UTF-8 byte offsets. */
  readonly matchStart?: number;
  readonly matchEnd?: number;
}

interface RgData {
  readonly text?: string;
  readonly bytes?: string;
}

function decodeText(value: RgData | string | undefined): string {
  if (value == null) return "";
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
      submatches?: Array<{ start: number; end: number }>;
    };
  };
  try {
    event = JSON.parse(trimmed);
  } catch {
    return undefined;
  }

  if (event == null || (event.type !== "match" && event.type !== "context")) return undefined;
  const data = event.data;
  if (!data || typeof data.line_number !== "number") return undefined;

  const path = decodeText(data.path);
  if (path.length === 0) return undefined;

  // rg keeps the trailing newline on `lines`; strip it and any CR so callers
  // can treat the value as one display line.
  const text = decodeText(data.lines)
    .replace(/\r?\n$/, "")
    .replace(/\r/g, "");

  const first = data.submatches?.[0];
  let matchStart: number | undefined;
  let matchEnd: number | undefined;
  if (first && Number.isInteger(first.start) && Number.isInteger(first.end) && first.start >= 0 && first.end >= first.start) {
    const bytes = typeof data.lines?.bytes === "string"
      ? Buffer.from(data.lines.bytes, "base64")
      : Buffer.from(decodeText(data.lines), "utf8");
    if (first.end <= bytes.length) {
      matchStart = Math.min(text.length, bytes.subarray(0, first.start).toString("utf8").replace(/\r/g, "").length);
      matchEnd = Math.min(text.length, bytes.subarray(0, first.end).toString("utf8").replace(/\r/g, "").length);
    }
  }

  return {
    path,
    lineNumber: data.line_number,
    text,
    isContext: event.type === "context",
    matchStart,
    matchEnd,
  };
}
