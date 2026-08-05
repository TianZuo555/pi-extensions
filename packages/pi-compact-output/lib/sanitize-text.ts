// Strip terminal control sequences from untrusted tool text before compact display.
// Rendered call lines from trusted tool renderers keep their ANSI styling.

// eslint-disable-next-line no-control-regex
const OSC_PATTERN =
  /(?:\u001b\]|\u009d)(?:[^\u0007\u001b\u009c]|\u001b(?!\\))*(?:\u0007|\u001b\\|\u009c)/g;
// eslint-disable-next-line no-control-regex
const CSI_PATTERN = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const ESCAPE_PATTERN = /\u001b(?:[()][0-2A-Z]|[ -/]*[@-~])/g;

export const MAX_SANITIZE_INPUT = 2048;
const MAX_COMPACT_TEXT = 512;

function stripTerminalControls(text: string): string {
  return text
    .replace(OSC_PATTERN, "")
    .replace(CSI_PATTERN, "")
    .replace(ESCAPE_PATTERN, "")
    .replaceAll("\t", "  ")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

/** Bound untrusted input before any split, trim, or regex work. */
export function capUntrustedText(text: string): string {
  return text.length > MAX_SANITIZE_INPUT ? text.slice(0, MAX_SANITIZE_INPUT) : text;
}

function sanitizeBoundedLine(text: string): string {
  const segments = text.split(/\r?\n/, 1)[0]?.split("\r") ?? [];
  const lastSegment = segments.at(-1) ?? "";
  const cleaned = stripTerminalControls(lastSegment).replace(/\s+/g, " ").trim();
  return cleaned.length > MAX_COMPACT_TEXT ? cleaned.slice(0, MAX_COMPACT_TEXT) : cleaned;
}

/** Sanitize untrusted tool text to a single printable line with a hard input cap. */
export function sanitizeCompactText(text: string): string {
  return sanitizeBoundedLine(capUntrustedText(text));
}

/** Return the first non-empty sanitized line from capped tool error text. */
export function firstSanitizedLine(text: string): string | undefined {
  return firstSanitizedLines(text, 1)[0];
}

/** Return up to `count` non-empty sanitized lines from capped text. */
export function firstSanitizedLines(text: string, count: number): string[] {
  if (count <= 0) return [];
  const capped = capUntrustedText(text);
  const lines: string[] = [];
  for (const line of capped.split("\n")) {
    const sanitized = sanitizeBoundedLine(line);
    if (!sanitized) continue;
    lines.push(sanitized);
    if (lines.length >= count) break;
  }
  return lines;
}

/** Return up to `count` non-empty sanitized lines from the END of capped text.
 * Keeps the newest streamed lines visible (auto-scroll to bottom). */
export function lastSanitizedLines(text: string, count: number): string[] {
  if (count <= 0) return [];
  const capped = capUntrustedText(text);
  const lines: string[] = [];
  for (const line of capped.split("\n")) {
    const sanitized = sanitizeBoundedLine(line);
    if (!sanitized) continue;
    lines.push(sanitized);
  }
  return lines.slice(-count);
}
