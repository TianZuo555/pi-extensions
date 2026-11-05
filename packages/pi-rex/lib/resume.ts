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
// when the user quits pi.

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

/** Folder below the pi agent directory that holds one record per Rex pane. */
export const RESUME_DIR = "rex-resume";

const SIGNALS = ["SIGHUP", "SIGTERM"] as const;

/** Record file for a Rex block, such as `block:01a1...`. */
export function recordPath(agentDir: string, block: string): string {
  return path.join(agentDir, RESUME_DIR, path.basename(block.replace(/^block:/, "")));
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
  // after each prompt.
  const save = (ctx: ExtensionContext): void => {
    if (!record) return;
    const session = ctx.sessionManager.getSessionFile();
    if (!session || !existsSync(session)) return;
    mkdirSync(path.dirname(record), { recursive: true });
    writeFileSync(record, recordText(ctx.cwd, session));
  };

  pi.on("session_start", (_event, ctx) => {
    const block = process.env.REX_BLOCK;
    // Print and RPC runs inherit REX_BLOCK from the agent's shell, but they are
    // not the agent of the pane.
    record = block && ctx.hasUI ? recordPath(agentDir, block) : undefined;
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
    if (event.reason === "quit" && !signaled) rmSync(record, { force: true });
  });
}
