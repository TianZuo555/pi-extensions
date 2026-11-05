// Orchestrates automatic Rex naming. The extension asks the session model for
// one label, then renames the tab and, for the first tab, the session.
//
// Every Rex call is best-effort: a failing command or model call leaves the
// generated name in place and does not block the main agent run.

import { namingPrompt } from "./prompt.ts";
import { parseInspect, parseWhoami, type RexInspect, type RexWindow } from "./rex-output.ts";

/** Upper bound for the task text sent to the naming model. */
export const MAX_TASK_LENGTH = 4000;

/** Timeout for one Rex CLI call. */
export const REX_TIMEOUT_MS = 5000;

/** Default Rex session labels are two lowercase words, such as `shy-strait`. */
const SESSION_LABEL = /^[a-z]+-[a-z]+$/;

/** Default Rex tab labels are `Window <id suffix>`. */
const WINDOW_LABEL = /^Window [0-9a-f]{4,}$/;

export interface ExecResult {
  readonly code: number;
  readonly stdout: string;
}

export type Exec = (
  command: string,
  args: string[],
  options: { cwd: string; timeout: number },
) => Promise<ExecResult>;

/** Returns the raw model reply for one naming prompt. */
export type Ask = (prompt: string) => Promise<string>;

export interface NameSessionInput {
  readonly session: string;
  readonly cwd: string;
  readonly task: string;
  readonly exec: Exec;
  readonly ask: Ask;
}

/** A generated session label may be replaced. A hand-set label may not. */
export function isGeneratedSessionLabel(label: string): boolean {
  return SESSION_LABEL.test(label);
}

/** A generated tab label may be replaced. A hand-set label may not. */
export function isGeneratedWindowLabel(label: string): boolean {
  return WINDOW_LABEL.test(label);
}

/** Sanitize one model reply into a Rex label, or reject it. */
export function parseLabel(raw: string): string | undefined {
  const firstLine =
    raw
      .trim()
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0 && !line.startsWith("```")) ?? "";
  const label = firstLine
    .replace(/^```[a-z]*\s*/i, "")
    .replace(/```\s*$/, "")
    .replace(/^label:\s*/i, "")
    .replace(/^["'`\s]+|["'`.,;:\s]+$/g, "")
    .toLowerCase();
  if (label.length === 0 || label.length > 40) return undefined;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+){1,3}$/.test(label)) return undefined;
  return label;
}

/** Rename the current tab, and the session when this tab is the first one. */
export async function nameSession(input: NameSessionInput): Promise<void> {
  const { session, cwd, exec } = input;
  const options = { cwd, timeout: REX_TIMEOUT_MS };
  const rex = (args: string[]) => exec("rex", args, options);

  const task = input.task.slice(0, MAX_TASK_LENGTH).trim();
  if (task.length === 0) return;
  let label: string | undefined;
  try {
    label = parseLabel(await input.ask(namingPrompt(task)));
  } catch {
    return;
  }
  if (!label) return;

  // Read the state after the model call. A user or the main agent can rename
  // while it runs, and those labels must win.
  const whoami = parseWhoami((await rex(["whoami", "--json"])).stdout);
  if (!whoami) return;
  const state = parseInspect((await rex(["session", "inspect", session, "--json"])).stdout);
  if (!state) return;
  const current = findWindow(state, whoami);
  if (!current) return;

  if (isGeneratedSessionLabel(state.label) && isFirstWindow(state, whoami)) {
    await rex(["session", "rename", session, label]);
  }
  if (current.label === undefined || isGeneratedWindowLabel(current.label)) {
    await rex(["window", "rename", "-s", session, whoami, label]);
  }
}

/** Windows are ordered by ID, which Rex derives from creation time. */
function isFirstWindow(state: RexInspect, windowId: string): boolean {
  const ids = state.windows.map((window) => window.window_id).sort();
  return ids[0] === windowId;
}

function findWindow(state: RexInspect, windowId: string): RexWindow | undefined {
  return state.windows.find((window) => window.window_id === windowId);
}
