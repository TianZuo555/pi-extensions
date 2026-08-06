#!/usr/bin/env node
/**
 * Fake herdr CLI for unit tests — never invokes the real binary.
 */

import * as fs from "node:fs";
import { execFileSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";

const args = process.argv.slice(2);

const touchedFile = process.env.FAKE_HERDR_TOUCHED;
if (touchedFile) {
  fs.writeFileSync(touchedFile, "1");
}

function sleepSync(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // spin — test fixture only
  }
}

function writeStdout(text) {
  process.stdout.write(text);
}

function exitJson(body, code = 0) {
  writeStdout(JSON.stringify(body));
  process.exit(code);
}

function envelope(result) {
  return { id: `cli:${args.join(":")}`, result };
}

function apiError(code, message, exitCode = 1) {
  exitJson({ error: { code, message }, id: `cli:${args[0] ?? "herdr"}` }, exitCode);
}

function readPromptCounter() {
  const file = process.env.FAKE_HERDR_PROMPT_COUNTER_FILE;
  if (!file) return 0;
  try {
    return Number(fs.readFileSync(file, "utf8").trim());
  } catch {
    return 0;
  }
}

function writePromptCounter(count) {
  const file = process.env.FAKE_HERDR_PROMPT_COUNTER_FILE;
  if (file) fs.writeFileSync(file, String(count));
}

function writeConfiguredReport() {
  const reportPath = process.env.FAKE_HERDR_REPORT_PATH;
  const mode = process.env.FAKE_HERDR_REPORT_MODE ?? "valid";
  if (!reportPath || mode === "missing") return;

  const dir = reportPath.slice(0, reportPath.lastIndexOf("/"));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  if (mode === "valid") {
    fs.writeFileSync(
      reportPath,
      JSON.stringify({ status: "completed", summary: "fake herdr structured report" }),
      { mode: 0o600 },
    );
  } else if (mode === "invalid") {
    fs.writeFileSync(reportPath, "{not-json", { mode: 0o600 });
  } else if (mode === "oversized") {
    fs.writeFileSync(reportPath, "x".repeat(300_000), { mode: 0o600 });
  }
}

if (process.env.FAKE_HERDR_API_ERROR) {
  apiError(process.env.FAKE_HERDR_API_ERROR, "fake api error");
}

if (process.env.FAKE_HERDR_PLAIN_ERROR) {
  writeStdout(process.env.FAKE_HERDR_PLAIN_ERROR);
  process.exit(1);
}

const [cmd, sub, ...rest] = args;

if (cmd === "pane" && sub === "layout" && rest[0] === "--current") {
  const width = Number(process.env.FAKE_HERDR_WIDTH ?? "200");
  exitJson(
    envelope({
      layout: {
        area: { width, height: 40, x: 0, y: 0 },
        focused_pane_id: "pane-root",
        panes: [{ pane_id: "pane-root" }],
        splits: [],
        tab_id: "tab-1",
        workspace_id: "ws-1",
        zoomed: false,
      },
    }),
  );
}

if (cmd === "pane" && sub === "split") {
  exitJson(envelope({ pane: { pane_id: "pane-split-1" } }));
}

if (cmd === "pane" && sub === "get") {
  const paneId = rest[0];
  exitJson(
    envelope({
      pane: {
        pane_id: paneId,
        agent_status: "unknown",
        cwd: process.cwd(),
        focused: false,
        terminal_title: "shell",
        workspace_id: "ws-1",
      },
    }),
  );
}

if (cmd === "pane" && sub === "process-info" && rest[0] === "--pane") {
  const shape = process.env.FAKE_HERDR_PROCESS_INFO_SHAPE;
  if (shape === "missing") {
    exitJson(envelope({}));
  }
  if (shape === "malformed") {
    exitJson(envelope({ process_info: { shell_pid: "not-a-number" } }));
  }

  const shellPid = 91454;
  let busyRemaining = 0;
  const busyFile = process.env.FAKE_HERDR_BUSY_FILE;
  if (busyFile) {
    try {
      busyRemaining = Number(fs.readFileSync(busyFile, "utf8").trim());
      if (!Number.isFinite(busyRemaining) || busyRemaining < 0) busyRemaining = 0;
    } catch {
      busyRemaining = 0;
    }
  }

  let fgPgid = shellPid;
  if (busyRemaining > 0) {
    fgPgid = shellPid + 1;
    fs.writeFileSync(busyFile, String(busyRemaining - 1));
  } else if (process.env.FAKE_HERDR_PROCESS_STATE === "busy") {
    fgPgid = shellPid + 1;
  }

  exitJson(
    envelope({
      process_info: {
        shell_pid: shellPid,
        foreground_process_group_id: fgPgid,
        foreground_processes:
          fgPgid === shellPid ? [{ name: "fish" }] : [{ name: "sleep" }],
      },
    }),
  );
}

if (cmd === "pane" && sub === "close") {
  if (process.env.FAKE_HERDR_CLOSE_LOG) {
    fs.appendFileSync(process.env.FAKE_HERDR_CLOSE_LOG, `${rest[0]}\n`);
  }
  exitJson(envelope({ closed: true }));
}

if (cmd === "pane" && sub === "focus") {
  exitJson(envelope({ pane: { pane_id: rest[0], focused: true } }));
}

if (cmd === "workspace" && sub === "close") {
  if (process.env.FAKE_HERDR_RECORD_WORKSPACE_CLOSE) {
    fs.appendFileSync(process.env.FAKE_HERDR_RECORD_WORKSPACE_CLOSE, `${rest[0]}\n`);
  }
  exitJson(envelope({ closed: true }));
}

if (cmd === "pane" && sub === "read") {
  writeStdout("\u001b[31m\u250c pane \u001b[0mraw pane text\n");
  process.exit(0);
}

if (cmd === "agent" && sub === "read") {
  const sourceIndex = rest.indexOf("--source");
  const source = sourceIndex >= 0 ? rest[sourceIndex + 1] : "";
  if (source === "visible") {
    writeStdout(process.env.FAKE_HERDR_VISIBLE_TEXT ?? "staged prompt snippet visible\n");
  } else {
    writeStdout(
      process.env.FAKE_HERDR_TRANSCRIPT ??
        "\u001b[31m\u250c box \u001b[0mraw agent text\n",
    );
  }
  process.exit(0);
}

if (cmd === "agent" && sub === "start") {
  if (process.env.FAKE_HERDR_RECORD_ARGS) {
    fs.writeFileSync(process.env.FAKE_HERDR_RECORD_ARGS, JSON.stringify(args));
  }
  if (process.env.FAKE_HERDR_START_ERROR) {
    apiError(process.env.FAKE_HERDR_START_ERROR, "fake start error");
  }
  exitJson(envelope({ agent: { alias: rest[0] } }));
}

if (cmd === "agent" && sub === "get") {
  exitJson(
    envelope({
      agent: {
        alias: rest[0],
        agent_status: process.env.FAKE_HERDR_GET_STATUS ?? "idle",
      },
    }),
  );
}

if (cmd === "agent" && sub === "wait") {
  exitJson(
    envelope({
      agent: {
        alias: rest[0],
        agent_status: process.env.FAKE_HERDR_WAIT_STATUS ?? "working",
      },
    }),
  );
}

if (cmd === "agent" && sub === "send-keys") {
  if (process.env.FAKE_HERDR_RECORD_SEND_KEYS) {
    fs.appendFileSync(process.env.FAKE_HERDR_RECORD_SEND_KEYS, `${rest[1]}\n`);
  }
  exitJson(envelope({ sent: rest[1] }));
}

if (cmd === "agent" && sub === "prompt") {
  const promptSleepMs = Number(process.env.FAKE_HERDR_PROMPT_SLEEP_MS ?? "0");
  if (promptSleepMs > 0) {
    sleepSync(promptSleepMs);
  }

  const failCount = Number(process.env.FAKE_HERDR_PROMPT_FAIL_COUNT ?? "0");
  const counter = readPromptCounter();
  if (counter < failCount) {
    writePromptCounter(counter + 1);
    apiError("agent_prompt_stalled", "agent prompt stalled");
  }

  if (process.env.FAKE_HERDR_PROMPT_ERROR) {
    apiError(process.env.FAKE_HERDR_PROMPT_ERROR, "fake prompt error");
  }

  writeConfiguredReport();
  exitJson(
    envelope({
      agent: {
        alias: rest[0],
        agent_status: process.env.FAKE_HERDR_AGENT_STATUS ?? "done",
      },
    }),
  );
}

if (cmd === "worktree" && sub === "create") {
  const cwdIdx = rest.indexOf("--cwd");
  const repoRoot = cwdIdx >= 0 ? rest[cwdIdx + 1] : "";
  const branchIdx = rest.indexOf("--branch");
  const branch = branchIdx >= 0 ? rest[branchIdx + 1] : "pi-subagent-test";
  const worktreePath = path.join(os.tmpdir(), `fake-herdr-wt-${process.pid}-${Date.now()}`);
  execFileSync("git", ["worktree", "add", "-B", branch, worktreePath, "HEAD"], {
    cwd: repoRoot,
    stdio: "pipe",
    env: process.env,
  });
  exitJson(
    envelope({
      worktree: { path: worktreePath },
      workspace: { workspace_id: process.env.FAKE_HERDR_WORKSPACE_ID ?? "ws-wt-1" },
      root_pane: { pane_id: process.env.FAKE_HERDR_ROOT_PANE_ID ?? "pane-wt-root" },
    }),
  );
}

if (cmd === "worktree" && sub === "remove") {
  if (process.env.FAKE_HERDR_RECORD_REMOVE) {
    fs.appendFileSync(process.env.FAKE_HERDR_RECORD_REMOVE, `${JSON.stringify(args)}\n`);
  }
  exitJson(envelope({ removed: true }));
}

writeStdout(`unknown fake herdr command: ${args.join(" ")}`);
process.exit(1);
