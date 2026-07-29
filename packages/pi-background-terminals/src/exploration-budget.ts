/** Guardrail for runaway read-only shell exploration within one agent run. */

export const EXPLORATION_WARNING_AT = 6;
export const EXPLORATION_LIMIT = 8;

const ASSIGNMENT =
  /^(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)$/;
const INSPECTION_COMMAND =
  /^(?:grep|rg|find|ls|sed|head|tail|cat|pwd|wc|stat|file|which|type)(?:\s|$)/i;
const READ_ONLY_GIT =
  /^git(?:\s+-C\s+(?:"[^"]*"|'[^']*'|\S+))*\s+(?:status|log|show|diff|branch|rev-parse)(?:\s|$)/i;
const SETUP_COMMAND = /^(?:cd|echo)(?:\s|$)/i;
const SAFE_REDIRECT = /\d*>>?\s*\/dev\/null\b|\d*>&\d+/g;

/**
 * Deliberately narrow heuristic: every command segment must be a common
 * inspection, harmless setup, or read-only Git query. This recognizes the
 * `D=/path; grep ...` pattern without counting builds merely because they pipe
 * through `head`. Ambiguous shell syntax fails open and is not budgeted.
 */
export function isExploratoryBashCommand(command: string) {
  const redirectsRemoved = command.replace(SAFE_REDIRECT, "");
  if (redirectsRemoved.includes(">")) return false;

  // This is a heuristic rather than a shell parser. Splitting quoted control
  // characters may produce an unknown segment, which safely opts out.
  const segments = command
    .trim()
    .split(/\s*(?:&&|\|\||[;|])\s*/)
    .filter(Boolean);
  if (segments.length === 0) return false;

  let sawInspection = false;
  for (const segment of segments) {
    const normalized = segment.trim();
    if (ASSIGNMENT.test(normalized) || SETUP_COMMAND.test(normalized)) continue;
    if (INSPECTION_COMMAND.test(normalized) || READ_ONLY_GIT.test(normalized)) {
      sawInspection = true;
      continue;
    }
    return false;
  }
  return sawInspection;
}

export function explorationWarning(count: number) {
  if (count < EXPLORATION_WARNING_AT || count > EXPLORATION_LIMIT) {
    return undefined;
  }
  return (
    `[Shell exploration budget: ${count}/${EXPLORATION_LIMIT} read-only inspection calls used in this agent run. ` +
    "Stop broad searching, inspect the best evidence with dedicated read/grep/find tools when available, and synthesize an answer.]"
  );
}

export function explorationLimitError() {
  return (
    `Shell exploration budget reached: more than ${EXPLORATION_LIMIT} read-only Bash inspection calls were requested in this agent run. ` +
    "This command was not executed. Stop searching and synthesize from the evidence already collected. " +
    "Use dedicated read/grep/find tools for one targeted follow-up, or ask the user before continuing broad investigation."
  );
}
