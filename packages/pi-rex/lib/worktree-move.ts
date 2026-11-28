// Move the running pi agent into a git worktree.
//
// The agent calls one tool, `rex_worktree_move`, after it creates a worktree.
// The tool opens a Rex session for the worktree and moves this Rex tab into it.
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
import type { Exec } from "./naming.ts";
import { REX_TIMEOUT_MS } from "./naming.ts";
import {
  continuePrompt,
  moveResult,
  WORKTREE_MOVE_DESCRIPTION,
  WORKTREE_MOVE_GUIDELINES,
  WORKTREE_PATH_DESCRIPTION,
} from "./prompt.ts";
import { parseLocation } from "./rex-output.ts";
import { sessionLabel } from "./session-name.ts";

/** Name of the tool the agent calls. */
export const WORKTREE_MOVE_TOOL = "rex_worktree_move";

/** Internal command that switches the pi session. The tool starts it. */
export const SWITCH_COMMAND = "rex-worktree-switch";

export interface MoveInput {
  /** Absolute path of the worktree. */
  readonly target: string;
  readonly exec: Exec;
}

export interface MoveOutput {
  readonly sessionId: string;
  readonly sessionLabel: string;
  /** Labels of the Rex apps that now show the moved tab. */
  readonly followed: readonly string[];
  /** One message for each Rex app that refused to show the moved tab. */
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
 * Open a Rex session for the worktree and move this tab into it. The new
 * session starts with a shell tab, which the move makes extra, so close it.
 * A session that the move leaves without tabs is removed too.
 *
 * A Rex app keeps the session that it shows, so after the move it shows the
 * old session. Each app that had the old session open goes to the moved tab.
 * An app accepts this only when its Remote Control setting is on.
 */
export async function moveTab(input: MoveInput): Promise<MoveOutput> {
  const { target, exec } = input;
  const rex = (args: string[]) => exec("rex", args, { cwd: target, timeout: REX_TIMEOUT_MS });

  const here = parseLocation((await rex(["whoami", "--json"])).stdout);
  if (!here) throw new Error("Rex does not answer, or it cannot find this tab.");
  const windowId = here.windowId;

  // Read the apps before the move: a removed old session has no apps.
  const apps = here.sessionId
    ? parseApps((await rex(["client", "ls", "-s", here.sessionId, "--json"])).stdout)
    : [];

  const label = await sessionLabel(exec, target, REX_TIMEOUT_MS);
  const created = await rex(["new", label, "--cwd", target, "--json"]);
  const session = created.code === 0 ? parseNewSession(created.stdout) : undefined;
  if (!session) throw new Error(`rex new failed (exit ${created.code}).`);

  const moved = await rex(["window", "move", windowId, "--to", session.sessionId, "--focus"]);
  if (moved.code !== 0) {
    // Do not leave an empty session behind.
    await rex(["kill", session.sessionId]);
    throw new Error(`rex window move failed (exit ${moved.code}).`);
  }
  if (session.windowId) await rex(["window", "close", "-s", session.sessionId, session.windowId]);
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
  return { sessionId: session.sessionId, sessionLabel: label, followed, refused };
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
  await ctx.switchSession(next, {
    withSession: async (replaced) => {
      await replaced.sendUserMessage(prompt);
    },
  });
}

export function registerWorktreeMove(pi: ExtensionAPI): void {
  // The session label of the last move, for the message after the switch.
  let movedTo = "";

  pi.registerTool({
    name: WORKTREE_MOVE_TOOL,
    label: "Rex Worktree Move",
    description: WORKTREE_MOVE_DESCRIPTION,
    promptGuidelines: WORKTREE_MOVE_GUIDELINES,
    parameters: Type.Object({ path: Type.String({ description: WORKTREE_PATH_DESCRIPTION }) }),
    exposure: "codemode",
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!process.env.REX_BLOCK && !process.env.REX_SESSION) {
        throw new Error("Pi does not run in a Rex terminal.");
      }
      const target = resolveTarget(params.path, ctx.cwd);
      const moved = await moveTab({
        target,
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
