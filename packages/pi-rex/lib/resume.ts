// Resume pi in its Rex pane after a Rex restart.
//
// Rex restores sessions, tabs, panes, and scrollback after a restart. Each
// pane keeps its block ID, but Rex starts a new shell in it, not the program
// that ran there. This module records the pi session of the pane in
// `<agent dir>/rex-resume/<block id>`. A shell hook (see the README) reads the
// record when a new shell starts in the pane and runs the command.
//
// The record is the working directory on line 1, then the command, one
// argument per line. It stays when pi stops because of SIGHUP or SIGTERM, or
// because the terminal is gone, which is what a Rex restart does. It is removed
// when the user quits pi, and when `/new` replaces the session.

import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

/** Folder below the pi agent directory that holds one record per Rex pane. */
export const RESUME_DIR = "rex-resume";

const SIGNALS = ["SIGHUP", "SIGTERM"] as const;
/** A block ID becomes a file name, so accept a plain ID and not a path. */
const BLOCK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Record file for a Rex block, such as `block:01a1...`. Undefined for a malformed ID. */
export function recordPath(agentDir: string, block: string): string | undefined {
  const id = block.replace(/^block:/, "");
  if (!BLOCK_ID.test(id)) return undefined;
  return path.join(agentDir, RESUME_DIR, id);
}

/** Record text: the working directory, then the resume command, one argument per line. */
export function recordText(cwd: string, sessionFile: string): string {
  return `${[cwd, "pi", "--session", sessionFile].join("\n")}\n`;
}

export function registerResume(pi: ExtensionAPI, agentDir: string = getAgentDir()): void {
  let record: string | undefined;
  let signaled = false;
  const onSignal = (): void => {
    signaled = true;
  };

  // Pi writes the session file only after the first message, so save again
  // after each prompt. Until then, remove the record: after `/new` it still
  // names the previous session, which the hook must not reopen.
  const save = (ctx: ExtensionContext): void => {
    if (!record) return;
    const session = ctx.sessionManager.getSessionFile();
    // The hook runs the last lines as one command. A line break in a path
    // would move the arguments, so write no record for such a path.
    if (!session || !existsSync(session) || /[\r\n]/.test(ctx.cwd) || /[\r\n]/.test(session)) {
      rmSync(record, { force: true });
      return;
    }
    mkdirSync(path.dirname(record), { recursive: true });
    // Write and rename, so a stop during the write cannot leave half a record.
    const temp = `${record}.tmp`;
    writeFileSync(temp, recordText(ctx.cwd, session));
    renameSync(temp, record);
  };

  pi.on("session_start", (_event, ctx) => {
    const block = process.env.REX_BLOCK;
    // Print, JSON, and RPC runs inherit REX_BLOCK from the agent's shell, but
    // they are not the agent of the pane. `hasUI` is also true in RPC mode.
    record = block && ctx.mode === "tui" ? recordPath(agentDir, block) : undefined;
    if (!record) return;
    signaled = false;
    for (const signal of SIGNALS) process.on(signal, onSignal);
    save(ctx);
  });

  pi.on("agent_end", (_event, ctx) => save(ctx));

  pi.on("session_shutdown", async (event) => {
    if (!record) return;
    // Pi's own signal handler runs first and starts the shutdown. Wait one tick
    // so onSignal, a later listener for the same signal, can set the flag.
    await new Promise((resolve) => setImmediate(resolve));
    for (const signal of SIGNALS) process.off(signal, onSignal);
    // `/new` replaces the session, so the record must not reopen the old one.
    if (event.reason === "new" || (event.reason === "quit" && !signaled))
      rmSync(record, { force: true });
  });
}
