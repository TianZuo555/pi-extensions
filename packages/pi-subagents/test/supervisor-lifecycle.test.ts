import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { SubagentSupervisor } from "../lib/supervisor.ts";

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "fake-rpc-child.mjs",
);

const fakeModel = { provider: "openai", id: "gpt-4.1-mini" } as import("@earendil-works/pi-ai").Model<
  import("@earendil-works/pi-ai").Api
>;

function isolatedAgentDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-lifecycle-"));
  fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
  return dir;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("SubagentSupervisor lifecycle", () => {
  it("defers background completion exactly once", async () => {
    const agentDir = isolatedAgentDir();
    const sv = new SubagentSupervisor(process.cwd(), agentDir);
    const settle = { command: process.execPath, args: [FIXTURE, "--mode=settle"] };

    const started = await sv.run({
      profile: "scout",
      task: "bg task",
      cwd: process.cwd(),
      parentModel: fakeModel,
      mode: "background",
      spawnOverride: settle,
    });
    assert.equal(started.status, "running");

    await sleep(300);
    const first = sv.drainPendingResults();
    assert.equal(first.length, 1);
    assert.equal(first[0].status, "completed");
    assert.equal(sv.drainPendingResults().length, 0);

    sv.dispose();
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it("cancel preserves reason and terminal status", async () => {
    const agentDir = isolatedAgentDir();
    const sv = new SubagentSupervisor(process.cwd(), agentDir);
    const hang = { command: process.execPath, args: [FIXTURE, "--mode=hang"] };

    const started = await sv.run({
      profile: "scout",
      task: "cancel me",
      cwd: process.cwd(),
      parentModel: fakeModel,
      mode: "background",
      spawnOverride: hang,
    });

    assert.ok(sv.cancelRun(started.runId, "user stopped"));
    await sleep(800);

    const record = sv.getRun(started.runId);
    assert.ok(record);
    assert.equal(record!.status, "cancelled");
    assert.match(record!.result?.error ?? "", /user stopped/);

    sv.dispose();
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it("completes failed record when worktree cannot be created", async () => {
    const agentDir = isolatedAgentDir();
    const sv = new SubagentSupervisor(os.tmpdir(), agentDir);

    const result = await sv.run({
      profile: "worker",
      task: "no git here",
      cwd: os.tmpdir(),
      parentModel: fakeModel,
    });

    assert.equal(result.status, "failed");
    assert.equal(sv.listRuns().filter((r) => r.status === "running").length, 0);

    sv.dispose();
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it("times out hung foreground runs", async () => {
    const agentDir = isolatedAgentDir();
    const sv = new SubagentSupervisor(process.cwd(), agentDir);
    const result = await sv.run({
      profile: "scout",
      task: "timeout",
      cwd: process.cwd(),
      parentModel: fakeModel,
      timeoutMs: 400,
      spawnOverride: { command: process.execPath, args: [FIXTURE, "--mode=hang"] },
    });
    assert.equal(result.status, "timed_out");
    sv.dispose();
    fs.rmSync(agentDir, { recursive: true, force: true });
  });
});
