// Helpers that read and reshape the Rex CLI output.

export interface RexWindow {
  readonly window_id: string;
  readonly label?: string;
}

export interface RexInspect {
  readonly label: string;
  readonly windows: readonly RexWindow[];
}

/**
 * Remove the paragraph that asks pi to rename the session.
 *
 * Rex marks that paragraph with `rex session rename`, so the match does not
 * depend on the rest of the wording.
 */
export function stripSessionNaming(output: string): string {
  return output
    .split(/\n{2,}/)
    .filter((paragraph) => !paragraph.includes("rex session rename"))
    .join("\n\n")
    .trim();
}

/** Read `.window_id` from `rex whoami --json` output. */
export function parseWhoami(json: string): string | undefined {
  const value = parse(json);
  if (typeof value !== "object" || value === null) return undefined;
  const windowId = (value as { window_id?: unknown }).window_id;
  return typeof windowId === "string" && windowId.length > 0 ? windowId : undefined;
}

/** Read `.label` and `.windows` from `rex session inspect --json` output. */
export function parseInspect(json: string): RexInspect | undefined {
  const value = parse(json);
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as { label?: unknown; windows?: unknown };
  if (typeof record.label !== "string" || !Array.isArray(record.windows)) return undefined;
  const windows: RexWindow[] = [];
  for (const entry of record.windows) {
    if (typeof entry !== "object" || entry === null) return undefined;
    const window = entry as { window_id?: unknown; label?: unknown };
    if (typeof window.window_id !== "string") return undefined;
    windows.push({
      window_id: window.window_id,
      ...(typeof window.label === "string" ? { label: window.label } : {}),
    });
  }
  return { label: record.label, windows };
}

function parse(json: string): unknown {
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return undefined;
  }
}
