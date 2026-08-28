/**
 * ripgrep `--json` stream decoding.
 *
 * rg emits one JSON object per line. The tool only requests and decodes match
 * events; begin/end/summary and malformed records are ignored.
 *
 * Text may arrive as `{ text }` or, for invalid UTF-8, as `{ bytes }` (base64).
 */

export interface RgLine {
  readonly path: string;
  readonly lineNumber: number;
  readonly text: string;
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
    };
  };
  try {
    event = JSON.parse(trimmed);
  } catch {
    return undefined;
  }

  if (event.type !== "match") return undefined;
  const data = event.data;
  if (!data || typeof data.line_number !== "number") return undefined;

  const path = decodeText(data.path);
  if (path.length === 0) return undefined;

  // rg keeps the trailing newline on `lines`; strip it and any CR so callers
  // can treat the value as one display line.
  const text = decodeText(data.lines)
    .replace(/\r?\n$/, "")
    .replace(/\r/g, "");

  return {
    path,
    lineNumber: data.line_number,
    text,
  };
}
