/**
 * RpcChild — one supervised `pi --mode rpc` child process.
 *
 * Isolation: `--no-extensions` prevents extension MCP and other parent extensions in children.
 * The trusted child runtime is loaded explicitly via `-e`.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionStats } from "@earendil-works/pi-coding-agent";
import { REPORT_RESULT_TOOL_NAME } from "./report-result-tool.ts";
import { attachJsonlReader } from "./jsonl-reader.ts";
import { getPiInvocation } from "./pi-spawn.ts";
import type { DetachedChildTracker } from "./process-tracker.ts";
import type { ProfileDefinition } from "./domain.ts";
import {
  buildSemanticReport,
  parseRunReportDetails,
  renderRunReport,
  type ChildSemanticReport,
} from "./run-report.ts";
import { usageFromSessionStats } from "./usage.ts";

const STOP_TIMEOUT_MS = 5_000;
const FORCE_KILL_AFTER_MS = 2_000;
const SETTLED_GRACE_MS = 500;
const STDERR_MAX_BYTES = 64 * 1024;

const CHILD_RUNTIME_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "child-runtime.ts",
);

export interface RpcChildRunInput {
  cwd: string;
  profile: ProfileDefinition;
  modelArg?: string;
  prompt: string;
  timeoutMs: number;
  signal?: AbortSignal;
  tracker: DetachedChildTracker;
  onActivity?: (activity: string) => void;
  /** Test hook: replace pi spawn with a fake RPC speaker */
  spawnOverride?: { command: string; args: string[] };
  /** Test hook: skip loading the child runtime extension */
  skipChildRuntime?: boolean;
}

export interface RpcChildRunOutput {
  settled: boolean;
  reportText: string;
  semanticReport: ChildSemanticReport;
  usage: ReturnType<typeof usageFromSessionStats>;
  stderr: string;
  exitCode: number | null;
  error?: string;
  budgetExhausted?: boolean;
  terminalReportReceived?: boolean;
}

type RpcLine = Record<string, unknown>;

function isResponse(line: RpcLine): boolean {
  return line.type === "response";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writePromptToTempFile(
  profileName: string,
  prompt: string,
): Promise<{ dir: string; filePath: string }> {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-tian-subagent-"));
  const safeName = profileName.replace(/[^\w.-]+/g, "_");
  const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
  await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
  return { dir: tmpDir, filePath };
}

function buildChildTools(profile: ProfileDefinition): string[] {
  const tools = [...profile.tools];
  if (!tools.includes(REPORT_RESULT_TOOL_NAME)) {
    tools.push(REPORT_RESULT_TOOL_NAME);
  }
  return tools;
}

export { buildChildTools };

export interface BuildChildArgsInput {
  profile: ProfileDefinition;
  modelArg?: string;
  skipChildRuntime?: boolean;
}

export function buildChildArgs(input: BuildChildArgsInput): string[] {
  const args: string[] = [
    "--mode",
    "rpc",
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--tools",
    buildChildTools(input.profile).join(","),
  ];

  if (input.modelArg !== undefined) {
    args.push("--model", input.modelArg);
  }

  if (!input.skipChildRuntime) {
    args.push("-e", CHILD_RUNTIME_PATH);
  }

  return args;
}

function formatTurnBudgetWarning(maxTurns: number): string {
  return (
    `Subagent turn budget: you are on turn ${maxTurns} of ${maxTurns}. ` +
    "Call report_result now to finish with a structured handoff."
  );
}

export async function runRpcChild(input: RpcChildRunInput): Promise<RpcChildRunOutput> {
  const stderrChunks: Buffer[] = [];
  let stderrBytes = 0;

  const pushStderr = (chunk: Buffer) => {
    if (stderrBytes >= STDERR_MAX_BYTES) return;
    const slice = chunk.subarray(0, STDERR_MAX_BYTES - stderrBytes);
    stderrChunks.push(slice);
    stderrBytes += slice.length;
  };

  let tmpSystemDir: string | null = null;

  const args = buildChildArgs({
    profile: input.profile,
    modelArg: input.modelArg,
    skipChildRuntime: input.skipChildRuntime,
  });

  if (input.profile.systemPrompt.trim()) {
    const tmp = await writePromptToTempFile(
      `${input.profile.name}-system`,
      input.profile.systemPrompt,
    );
    tmpSystemDir = tmp.dir;
    args.push("--append-system-prompt", tmp.filePath);
  }

  const invocation = input.spawnOverride ?? getPiInvocation(args);
  const child: ChildProcess = spawn(invocation.command, invocation.args, {
    cwd: input.cwd,
    shell: false,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });

  const childPid = child.pid;
  if (childPid) input.tracker.track(childPid);

  let settled = false;
  let reportText = "";
  let exitCode: number | null = null;
  let runError: string | undefined;
  let aborted = false;
  let childExited = false;
  let budgetExhausted = false;
  let terminalReportReceived = false;
  let capturedReportDetails: unknown;
  let turnCount = 0;
  let budgetWarningSent = false;
  const maxTurns = input.profile.maxTurns;

  const pendingCommands = new Map<string, {
    resolve: (line: RpcLine) => void;
    reject: (error: Error) => void;
  }>();

  const rejectAllPending = (reason: string) => {
    for (const pending of pendingCommands.values()) {
      pending.reject(new Error(reason));
    }
    pendingCommands.clear();
  };

  const sendCommand = (cmd: RpcLine): Promise<RpcLine> => {
    if (childExited) {
      return Promise.reject(new Error("RpcChild exited"));
    }
    const id = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const payload = { ...cmd, id };
    return new Promise((resolve, reject) => {
      pendingCommands.set(id, { resolve, reject });
      try {
        child.stdin?.write(`${JSON.stringify(payload)}\n`);
      } catch (error) {
        pendingCommands.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  };

  const onAbort = () => {
    aborted = true;
    void sendCommand({ type: "abort" }).catch(() => {});
  };

  if (input.signal) {
    if (input.signal.aborted) onAbort();
    else input.signal.addEventListener("abort", onAbort, { once: true });
  }

  if (child.stdin) {
    child.stdin.on("error", () => {
      rejectAllPending("RpcChild stdin error");
    });
  }

  attachJsonlReader(child.stdout!, (line) => {
    let parsed: RpcLine;
    try {
      parsed = JSON.parse(line) as RpcLine;
    } catch {
      return;
    }

    if (isResponse(parsed) && typeof parsed.id === "string") {
      const pending = pendingCommands.get(parsed.id);
      if (pending) {
        pendingCommands.delete(parsed.id);
        pending.resolve(parsed);
      }
      return;
    }

    const type = parsed.type;
    if (type === "turn_start") {
      turnCount++;
      if (!terminalReportReceived && !settled) {
        if (turnCount === maxTurns && !budgetWarningSent) {
          budgetWarningSent = true;
          void sendCommand({
            type: "steer",
            message: formatTurnBudgetWarning(maxTurns),
          }).catch(() => {});
        }
        // Pi delivers steer before the *next* LLM call (rpc.md), so the warned child
        // needs one grace turn after maxTurns before hard abort.
        const abortAfter = budgetWarningSent ? maxTurns + 1 : maxTurns;
        if (turnCount > abortAfter) {
          budgetExhausted = true;
          onAbort();
        }
      }
    } else if (type === "tool_execution_start") {
      const toolName = String(parsed.toolName ?? "tool");
      input.onActivity?.(toolName);
    } else if (type === "tool_execution_end") {
      const toolName = String(parsed.toolName ?? "");
      if (toolName === REPORT_RESULT_TOOL_NAME && parsed.isError !== true) {
        const result = parsed.result as { details?: unknown } | undefined;
        const details = result?.details;
        if (parseRunReportDetails(details)) {
          capturedReportDetails = details;
          terminalReportReceived = true;
        }
      }
    } else if (type === "message_update") {
      const event = parsed.assistantMessageEvent as { type?: string } | undefined;
      if (event?.type === "text_delta") input.onActivity?.("responding");
    } else if (type === "agent_settled") {
      settled = true;
    }
  });

  child.stderr?.on("data", pushStderr);

  child.on("error", () => {
    childExited = true;
    rejectAllPending("RpcChild process error");
  });
  child.on("exit", () => {
    childExited = true;
    rejectAllPending("RpcChild exited");
  });

  const waitForExit = new Promise<number | null>((resolve) => {
    child.on("close", (code) => {
      childExited = true;
      resolve(code);
    });
    child.on("error", () => {
      childExited = true;
      resolve(1);
    });
  });

  const timeoutAt = Date.now() + input.timeoutMs;
  let timedOut = false;

  try {
    if (!child.stdin) throw new Error("Child stdin is not available");

    const promptResponse = await sendCommand({
      type: "prompt",
      message: input.prompt,
    });

    if (promptResponse.success !== true) {
      runError = String(promptResponse.error ?? "prompt rejected");
    } else {
      while (!settled && !aborted && !childExited) {
        if (Date.now() > timeoutAt) {
          timedOut = true;
          onAbort();
          break;
        }
        const raced = await Promise.race([
          sleep(50).then(() => "tick" as const),
          waitForExit.then((code) => ({ kind: "exit" as const, code })),
        ]);
        if (raced !== "tick") {
          childExited = true;
          exitCode = raced.code;
          break;
        }
      }
    }

    if (!settled && !timedOut && !aborted && !childExited) {
      await sleep(SETTLED_GRACE_MS);
    }

    let usage = usageFromSessionStats({});

    if (!childExited) {
      if (!terminalReportReceived) {
        try {
          const textResponse = await sendCommand({ type: "get_last_assistant_text" });
          if (textResponse.success === true) {
            const data = textResponse.data as { text?: string | null } | undefined;
            if (data?.text) reportText = data.text;
          }
        } catch {
          // Best-effort before teardown.
        }
      }

      try {
        const statsResponse = await sendCommand({ type: "get_session_stats" });
        if (statsResponse.success === true) {
          const stats = statsResponse.data as SessionStats;
          usage = usageFromSessionStats(stats);
        }
      } catch {
        // Best-effort.
      }
    }

    if (!childExited) {
      try {
        child.stdin.end();
      } catch {
        // Already closed.
      }

      const exitWait = Promise.race([
        waitForExit,
        sleep(STOP_TIMEOUT_MS).then(() => null),
      ]);

      exitCode = await exitWait;

      if (exitCode === null && childPid) {
        try {
          if (process.platform === "win32") {
            child.kill();
          } else {
            process.kill(-childPid, "SIGTERM");
          }
        } catch {
          try {
            child.kill("SIGTERM");
          } catch {
            // ignore
          }
        }
        exitCode = await Promise.race([
          waitForExit,
          sleep(FORCE_KILL_AFTER_MS).then(() => null),
        ]);
        if (exitCode === null && childPid) {
          try {
            if (process.platform === "win32") {
              child.kill("SIGKILL");
            } else {
              process.kill(-childPid, "SIGKILL");
            }
          } catch {
            try {
              child.kill("SIGKILL");
            } catch {
              // ignore
            }
          }
          exitCode = await waitForExit;
        }
      }
    } else if (exitCode === null) {
      exitCode = await waitForExit;
    }

    if (budgetExhausted && !terminalReportReceived) {
      runError =
        runError ??
        `subagent turn budget exhausted (${maxTurns} turns; provider retries/compaction may not map one-to-one to turn_start)`;
    } else if (timedOut) runError = runError ?? "subagent timed out";
    else if (aborted) runError = runError ?? "subagent cancelled";
    else if (childExited && !settled) {
      const stderrText = Buffer.concat(stderrChunks).toString("utf8").trim();
      runError =
        runError ??
        (stderrText.slice(0, 500) || `child exited (code ${exitCode ?? "?"}) before agent_settled`);
    } else if (!settled) runError = runError ?? "child did not emit agent_settled";

    const semanticReport = terminalReportReceived
      ? buildSemanticReport(capturedReportDetails, reportText, "structured report_result captured")
      : buildSemanticReport(
          undefined,
          reportText,
          budgetExhausted
            ? "turn budget exhausted before report_result"
            : "no valid report_result; fell back to assistant text",
        );

    const renderedReport =
      semanticReport.kind === "structured"
        ? renderRunReport(semanticReport.report)
        : semanticReport.text;

    return {
      settled,
      reportText: renderedReport,
      semanticReport,
      usage,
      stderr: Buffer.concat(stderrChunks).toString("utf8"),
      exitCode,
      error: runError,
      budgetExhausted,
      terminalReportReceived,
    };
  } finally {
    if (childPid) input.tracker.untrack(childPid);
    if (!child.killed && childPid) {
      try {
        if (process.platform === "win32") child.kill("SIGKILL");
        else process.kill(-childPid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          // Already exited.
        }
      }
    }
    if (tmpSystemDir) await fs.promises.rm(tmpSystemDir, { recursive: true, force: true });
    if (input.signal) input.signal.removeEventListener("abort", onAbort);
    for (const pending of pendingCommands.values()) {
      pending.reject(new Error("RpcChild closed"));
    }
    pendingCommands.clear();
  }
}

export { CHILD_RUNTIME_PATH };
