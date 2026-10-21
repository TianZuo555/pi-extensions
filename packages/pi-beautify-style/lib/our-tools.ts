// Bridges between the vendored Claude Code style and the sibling extensions in
// this monorepo. The vendored renderers know Pi's built-in tools and the
// upstream author's ecosystem (`ask_user_question`, `@narumitw/pi-usage`); they
// know nothing about `ask_user`, `terminal_*`, or `@tian.zuo/pi-usage`.
//
// Everything here is pure so it can be unit tested without a TUI.

/** Tool names registered by `@tian.zuo/pi-ask-user`. */
export const ASK_USER_TOOL_NAME = "ask_user";
/** Upstream renderer name kept for compatibility with the vendored sources. */
export const UPSTREAM_ASK_USER_TOOL_NAME = "ask_user_question";

/** Tools registered by `@tian.zuo/pi-background-terminals`. */
export const BACKGROUND_TERMINAL_TOOLS = new Set([
  "terminal_wait",
  "terminal_stop",
  "terminal_log_read",
]);

/** Status keys owned by our packages, mapped to the footer chip text we want. */
export const OUR_STATUS_KEYS = {
  tokenSpeed: "token-speed",
  usage: "usage",
} as const;

type Answer = {
  questionIndex?: unknown;
  question?: unknown;
  choice?: { label?: unknown; wasCustom?: unknown };
  /** Upstream `ask_user_question` shape. */
  answer?: unknown;
  selected?: unknown;
  notes?: unknown;
  kind?: unknown;
};

export type NormalizedAnswer = {
  questionIndex: number | undefined;
  question: string;
  label: string;
  /** Free-form text the user typed instead of picking an option. */
  custom: boolean;
};

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Normalize both answer shapes into one list:
 * - `@tian.zuo/pi-ask-user`: `{ questionIndex, question, choice: { label, wasCustom } }`
 * - upstream `ask_user_question`: `{ questionIndex, question, answer | selected | notes }`
 */
export function normalizeAnswers(result: unknown): NormalizedAnswer[] {
  const details = (result as { details?: { answers?: unknown } } | undefined)?.details;
  const raw = Array.isArray(details?.answers) ? (details.answers as Answer[]) : [];
  const answers = raw.map((entry): NormalizedAnswer => {
    const choice = entry?.choice;
    const custom = choice?.wasCustom === true || entry?.kind === "custom";
    // Upstream multi-select: `kind: "multi"` + `selected: string[]`.
    const selected = Array.isArray(entry?.selected) ? entry.selected.map(text).filter(Boolean) : [];
    const label =
      text(choice?.label) ||
      selected.join(", ") ||
      text(entry?.answer) ||
      text(entry?.selected) ||
      text(entry?.notes) ||
      "";
    const index = Number(entry?.questionIndex);
    return {
      questionIndex: Number.isFinite(index) ? index : undefined,
      question: text(entry?.question),
      label,
      custom,
    };
  });
  // Stable order: explicit questionIndex first, then declaration order.
  return answers
    .map((answer, position) => ({ answer, position }))
    .sort((left, right) => {
      const a = left.answer.questionIndex;
      const b = right.answer.questionIndex;
      if (a === undefined || b === undefined) {
        if (a === b) return left.position - right.position;
        return a === undefined ? 1 : -1;
      }
      return a - b;
    })
    .map((entry) => entry.answer);
}

/** True when `result.details.answers` exists and describes a finished ask. */
export function hasAskUserAnswers(result: unknown): boolean {
  const details = (result as { details?: { answers?: unknown } } | undefined)?.details;
  return Array.isArray(details?.answers);
}

export function isAskUserCancelled(result: unknown): boolean {
  return (result as { details?: { cancelled?: unknown } } | undefined)?.details?.cancelled === true;
}

/** Title suffix showing how many questions were asked: `(3)` / `(3, dismissed)`. */
export function askUserCountSuffix(result: unknown): string {
  const count = normalizeAnswers(result).length;
  if (!count) return isAskUserCancelled(result) ? " (dismissed)" : "";
  return isAskUserCancelled(result) ? ` (${count}, dismissed)` : ` (${count})`;
}

/**
 * Which vendored renderer a tool should use. `ask_user` reuses the upstream
 * `ask_user_question` renderer; our terminal tools reuse the upstream shell
 * treatment (spinner, duration, collapsed output).
 */
export function rendererAliasFor(toolName: string): string | undefined {
  if (toolName === ASK_USER_TOOL_NAME) return UPSTREAM_ASK_USER_TOOL_NAME;
  return undefined;
}

/** Our terminal tools behave like shells for summary/timing purposes. */
export function behavesLikeShell(toolName: string): boolean {
  return BACKGROUND_TERMINAL_TOOLS.has(toolName);
}

/**
 * `terminal_wait`/`terminal_stop`/`terminal_log_read` take `ids` (array) rather
 * than the `command` the shell summary expects. Render a readable label so the
 * card title is not an empty JSON blob.
 */
export function terminalToolDetail(args: unknown): string | undefined {
  const value = args as Record<string, unknown> | undefined;
  if (!value || typeof value !== "object") return undefined;
  const ids = Array.isArray(value.ids)
    ? value.ids.filter((id): id is string => typeof id === "string" && id.length > 0)
    : [];
  if (ids.length === 1) return ids[0];
  if (ids.length > 1) return `${ids[0]} (+${ids.length - 1})`;
  if (typeof value.id === "string" && value.id) return value.id;
  return undefined;
}

/**
 * `terminal_log_read` returns a log; `terminal_wait` returns command output.
 * Both are plain text, so the collapsed card only needs a line count.
 */
export function terminalToolLineCount(result: unknown): number {
  const blocks = (result as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(blocks)) return 0;
  const body = blocks
    .filter(
      (block): block is { type: "text"; text: string } =>
        (block as { type?: unknown })?.type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join("\n");
  if (!body) return 0;
  return body.split("\n").length;
}

/**
 * `pi-background-terminals` yields a terminal id plus a tail of output. The id
 * is the actionable bit, so surface it on the collapsed line.
 */
export function backgroundTerminalId(result: unknown): string | undefined {
  const details = (result as { details?: Record<string, unknown> } | undefined)?.details;
  if (!details) return undefined;
  for (const key of ["terminalId", "terminal_id", "id"]) {
    const value = details[key];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

/**
 * Footer chip text for our packages' `setStatus` keys. The vendored footer
 * discovers unknown status keys automatically, so this only has to be
 * non-empty; returning undefined leaves the chip out.
 */
export function statusChipText(key: string, value: string): string | undefined {
  const trimmed = value.replace(/[\r\n\t]+/g, " ").trim();
  if (!trimmed) return undefined;
  if (key === OUR_STATUS_KEYS.tokenSpeed) return trimmed;
  if (key === OUR_STATUS_KEYS.usage) return trimmed;
  return undefined;
}
