import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { ProfileCatalog, resolveProfileModelArg } from "../lib/profile-catalog.ts";
import { REPORT_RESULT_TOOL_NAME } from "../lib/report-result-tool.ts";
import { buildChildArgs, buildChildTools } from "../lib/rpc-child.ts";

const SMOKE_TIMEOUT_MS = 15_000;

function resolvePiBinary(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const monorepoPi = path.resolve(here, "../../../node_modules/.bin/pi");
  if (fs.existsSync(monorepoPi)) return monorepoPi;
  return "pi";
}

async function probeRpcResponse(
  pi: string,
  args: string[],
  command: Record<string, unknown>,
): Promise<{ response: Record<string, unknown>; stderr: string }> {
  const child: ChildProcess = spawn(pi, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });

  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  const requestId = String(command.id ?? "smoke-request");

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("child-runtime smoke probe timed out"));
    }, SMOKE_TIMEOUT_MS);

    const rl = createInterface({ input: child.stdout! });

    rl.on("line", (line) => {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }

      if (parsed.type !== "response" || parsed.id !== requestId) return;

      clearTimeout(timer);
      child.kill();
      resolve({ response: parsed, stderr });
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.stdin?.write(`${JSON.stringify({ ...command, id: requestId })}\n`);
    child.stdin?.end();
  });
}

async function resolveSmokeModelArg(
  pi: string,
  profile: import("../lib/domain.ts").ProfileDefinition,
): Promise<string | undefined> {
  const { response } = await probeRpcResponse(
    pi,
    buildChildArgs({ profile }),
    { id: "resolve-model", type: "get_state" },
  );
  if (response.success !== true) return undefined;

  const data = response.data as { model?: Parameters<typeof resolveProfileModelArg>[1] } | undefined;
  if (!data?.model) return undefined;

  return resolveProfileModelArg(profile, data.model);
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

    const modelArg = await resolveSmokeModelArg(pi, scout);
    if (!modelArg) {
      t.skip("no resolvable default model in this environment");
      return;
    }

    const { response, stderr } = await probeRpcResponse(
      pi,
      buildChildArgs({ profile: scout, modelArg }),
      { id: "smoke-1", type: "get_session_stats" },
    );

    if (response.success !== true) {
      throw new Error(`get_session_stats failed: ${JSON.stringify(response)}`);
    }
    if (/Cannot find module|Failed to load extension/i.test(stderr)) {
      throw new Error(`child runtime failed to load: ${stderr}`);
    }
  });
});
