// Helpers that read and reshape the Rex session-start output.

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

/** Read `.windows` from `rex session inspect --json` output. */
export function countWindows(json: string): number | undefined {
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const windows = (parsed as { windows?: unknown }).windows;
    return Array.isArray(windows) ? windows.length : undefined;
  } catch {
    return undefined;
  }
}
