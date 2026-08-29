import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { createDeferredResultDelivery } from "../lib/result-delivery.ts";
import { SubagentSupervisor } from "../lib/supervisor.ts";
import { hermeticGitProcessEnv } from "./git-env.ts";

hermeticGitProcessEnv();

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "fake-rpc-child.mjs",
);

const fakeModel = {
  provider: "openai",
  id: "gpt-4.1-mini",
} as import("@earendil-works/pi-ai").Model<import("@earendil-works/pi-ai").Api>;

function isolatedAgentDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-lifecycle-"));
  fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
  return dir;
}

function initGitRepo(dir: string): void {
  execFileSync("git", ["init"], { cwd: dir, stdio: "pipe" });
  // Windows CI runners default to core.autocrlf=true; keep fixtures byte-exact.
  execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "pi-subagents test"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "pi-subagents-test@example.invalid"], {
    cwd: dir,
    stdio: "pipe",
  });
  fs.writeFileSync(path.join(dir, "README.md"), "init\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "pipe" });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000, intervalMs = 25): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start >= timeoutMs) {
      throw new Error(`Timed out waiting for condition after ${timeoutMs}ms`);
    }
    await sleep(intervalMs);
  }
}

describe("createDeferredResultDelivery", () => {
  it("delivers at most once across immediate and drain paths", () => {
    const delivery = createDeferredResultDelivery<{ runId: string; value: number }>();
    const result = { runId: "sa-1", value: 42 };
    let sendCount = 0;

    delivery.defer(result);

    const firstClaim = delivery.claim("sa-1");
    assert.ok(firstClaim);
    sendCount++;
    delivery.confirm("sa-1");

    delivery.defer(result);
    assert.equal(delivery.claim("sa-1"), undefined);
    assert.equal(delivery.pendingRunIds().length, 0);
    assert.equal(sendCount, 1);

    delivery.defer({ runId: "sa-2", value: 7 });
    assert.deepEqual(delivery.pendingRunIds(), ["sa-2"]);
    const secondClaim = delivery.claim("sa-2");
    assert.ok(secondClaim);
    assert.equal(secondClaim.runId, "sa-2");
    assert.equal(delivery.claim("sa-2"), undefined);
  });

  it("restores only when send fails", () => {
    const delivery = createDeferredResultDelivery<{ runId: string }>();
    delivery.defer({ runId: "sa-3" });
    const claimed = delivery.claim("sa-3");
    assert.ok(claimed);
    delivery.restore(claimed);
    assert.deepEqual(delivery.pendingRunIds(), ["sa-3"]);
    const retry = delivery.claim("sa-3");
    assert.ok(retry);
    delivery.confirm("sa-3");
    assert.equal(delivery.claim("sa-3"), undefined);
  });
});

describe("SubagentSupervisor lifecycle", () => {
  it("delivers background completion exactly once across handler and drain", async () => {
    const agentDir = isolatedAgentDir();
    const sv = new SubagentSupervisor(process.cwd(), agentDir);
    let deliveries = 0;
    sv.setBackgroundCompleteHandler(() => {
      deliveries++;
      return true;
    });

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

    await waitFor(() => deliveries === 1);
    assert.equal(deliveries, 1);
    sv.drainPendingResults();
    assert.equal(deliveries, 1);

    await sv.dispose();
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it("retries deferred delivery when immediate send fails", async () => {
    const agentDir = isolatedAgentDir();
    const sv = new SubagentSupervisor(process.cwd(), agentDir);
    let deliveries = 0;
    sv.setBackgroundCompleteHandler(() => {
      deliveries++;
      return deliveries > 1;
    });

    await sv.run({
      profile: "scout",
      task: "retry delivery",
      cwd: process.cwd(),
      parentModel: fakeModel,
      mode: "background",
      spawnOverride: { command: process.execPath, args: [FIXTURE, "--mode=settle"] },
    });

    await waitFor(() => deliveries === 1);
    assert.equal(deliveries, 1);
    sv.drainPendingResults();
    assert.equal(deliveries, 2);

    await sv.dispose();
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it("keeps background results pending until a handler is installed", async () => {
    const agentDir = isolatedAgentDir();
    const sv = new SubagentSupervisor(process.cwd(), agentDir);

    await sv.run({
      profile: "scout",
      task: "pending without handler",
      cwd: process.cwd(),
      parentModel: fakeModel,
      mode: "background",
      spawnOverride: { command: process.execPath, args: [FIXTURE, "--mode=settle"] },
    });

    await waitFor(() => sv.pendingBackgroundRunIds().length === 1);
    assert.deepEqual(sv.pendingBackgroundRunIds().length, 1);

    let deliveries = 0;
    sv.setBackgroundCompleteHandler(() => {
      deliveries++;
      return true;
    });
    sv.drainPendingResults();
    assert.equal(deliveries, 1);
    assert.deepEqual(sv.pendingBackgroundRunIds().length, 0);

    await sv.dispose();
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
    await waitFor(() => Boolean(sv.getRun(started.runId)?.result?.error));

    const record = sv.getRun(started.runId);
    assert.ok(record);
    assert.equal(record!.status, "cancelled");
    assert.match(record!.result?.error ?? "", /user stopped/);

    await sv.dispose();
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

    await sv.dispose();
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
    await sv.dispose();
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it("clears pending delivery state on dispose and ignores late completion", async () => {
    const agentDir = isolatedAgentDir();
    const sv = new SubagentSupervisor(process.cwd(), agentDir);
    let deliveries = 0;
    sv.setBackgroundCompleteHandler(() => {
      deliveries++;
      return true;
    });

    await sv.run({
      profile: "scout",
      task: "pending clear",
      cwd: process.cwd(),
      parentModel: fakeModel,
      mode: "background",
      spawnOverride: { command: process.execPath, args: [FIXTURE, "--mode=hang"] },
    });

    await sleep(50);
    await sv.dispose();
    assert.equal(sv.isDisposed(), true);
    assert.deepEqual(sv.pendingBackgroundRunIds().length, 0);
    sv.drainPendingResults();
    assert.equal(deliveries, 0);

    await sleep(500);
    assert.equal(deliveries, 0);

    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it("finalizes worktree changes when child exits after writing a file", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-lifecycle-wt-"));
    initGitRepo(repo);
    const agentDir = isolatedAgentDir();
    const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-artifacts-"));

    const sv = new SubagentSupervisor(repo, agentDir, { artifactRoot });
    const result = await sv.run({
      profile: "worker",
      task: "write then crash",
      cwd: repo,
      parentModel: fakeModel,
      spawnOverride: { command: process.execPath, args: [FIXTURE, "--mode=write-exit"] },
    });

    assert.equal(result.status, "failed");
    assert.ok(result.worktreeDelivery);
    assert.equal(result.worktreeDelivery?.branch, `pi-subagent-${result.runId}`);
    assert.ok(result.worktreeDelivery?.patch);
    assert.match(result.report, /^## Recovery/);
    assert.match(result.report, /Branch: pi-subagent-/);
    assert.match(result.report, /Patch:/);
    assert.match(result.error ?? "", /RpcChild exited|branch=|patch=/i);
    const branchDiff = execFileSync(
      "git",
      [
        "diff",
        `${result.worktreeDelivery!.baseSha}..${result.worktreeDelivery!.branch}`,
        "--",
        "orphan-change.txt",
      ],
      { cwd: repo, encoding: "utf8" },
    );
    assert.match(branchDiff, /orphan/);

    await sv.dispose();
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(artifactRoot, { recursive: true, force: true });
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it("completes failed background run when executeRun rejects", async () => {
    const agentDir = isolatedAgentDir();
    const sv = new SubagentSupervisor(process.cwd(), agentDir);
    let deliveries = 0;
    sv.setBackgroundCompleteHandler(() => {
      deliveries++;
      return true;
    });

    const executeRun = sv["executeRun"].bind(sv);
    sv["executeRun"] = async () => {
      throw new Error("execute exploded");
    };

    const started = await sv.run({
      profile: "scout",
      task: "bg failure",
      cwd: process.cwd(),
      parentModel: fakeModel,
      mode: "background",
      spawnOverride: { command: process.execPath, args: [FIXTURE, "--mode=settle"] },
    });

    await sleep(500);

    const record = sv.getRun(started.runId);
    assert.equal(record?.status, "failed");
    assert.match(record?.result?.error ?? "", /execute exploded/);
    assert.equal(deliveries, 1);

    sv["executeRun"] = executeRun;
    await sv.dispose();
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it("rejects run after supervisor disposal", async () => {
    const agentDir = isolatedAgentDir();
    const sv = new SubagentSupervisor(process.cwd(), agentDir);
    await sv.dispose();
    await assert.rejects(
      () =>
        sv.run({
          profile: "scout",
          task: "after dispose",
          cwd: process.cwd(),
          parentModel: fakeModel,
          spawnOverride: { command: process.execPath, args: [FIXTURE, "--mode=settle"] },
        }),
      /disposed/i,
    );
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it("fails visibly when artifact finalization cannot complete", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-lifecycle-wt-"));
    initGitRepo(repo);
    const agentDir = isolatedAgentDir();
    const artifactRoot = path.join(repo, "README.md");

    const sv = new SubagentSupervisor(repo, agentDir, { artifactRoot });
    const result = await sv.run({
      profile: "worker",
      task: "artifact failure",
      cwd: repo,
      parentModel: fakeModel,
      spawnOverride: { command: process.execPath, args: [FIXTURE, "--mode=write-exit"] },
    });

    assert.equal(result.status, "failed");
    assert.ok(result.worktreeDelivery?.error);
    assert.equal(result.worktreeDelivery?.branch, `pi-subagent-${result.runId}`);
    assert.equal(result.worktreeDelivery?.patch, undefined);
    assert.ok(result.worktreeDelivery?.retainedWorktreePath);
    assert.match(result.report, /^## Recovery/);
    assert.match(result.report, /Retained worktree:/);
    assert.match(result.error ?? "", /patch generation failed|retained=/i);

    const retained = result.worktreeDelivery!.retainedWorktreePath!;
    if (fs.existsSync(retained)) {
      execFileSync("git", ["worktree", "remove", "--force", retained], {
        cwd: repo,
        stdio: "pipe",
      });
    }

    await sv.dispose();
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(agentDir, { recursive: true, force: true });
  });
});
