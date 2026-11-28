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

export interface RexLocation {
  readonly windowId: string;
  readonly sessionId?: string;
  readonly blockId?: string;
}

/** Read `.window_id`, `.session_id`, and `.block_id` from `rex whoami --json` output. */
export function parseLocation(json: string): RexLocation | undefined {
  const windowId = parseWhoami(json);
  if (!windowId) return undefined;
  const value = parse(json) as { session_id?: unknown; block_id?: unknown };
  const text = (field: unknown): string | undefined =>
    typeof field === "string" && field.length > 0 ? field : undefined;
  const sessionId = text(value.session_id);
  const blockId = text(value.block_id);
  return { windowId, ...(sessionId ? { sessionId } : {}), ...(blockId ? { blockId } : {}) };
}

export interface RexWindowLayout {
  readonly label?: string;
  /** IDs of the panes in the window, from every layer. */
  readonly blocks: readonly string[];
}

/** Read one window and its panes from `rex session inspect --json` output. */
export function parseWindowLayout(json: string, windowId: string): RexWindowLayout | undefined {
  const value = parse(json) as { windows?: unknown } | undefined;
  if (!Array.isArray(value?.windows)) return undefined;
  const window = value.windows.find(
    (entry: unknown) =>
      typeof entry === "object" &&
      entry !== null &&
      (entry as { window_id?: unknown }).window_id === windowId,
  ) as { label?: unknown; layers?: unknown } | undefined;
  if (!window) return undefined;
  const blocks: string[] = [];
  for (const layer of Array.isArray(window.layers) ? window.layers : []) {
    const entries = (layer as { blocks?: unknown } | null)?.blocks;
    for (const block of Array.isArray(entries) ? entries : []) {
      const id = (block as { block_id?: unknown } | null)?.block_id;
      if (typeof id === "string") blocks.push(id);
    }
  }
  return { ...(typeof window.label === "string" ? { label: window.label } : {}), blocks };
}

function parse(json: string): unknown {
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return undefined;
  }
}
