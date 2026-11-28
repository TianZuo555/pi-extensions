// Move the running pi agent into a git worktree.
//
// The agent calls one tool, `rex_worktree_move`, after it creates a worktree.
// The tool opens a Rex session for the worktree and moves this Rex pane into it.
// Pi keeps running during the move, so the conversation stays.
//
// The move alone does not change the folder pi works in. Only a command
// context can replace the pi session, so the tool also starts an internal
// command. The command waits until the turn ends, copies the conversation into
// a session for the worktree, and switches to it. Pi then builds its tools,
// system prompt, and context files for the worktree.

import { realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Exec, ExecResult } from "./naming.ts";
import { REX_TIMEOUT_MS } from "./naming.ts";
import {
  continuePrompt,
  moveResult,
  WORKTREE_MOVE_DESCRIPTION,
  WORKTREE_MOVE_GUIDELINES,
  PANE_LABEL_DESCRIPTION,
  WORKTREE_PATH_DESCRIPTION,
} from "./prompt.ts";
import { parseLocation, parseWindowLayout, type RexWindowLayout } from "./rex-output.ts";
import { sessionLabel } from "./session-name.ts";

/** Name of the tool the agent calls. */
export const WORKTREE_MOVE_TOOL = "rex_worktree_move";

/** Internal command that switches the pi session. The tool starts it. */
export const SWITCH_COMMAND = "rex-worktree-switch";

export interface MoveInput {
  /** Absolute path of the worktree. */
  readonly target: string;
  readonly exec: Exec;
  /** Pane label from the agent: the feature name. */
  readonly label?: string;
}

/** Longest pane label. Rex shows the label in the pane title. */
export const MAX_PANE_LABEL = 40;

/** Clean a pane label to one short line. Undefined when nothing is left. */
export function cleanPaneLabel(raw: string | undefined): string | undefined {
  const label = (raw ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_PANE_LABEL).trim();
  return label.length > 0 ? label : undefined;
}

/**
 * Pane label: the feature name from the agent, else the worktree branch, else
 * the folder name. A feature branch usually has the feature name.
 */
export async function paneLabel(exec: Exec, target: string, label?: string): Promise<string> {
  const given = cleanPaneLabel(label);
  if (given) return given;
  try {
    const branch = await exec("git", ["branch", "--show-current"], {
      cwd: target,
      timeout: REX_TIMEOUT_MS,
    });
    const name = branch.code === 0 ? cleanPaneLabel(branch.stdout) : undefined;
    if (name) return name;
  } catch {
    // Use the folder name.
  }
  return cleanPaneLabel(path.basename(target)) ?? "pi";
}

export interface MoveOutput {
  readonly sessionId: string;
  readonly sessionLabel: string;
  /** New label of the moved pane, when Rex accepted the rename. */
  readonly paneLabel?: string;
  /** Labels of the Rex apps that now show the moved pane. */
  readonly followed: readonly string[];
  /** One message for each Rex app that refused to show the moved pane. */
  readonly refused: readonly string[];
}

export interface RexApp {
  readonly id: string;
  readonly label: string;
}

/** Read the Rex apps from `rex client ls --json` output. CLI clients are not apps. */
export function parseApps(json: string): RexApp[] {
  let value: unknown;
  try {
    value = JSON.parse(json) as unknown;
  } catch {
    return [];
  }
  const clients = (value as { clients?: unknown } | null)?.clients;
  if (!Array.isArray(clients)) return [];
  const apps: RexApp[] = [];
  for (const client of clients) {
    if (typeof client !== "object" || client === null) continue;
    const record = client as { client_id?: unknown; info?: { kind?: unknown; label?: unknown } };
    if (typeof record.client_id !== "string" || record.info?.kind !== "app") continue;
    const label = typeof record.info.label === "string" ? record.info.label : record.client_id;
    apps.push({ id: record.client_id, label });
  }
  return apps;
}

/** Read `.session_id` and the first window from `rex new --json` output. */
export function parseNewSession(
  json: string,
): { sessionId: string; windowId?: string } | undefined {
  let value: unknown;
  try {
    value = JSON.parse(json) as unknown;
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as { session_id?: unknown; initial_windows?: unknown };
  if (typeof record.session_id !== "string" || record.session_id.length === 0) return undefined;
  const first = Array.isArray(record.initial_windows) ? record.initial_windows[0] : undefined;
  const windowId =
    typeof first === "object" && first !== null
      ? (first as { window_id?: unknown }).window_id
      : undefined;
  return {
    sessionId: record.session_id,
    ...(typeof windowId === "string" && windowId.length > 0 ? { windowId } : {}),
  };
}

/** True when `rex session inspect --json` output shows a session without tabs. */
export function isEmptySession(json: string): boolean {
  try {
    // Rex leaves out `windows` for a session without tabs.
    const value = JSON.parse(json) as { session_id?: unknown; windows?: unknown } | null;
    if (typeof value?.session_id !== "string") return false;
    const windows = value.windows;
    return windows == null || (Array.isArray(windows) && windows.length === 0);
  } catch {
    return false;
  }
}

/** Expand a leading `~` to the home folder, as a shell does. */
export function expandHome(input: string, home: string = os.homedir()): string {
  if (input === "~") return home;
  if (input.startsWith("~/") || input.startsWith("~\\")) return path.join(home, input.slice(2));
  return input;
}

/** Resolve the tool argument to an existing folder. Throws a message for the model. */
export function resolveTarget(input: string, cwd: string): string {
  const absolute = path.resolve(cwd, expandHome(input.trim()));
  let real: string;
  try {
    real = realpathSync(absolute);
  } catch {
    throw new Error(`The folder ${absolute} does not exist. Create the worktree first.`);
  }
  if (!statSync(real).isDirectory()) throw new Error(`${absolute} is not a folder.`);
  let current = cwd;
  try {
    current = realpathSync(cwd);
  } catch {
    // Compare the path as given when the current folder is gone.
  }
  if (real === current) throw new Error(`Pi already works in ${real}.`);
  return real;
}

/**
 * Open a Rex session for the worktree and move this pane into it.
 *
 * Rex moves only whole tabs to another session. When the tab of this pane has
 * other panes, the pane first goes to a new tab of its own in the old session.
 * The other panes stay where they are. The new session starts with a shell
 * tab, which the move makes extra, so close it. A session that the move leaves
 * without tabs is removed too.
 *
 * A Rex app keeps the session that it shows, so after the move it shows the
 * old session. Each app that had the old session open goes to the moved pane.
 * An app accepts this only when its Remote Control setting is on.
 */
export async function movePane(input: MoveInput): Promise<MoveOutput> {
  const { target, exec } = input;
  const rex = (args: string[]) => exec("rex", args, { cwd: target, timeout: REX_TIMEOUT_MS });

  const here = parseLocation((await rex(["whoami", "--json"])).stdout);
  if (!here) throw new Error("Rex does not answer, or it cannot find this pane.");

  // Read the apps and the layout before the move: a removed old session has
  // no apps.
  let layout: RexWindowLayout | undefined;
  let apps: RexApp[] = [];
  if (here.sessionId) {
    apps = parseApps((await rex(["client", "ls", "-s", here.sessionId, "--json"])).stdout);
    const state = await rex(["session", "inspect", here.sessionId, "--json"]);
    if (state.code === 0) layout = parseWindowLayout(state.stdout, here.windowId);
  }

  const label = await sessionLabel(exec, target, REX_TIMEOUT_MS);
  const created = await rex(["new", label, "--cwd", target, "--json"]);
  const session = created.code === 0 ? parseNewSession(created.stdout) : undefined;
  if (!session) throw new Error(`rex new failed (exit ${created.code}).`);

  let windowId = here.windowId;
  if (here.sessionId && here.blockId && layout && layout.blocks.length > 1) {
    try {
      windowId = await detachPane(rex, here.sessionId, here.blockId, layout.label);
    } catch (error) {
      // Do not leave an empty session behind.
      await rex(["kill", session.sessionId]);
      throw error;
    }
  }

  const moved = await rex(["window", "move", windowId, "--to", session.sessionId, "--focus"]);
  if (moved.code !== 0) {
    await rex(["kill", session.sessionId]);
    throw new Error(`rex window move failed (exit ${moved.code}).`);
  }
  if (session.windowId) await rex(["window", "close", "-s", session.sessionId, session.windowId]);

  // Name the pane after the feature. A failed rename does not stop the move.
  let renamed: string | undefined;
  if (here.blockId) {
    const name = await paneLabel(exec, target, input.label);
    const result = await rex(["block", "rename", "-s", session.sessionId, here.blockId, name]);
    if (result.code === 0) renamed = name;
  }

  if (here.sessionId) {
    const old = await rex(["session", "inspect", here.sessionId, "--json"]);
    if (old.code === 0 && isEmptySession(old.stdout)) await rex(["kill", here.sessionId]);
  }

  const followed: string[] = [];
  const refused: string[] = [];
  for (const app of apps) {
    const select = await rex([
      "-C",
      app.id,
      "do",
      "session.select",
      `session_id=${session.sessionId}`,
      `window_id=${windowId}`,
    ]);
    if (select.code === 0) {
      followed.push(app.label);
    } else {
      const reason =
        (select.stderr ?? "")
          .trim()
          .replace(/^Error:\s*/, "")
          .replace(/[.\s]+$/, "") || `exit ${select.code}`;
      refused.push(`${app.label}: ${reason}`);
    }
  }
  return {
    sessionId: session.sessionId,
    sessionLabel: label,
    ...(renamed ? { paneLabel: renamed } : {}),
    followed,
    refused,
  };
}

/**
 * Give a pane a tab of its own in its session, and return the new tab. The
 * new tab starts with a shell pane. The pane goes next to that shell pane,
 * then the shell pane closes. The new tab keeps the label of the old tab.
 */
async function detachPane(
  rex: (args: string[]) => Promise<ExecResult>,
  sessionId: string,
  blockId: string,
  label: string | undefined,
): Promise<string> {
  const opened = await rex([
    "window",
    "new",
    "-s",
    sessionId,
    ...(label ? [label] : []),
    "--focus=false",
    "--json",
  ]);
  const tab = opened.code === 0 ? parseNewWindow(opened.stdout) : undefined;
  if (!tab) throw new Error(`rex window new failed (exit ${opened.code}).`);
  const moved = await rex(["move", "-s", sessionId, blockId, "right", tab.blockId]);
  if (moved.code !== 0) {
    await rex(["window", "close", "-s", sessionId, tab.windowId]);
    throw new Error(`rex move failed (exit ${moved.code}).`);
  }
  await rex(["block", "close", "-s", sessionId, tab.blockId]);
  return tab.windowId;
}

/** Read `.window_id` and the first block from `rex window new --json` output. */
export function parseNewWindow(json: string): { windowId: string; blockId: string } | undefined {
  let value: unknown;
  try {
    value = JSON.parse(json) as unknown;
  } catch {
    return undefined;
  }
  const record = value as { window_id?: unknown; block_ids?: unknown } | null;
  const blockId = Array.isArray(record?.block_ids) ? record.block_ids[0] : undefined;
  if (typeof record?.window_id !== "string" || typeof blockId !== "string") return undefined;
  return { windowId: record.window_id, blockId };
}

/** Copy the conversation into a session for the worktree, then switch to it. */
export async function switchToWorktree(
  ctx: ExtensionCommandContext,
  target: string,
  sessionName: string,
): Promise<void> {
  await ctx.waitForIdle();
  const file = ctx.sessionManager.getSessionFile();
  if (!file) {
    ctx.ui.notify("pi-rex: this pi session has no file, so it cannot move.", "error");
    return;
  }
  const next = SessionManager.forkFrom(file, target).getSessionFile();
  if (!next) {
    ctx.ui.notify("pi-rex: pi did not write the worktree session.", "error");
    return;
  }
  const prompt = continuePrompt(target, sessionName);
  // Pi builds the new runtime from the session cwd, but it does not change the
  // folder of the process. An extension that reads process.cwd() would stay in
  // the old folder. Change it before the switch, so the new extension
  // instances see the worktree at session start.
  const previous = enterFolder(target);
  let cancelled = true;
  try {
    cancelled = (
      await ctx.switchSession(next, {
        withSession: async (replaced) => {
          await replaced.sendUserMessage(prompt);
        },
      })
    ).cancelled;
  } finally {
    // An extension can cancel the switch. Pi then stays in the old session.
    if (cancelled && previous !== undefined) {
      try {
        enterFolder(previous);
      } catch {
        // The old folder is gone. Stay in the worktree.
      }
    }
  }
}

/**
 * Change the folder of the process and `PWD`, as `cd` does. Returns the old
 * folder, or undefined when the old folder is gone.
 */
export function enterFolder(folder: string): string | undefined {
  let previous: string | undefined;
  try {
    previous = process.cwd();
  } catch {
    previous = undefined;
  }
  process.chdir(folder);
  process.env.PWD = folder;
  return previous;
}

export function registerWorktreeMove(pi: ExtensionAPI): void {
  // The session label of the last move, for the message after the switch.
  let movedTo = "";

  pi.registerTool({
    name: WORKTREE_MOVE_TOOL,
    label: "Rex Worktree Move",
    description: WORKTREE_MOVE_DESCRIPTION,
    promptGuidelines: WORKTREE_MOVE_GUIDELINES,
    parameters: Type.Object({
      path: Type.String({ description: WORKTREE_PATH_DESCRIPTION }),
      label: Type.Optional(Type.String({ description: PANE_LABEL_DESCRIPTION })),
    }),
    exposure: "codemode",
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!process.env.REX_BLOCK && !process.env.REX_SESSION) {
        throw new Error("Pi does not run in a Rex terminal.");
      }
      const target = resolveTarget(params.path, ctx.cwd);
      const moved = await movePane({
        target,
        ...(params.label !== undefined ? { label: params.label } : {}),
        exec: async (command, args, options) => {
          const result = await pi.exec(command, args, options);
          return { code: result.code, stdout: result.stdout, stderr: result.stderr };
        },
      });
      // A session ID set at start names the old session. Rex finds the
      // session of REX_BLOCK by itself, so only a set value needs a change.
      if (process.env.REX_SESSION) process.env.REX_SESSION = moved.sessionId;
      movedTo = moved.sessionLabel;
      // Pi runs the command at once, also during a turn. The command waits
      // until this turn ends.
      pi.sendUserMessage(`/${SWITCH_COMMAND} ${target}`, {
        deliverAs: "followUp",
        expandPromptTemplates: true,
      });
      return {
        content: [{ type: "text", text: moveResult(target, moved, ctx.cwd) }],
        details: undefined,
        terminate: true,
      };
    },
  });

  pi.registerCommand(SWITCH_COMMAND, {
    description: "Switch pi to a worktree (rex_worktree_move runs this)",
    handler: async (args, ctx) => {
      const input = args.trim();
      if (!input) {
        ctx.ui.notify(`Usage: /${SWITCH_COMMAND} <worktree path>`, "warning");
        return;
      }
      let target: string;
      try {
        target = resolveTarget(input, ctx.cwd);
      } catch (error) {
        ctx.ui.notify(`pi-rex: ${error instanceof Error ? error.message : String(error)}`, "error");
        return;
      }
      const name = movedTo || path.basename(target);
      movedTo = "";
      await switchToWorktree(ctx, target, name);
    },
  });
}
