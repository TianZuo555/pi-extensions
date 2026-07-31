/**
 * Pre-spawn shape guards for calls whose contract the model has misunderstood.
 *
 * Both failures these catch are otherwise SILENT: a discarded `cd` makes the
 * next call run somewhere else and still exit 0, and re-running a command that
 * is still executing repeats every side effect without ever producing an error.
 * Prompt wording can only make those less likely; these guards make them loud.
 *
 * Deliberately separate from ./exploration-budget.ts. That classifier answers
 * "is this read-only inspection?" and its segment splitting must not change.
 * This one also splits on newlines, because a multi-line script whose first
 * line happens to be `cd` is not a state-only command.
 */

import { formatElapsed, type TerminalSnapshot } from "./domain.ts";

const ASSIGNMENT =
  /^(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)$/;
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
  return segments.every(
    (segment) => ASSIGNMENT.test(segment) || BARE_CD.test(segment),
  );
}

export function stateOnlyCommandError() {
  return (
    "This command only changes shell state (cd/export/assignment), and this shell is discarded when it " +
    "exits, so it cannot affect any later call. It was not executed. Pass working_dir to choose the " +
    "directory, or combine setup and work in one command: `cd packages/x && npm test`."
  );
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
    (snap) =>
      snap.status === "running" && snap.command === command && snap.cwd === cwd,
  );
}

export function duplicateCommandError(snap: TerminalSnapshot) {
  return (
    `This exact command is already running as background terminal ${snap.id} ` +
    `(started ${formatElapsed(snap)} ago, pid ${snap.pid ?? "?"}). It has not failed: a yielded command ` +
    "keeps running and reports back automatically when it exits. This second copy was not executed, " +
    "because re-running it would repeat its side effects. Wait for that result, or stop it from /ps. " +
    "To run it again on purpose, change the command text or use a different working_dir."
  );
}
