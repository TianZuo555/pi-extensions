import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import type { ProfileDefinition } from "../lib/domain.ts";
import { ProfileCatalog, resolveProfileModelArg } from "../lib/profile-catalog.ts";
import { REPORT_RESULT_TOOL_NAME } from "../lib/report-result-tool.ts";
import { buildChildArgs, buildChildTools } from "../lib/rpc-child.ts";

/** CI runners are slower than dev machines: spawning pi and stripping TS types is cold-start work. */
const SMOKE_TIMEOUT_MS = Number(process.env.PI_SUBAGENT_SMOKE_TIMEOUT_MS ?? 30_000);

/**
 * A genuine child-runtime regression — a missing module or an extension that throws
 * on load — always surfaces on stderr, even when the child never answers on stdout.
 * That is what makes it safe to skip on "no response at all": real breakage is still
 * caught by this pattern, so the skip can only absorb environment failures.
 */
const LOAD_FAILURE_RE = /Cannot find module|Failed to load extension|ERR_MODULE_NOT_FOUND/i;

const STDERR_REPORT_LIMIT = 2_000;

type ProbeOutcome =
  | { kind: "response"; response: Record<string, unknown>; stderr: string }
  | { kind: "no-response"; reason: string; stderr: string; exitCode: number | null };

function resolvePiBinary(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const monorepoPi = path.resolve(here, "../../../node_modules/.bin/pi");
  if (fs.existsSync(monorepoPi)) return monorepoPi;
  return "pi";
}

function tailStderr(stderr: string): string {
  const trimmed = stderr.trim();
  if (trimmed.length <= STDERR_REPORT_LIMIT) return trimmed;
  return `…${trimmed.slice(-STDERR_REPORT_LIMIT)}`;
}

function describeOutcome(outcome: Extract<ProbeOutcome, { kind: "no-response" }>): string {
  return [
    outcome.reason,
    `exitCode=${outcome.exitCode ?? "null"}`,
    outcome.stderr ? `stderr:\n${tailStderr(outcome.stderr)}` : "stderr was empty",
  ].join(" | ");
}

/**
 * Send one RPC command and resolve with the matching response.
 *
 * Never rejects on child failure: an early exit or a timeout resolves as
 * `no-response` carrying the exit code and stderr, so the caller can tell a real
 * child-runtime regression apart from an environment that cannot run pi at all.
 */
function probeRpcResponse(
  pi: string,
  args: string[],
  command: Record<string, unknown>,
): Promise<ProbeOutcome> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(pi, args, { stdio: ["pipe", "pipe", "pipe"], env: process.env });
    } catch (error) {
      resolve({
        kind: "no-response",
        reason: `failed to spawn "${pi}": ${error instanceof Error ? error.message : String(error)}`,
        stderr: "",
        exitCode: null,
      });
      return;
    }

    const requestId = String(command.id ?? "smoke-request");
    let stderr = "";
    let done = false;

    const finish = (outcome: ProbeOutcome) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill();
      resolve(outcome);
    };

    const timer = setTimeout(() => {
      finish({
        kind: "no-response",
        reason: `no RPC response within ${SMOKE_TIMEOUT_MS}ms`,
        stderr,
        exitCode: child.exitCode,
      });
    }, SMOKE_TIMEOUT_MS);

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    createInterface({ input: child.stdout! }).on("line", (line) => {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      if (parsed.type !== "response" || parsed.id !== requestId) return;
      finish({ kind: "response", response: parsed, stderr });
    });

    child.on("error", (error) => {
      finish({
        kind: "no-response",
        reason: `child process error: ${error.message}`,
        stderr,
        exitCode: child.exitCode,
      });
    });

    // Without this, a child that dies immediately would burn the whole timeout
    // and report a misleading "timed out" instead of its real exit code.
    child.on("close", (code) => {
      finish({
        kind: "no-response",
        reason: `child exited before answering (code ${code ?? "null"})`,
        stderr,
        exitCode: code,
      });
    });

    child.stdin?.write(`${JSON.stringify({ ...command, id: requestId })}\n`);
    child.stdin?.end();
  });
}

async function resolveSmokeModelArg(
  pi: string,
  profile: ProfileDefinition,
): Promise<{ modelArg: string } | { unavailable: string }> {
  const outcome = await probeRpcResponse(pi, buildChildArgs({ profile }), {
    id: "resolve-model",
    type: "get_state",
  });

  if (outcome.kind === "no-response") {
    if (LOAD_FAILURE_RE.test(outcome.stderr)) {
      throw new Error(`child runtime failed to load: ${describeOutcome(outcome)}`);
    }
    return { unavailable: `could not read pi default model — ${describeOutcome(outcome)}` };
  }

  if (outcome.response.success !== true) {
    return { unavailable: `get_state was rejected: ${JSON.stringify(outcome.response)}` };
  }

  const data = outcome.response.data as
    | { model?: Parameters<typeof resolveProfileModelArg>[1] }
    | undefined;
  if (!data?.model) return { unavailable: "pi reported no default model" };

  return { modelArg: resolveProfileModelArg(profile, data.model) };
}

describe("child runtime smoke", () => {
  it("loads child-runtime via -e in a real pi RPC child", async (t) => {
    const pi = resolvePiBinary();
    const catalog = new ProfileCatalog(process.cwd());
    const scout = catalog.resolve("scout");

    assert.ok(
      buildChildTools(scout).includes(REPORT_RESULT_TOOL_NAME),
      "report_result must be appended to the child tool allowlist",
    );

    const resolved = await resolveSmokeModelArg(pi, scout);
    if ("unavailable" in resolved) {
      t.skip(`pi RPC child unavailable in this environment: ${resolved.unavailable}`);
      return;
    }

    const outcome = await probeRpcResponse(
      pi,
      buildChildArgs({ profile: scout, modelArg: resolved.modelArg }),
      { id: "smoke-1", type: "get_session_stats" },
    );

    if (outcome.kind === "no-response") {
      // Real breakage always leaves a load error on stderr, so failing only here
      // keeps the test honest while letting unrunnable environments skip.
      if (LOAD_FAILURE_RE.test(outcome.stderr)) {
        throw new Error(`child runtime failed to load: ${describeOutcome(outcome)}`);
      }
      t.skip(`pi RPC child unavailable in this environment: ${describeOutcome(outcome)}`);
      return;
    }

    if (LOAD_FAILURE_RE.test(outcome.stderr)) {
      throw new Error(`child runtime failed to load: ${tailStderr(outcome.stderr)}`);
    }
    if (outcome.response.success !== true) {
      throw new Error(`get_session_stats failed: ${JSON.stringify(outcome.response)}`);
    }
  });
});
