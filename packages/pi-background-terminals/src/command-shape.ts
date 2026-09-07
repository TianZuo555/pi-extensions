/**
 * Pre-spawn shape guards for calls whose contract the model has misunderstood.
 *
 * Both failures these catch are otherwise SILENT: a discarded `cd` makes the
 * next call run somewhere else and still exit 0, and re-running a command that
 * is still executing repeats every side effect without ever producing an error.
 * Prompt wording can only make those less likely; these guards make them loud.
 *
 * This splitter also splits on newlines, because a multi-line script whose
 * first line happens to be `cd` is not a state-only command.
 */

import type { TerminalSnapshot } from "./domain.ts";

const ASSIGNMENT = /^(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)$/;
const BARE_CD = /^cd(?:\s|$)/i;
/** Syntax that can touch the world outside the discarded shell: redirects
 * create files, substitution runs real commands. Ambiguity fails open. */
const ESCAPES_THE_SHELL = /[<>`]|\$\(/;

/**
 * True when every segment only mutates shell state (`cd`, `export`, bare
 * assignment) and the command therefore cannot outlive its own shell.
 */
export function isStateOnlyCommand(command: string) {
  if (ESCAPES_THE_SHELL.test(command)) return false;
  const segments = command
    .trim()
    .split(/\s*(?:&&|\|\||[;|]|\n)\s*/)
    .filter(Boolean);
  if (segments.length === 0) return false;
  return segments.every((segment) => ASSIGNMENT.test(segment) || BARE_CD.test(segment));
}

/**
 * An already-running terminal for the identical command in the identical
 * directory. Same command in another directory, or one that already settled,
 * is a legitimate new run.
 */
export function findDuplicateRunning(
  snapshots: ReadonlyArray<TerminalSnapshot>,
  command: string,
  cwd: string,
) {
  return snapshots.find(
    (snap) => snap.status === "running" && snap.command === command && snap.cwd === cwd,
  );
}
