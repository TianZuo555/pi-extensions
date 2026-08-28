/**
 * Herdr pane/workspace helpers — thin typed wrappers over cli.ts.
 */

import { Effect } from "effect";
import {
  HerdrCommandError,
  HerdrProtocolError,
  type HerdrCliOptions,
  type HerdrError,
  herdrJson,
  herdrText,
  stripAnsi,
} from "./cli.ts";

export type SplitDirection = "right" | "down";

const DEFAULT_SHELL_WAIT_MS = 5_000;
const DEFAULT_SHELL_POLL_MS = 150;
const WIDE_LAYOUT_WIDTH = 120;

export interface HerdrLayout {
  panes: readonly unknown[];
  area: { width?: number; height?: number; x?: number; y?: number };
  direction: SplitDirection;
  workspaceId?: string;
}

export interface WaitForShellOptions extends HerdrCliOptions {
  /** Poll deadline (default 5000ms). */
  deadlineMs?: number;
  /** Poll interval (default 150ms). */
  pollMs?: number;
}

export function pickSplitDirection(width: number): SplitDirection {
  return width >= WIDE_LAYOUT_WIDTH ? "right" : "down";
}

export function currentLayout(options?: HerdrCliOptions): Effect.Effect<HerdrLayout, HerdrError> {
  return herdrJson(["pane", "layout", "--current"], options).pipe(
    Effect.map((result) => {
      const layout = (
        result as {
          layout?: {
            panes?: unknown[];
            area?: { width?: number; height?: number; x?: number; y?: number };
            workspace_id?: string;
          };
        }
      ).layout;
      const area = layout?.area ?? {};
      const width = Number(area.width ?? 0);
      return {
        panes: layout?.panes ?? [],
        area,
        direction: pickSplitDirection(width),
        workspaceId: typeof layout?.workspace_id === "string" ? layout.workspace_id : undefined,
      };
    }),
  );
}

export function splitPane(
  input: { cwd: string; direction: SplitDirection },
  options?: HerdrCliOptions,
): Effect.Effect<string, HerdrError> {
  return herdrJson(
    [
      "pane",
      "split",
      "--current",
      "--direction",
      input.direction,
      "--no-focus",
      "--cwd",
      input.cwd,
    ],
    options,
  ).pipe(
    Effect.flatMap((result) => {
      const paneId = (result as { pane?: { pane_id?: string } }).pane?.pane_id;
      if (!paneId) {
        return Effect.fail(
          new HerdrProtocolError({
            message: "herdr pane split response missing pane.pane_id",
          }),
        );
      }
      return Effect.succeed(paneId);
    }),
  );
}

function shellLooksReady(result: unknown): boolean {
  const info = (
    result as {
      process_info?: { shell_pid?: number; foreground_process_group_id?: number };
    }
  ).process_info;
  if (!info) return false;
  const shellPid = info.shell_pid;
  const fgPgid = info.foreground_process_group_id;
  if (typeof shellPid !== "number" || typeof fgPgid !== "number") return false;
  return fgPgid === shellPid;
}

function sleepMs(ms: number): Effect.Effect<void> {
  return Effect.promise(() => new Promise((resolve) => setTimeout(resolve, ms)));
}

export function waitForShell(
  paneId: string,
  options?: WaitForShellOptions,
): Effect.Effect<void, HerdrError> {
  const deadlineMs = options?.deadlineMs ?? DEFAULT_SHELL_WAIT_MS;
  const pollMs = options?.pollMs ?? DEFAULT_SHELL_POLL_MS;

  return Effect.gen(function* () {
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
      const result = yield* herdrJson(["pane", "process-info", "--pane", paneId], options);
      if (shellLooksReady(result)) return;
      yield* sleepMs(pollMs);
    }
    return yield* new HerdrCommandError({
      message: `Pane "${paneId}" shell did not become ready within ${deadlineMs}ms`,
    });
  });
}

export function closePane(
  paneId: string,
  options?: HerdrCliOptions,
): Effect.Effect<void, HerdrError> {
  return herdrJson(["pane", "close", paneId], options).pipe(Effect.asVoid);
}

export interface HerdrWorktreeCreateResult {
  worktreePath: string;
  workspaceId: string;
  rootPaneId: string;
}

export function createHerdrWorktree(
  input: { repoRoot: string; branch: string; baseRef?: string },
  options?: HerdrCliOptions,
): Effect.Effect<HerdrWorktreeCreateResult, HerdrError> {
  const baseRef = input.baseRef ?? "HEAD";
  return herdrJson(
    [
      "worktree",
      "create",
      "--cwd",
      input.repoRoot,
      "--branch",
      input.branch,
      "--base",
      baseRef,
      "--no-focus",
    ],
    options,
  ).pipe(
    Effect.flatMap((result) => {
      const worktreePath = (result as { worktree?: { path?: string } }).worktree?.path;
      const workspaceId = (result as { workspace?: { workspace_id?: string } }).workspace
        ?.workspace_id;
      const rootPaneId = (result as { root_pane?: { pane_id?: string } }).root_pane?.pane_id;
      if (!worktreePath || !workspaceId || !rootPaneId) {
        return Effect.fail(
          new HerdrProtocolError({
            message: "herdr worktree create response missing worktree, workspace, or root_pane",
          }),
        );
      }
      return Effect.succeed({
        worktreePath,
        workspaceId,
        rootPaneId,
      });
    }),
  );
}

export function removeHerdrWorktree(
  workspaceId: string,
  options?: HerdrCliOptions,
): Effect.Effect<void, HerdrError> {
  return herdrJson(["worktree", "remove", "--workspace", workspaceId, "--force"], options).pipe(
    Effect.asVoid,
  );
}

export function closeHerdrWorkspace(
  workspaceId: string,
  options?: HerdrCliOptions,
): Effect.Effect<void, HerdrError> {
  return herdrJson(["workspace", "close", workspaceId], options).pipe(Effect.asVoid);
}

export function focusPane(
  paneId: string,
  options?: HerdrCliOptions,
): Effect.Effect<void, HerdrError> {
  return herdrJson(["pane", "focus", paneId], options).pipe(Effect.asVoid);
}

export function readAgent(
  alias: string,
  lines: number,
  options?: HerdrCliOptions,
): Effect.Effect<string, HerdrError> {
  return herdrText(
    ["agent", "read", alias, "--source", "recent-unwrapped", "--lines", String(lines)],
    options,
  ).pipe(Effect.map(stripAnsi));
}

export function readAgentVisible(
  alias: string,
  options?: HerdrCliOptions,
): Effect.Effect<string, HerdrError> {
  return herdrText(["agent", "read", alias, "--source", "visible"], options).pipe(
    Effect.map(stripAnsi),
  );
}
