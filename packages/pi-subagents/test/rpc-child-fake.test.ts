import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { REPORT_MAX_BYTES } from "../lib/domain.ts";
import { renderRunReport } from "../lib/run-report.ts";
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-fake-"));
  fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
  return dir;
}

describe("RpcChild structured reports via fake child", () => {
  it("captures valid structured completion", async () => {
    const agentDir = isolatedAgentDir();
    const sv = new SubagentSupervisor(process.cwd(), agentDir);
    const result = await sv.run({
      profile: "scout",
      task: "structured report",
      cwd: process.cwd(),
      parentModel: fakeModel,
      spawnOverride: { command: process.execPath, args: [FIXTURE, "--mode=report"] },
    });
    assert.equal(result.status, "completed");
    assert.equal(result.semanticReport?.kind, "structured");
    if (result.semanticReport?.kind === "structured") {
      assert.equal(result.semanticReport.report.status, "completed");
      assert.match(result.semanticReport.report.summary, /structured completed/);
    }
    assert.match(result.report, /Status: completed/);
    sv.dispose();
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it("accepts blocked and failed structured reports as completed runs", async () => {
    const agentDir = isolatedAgentDir();
    const sv = new SubagentSupervisor(process.cwd(), agentDir);

    const blocked = await sv.run({
      profile: "scout",
      task: "blocked",
      cwd: process.cwd(),
      parentModel: fakeModel,
      spawnOverride: { command: process.execPath, args: [FIXTURE, "--mode=report-blocked"] },
    });
    assert.equal(blocked.status, "completed");
    assert.equal(
      blocked.semanticReport?.kind === "structured"
        ? blocked.semanticReport.report.status
        : undefined,
      "blocked",
    );

    const failed = await sv.run({
      profile: "scout",
      task: "failed",
      cwd: process.cwd(),
      parentModel: fakeModel,
      spawnOverride: { command: process.execPath, args: [FIXTURE, "--mode=report-failed"] },
    });
    assert.equal(failed.status, "completed");
    assert.equal(
      failed.semanticReport?.kind === "structured" ? failed.semanticReport.report.status : undefined,
      "failed",
    );

    sv.dispose();
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it("falls back to assistant text for malformed report details", async () => {
    const agentDir = isolatedAgentDir();
    const sv = new SubagentSupervisor(process.cwd(), agentDir);
    const result = await sv.run({
      profile: "scout",
      task: "bad report",
      cwd: process.cwd(),
      parentModel: fakeModel,
      spawnOverride: { command: process.execPath, args: [FIXTURE, "--mode=report-bad"] },
    });
    assert.equal(result.semanticReport?.kind, "unstructured");
    assert.match(result.report, /fake subagent report/);
    sv.dispose();
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it("falls back to bounded assistant text when report_result is missing", async () => {
    const agentDir = isolatedAgentDir();
    const sv = new SubagentSupervisor(process.cwd(), agentDir);
    const result = await sv.run({
      profile: "scout",
      task: "no report",
      cwd: process.cwd(),
      parentModel: fakeModel,
      spawnOverride: { command: process.execPath, args: [FIXTURE, "--mode=no-report"] },
    });
    assert.equal(result.semanticReport?.kind, "unstructured");
    assert.match(result.report, /fake subagent report/);
    sv.dispose();
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it("bounds rendered structured report size", () => {
    const rendered = renderRunReport({
      status: "completed",
      summary: "x".repeat(REPORT_MAX_BYTES),
      changes: Array.from({ length: 100 }, (_, i) => ({
        path: `file-${i}.ts`,
        summary: "y".repeat(500),
      })),
    });
    assert.ok(Buffer.byteLength(rendered, "utf8") <= REPORT_MAX_BYTES);
  });

  it("falls back when nested report fields are malformed", async () => {
    const agentDir = isolatedAgentDir();
    const sv = new SubagentSupervisor(process.cwd(), agentDir);
    const result = await sv.run({
      profile: "scout",
      task: "nested bad report",
      cwd: process.cwd(),
      parentModel: fakeModel,
      spawnOverride: { command: process.execPath, args: [FIXTURE, "--mode=report-nested-bad"] },
    });
    assert.equal(result.semanticReport?.kind, "unstructured");
    assert.match(result.report, /fake subagent report/);
    sv.dispose();
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it("completes after steer warning and a grace turn when report_result follows", async () => {
    const agentDir = isolatedAgentDir();
    const agentsDir = path.join(agentDir, "agents");
    fs.writeFileSync(
      path.join(agentsDir, "tight.md"),
      `---
name: tight
tools: read
maxTurns: 2
---
Tight turn budget profile.
`,
      "utf8",
    );

    const sv = new SubagentSupervisor(process.cwd(), agentDir);
    const result = await sv.run({
      profile: "user/tight",
      task: "warn then report",
      cwd: process.cwd(),
      parentModel: fakeModel,
      spawnOverride: {
        command: process.execPath,
        args: [FIXTURE, "--mode=turns-report", "--max-turns=2"],
      },
    });
    assert.equal(result.status, "completed");
    assert.notEqual(result.budgetExhausted, true);
    assert.equal(result.semanticReport?.kind, "structured");
    if (result.semanticReport?.kind === "structured") {
      assert.equal(result.semanticReport.report.status, "completed");
    }

    sv.dispose();
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it("aborts on live turn budget exhaustion before terminal report", async () => {
    const agentDir = isolatedAgentDir();
    const agentsDir = path.join(agentDir, "agents");
    fs.writeFileSync(
      path.join(agentsDir, "tight.md"),
      `---
name: tight
tools: read
maxTurns: 2
---
Tight turn budget profile.
`,
      "utf8",
    );

    const sv = new SubagentSupervisor(process.cwd(), agentDir);
    const result = await sv.run({
      profile: "user/tight",
      task: "exhaust turns",
      cwd: process.cwd(),
      parentModel: fakeModel,
      spawnOverride: {
        command: process.execPath,
        args: [FIXTURE, "--mode=turns", "--max-turns=2"],
      },
    });
    assert.equal(result.status, "failed");
    assert.equal(result.budgetExhausted, true);
    assert.match(result.error ?? "", /turn budget exhausted/i);
    assert.equal(sv.listRuns().filter((r) => r.status === "running").length, 0);

    sv.dispose();
    fs.rmSync(agentDir, { recursive: true, force: true });
  });
});

describe("SubagentSupervisor with fake RPC child", () => {
  it("completes a foreground run via fake child", async () => {
    const agentDir = isolatedAgentDir();
    const sv = new SubagentSupervisor(process.cwd(), agentDir);
    const result = await sv.run({
      profile: "scout",
      task: "inspect fixtures",
      cwd: process.cwd(),
      parentModel: fakeModel,
      spawnOverride: { command: process.execPath, args: [FIXTURE, "--mode=settle"] },
    });
    assert.equal(result.status, "completed");
    assert.match(result.report, /fake subagent report/);
    assert.ok(result.usage.input > 0);
    sv.dispose();
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it("times out or fails when child never settles", async () => {
    const agentDir = isolatedAgentDir();
    const sv = new SubagentSupervisor(process.cwd(), agentDir);
    const result = await sv.run({
      profile: "planner",
      task: "hang test",
      cwd: process.cwd(),
      parentModel: fakeModel,
      timeoutMs: 500,
      spawnOverride: { command: process.execPath, args: [FIXTURE, "--mode=hang"] },
    });
    assert.notEqual(result.status, "completed");
    sv.dispose();
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it("fails fast when child exits before settling", async () => {
    const agentDir = isolatedAgentDir();
    const sv = new SubagentSupervisor(process.cwd(), agentDir);
    const started = Date.now();
    const result = await sv.run({
      profile: "scout",
      task: "crash test",
      cwd: process.cwd(),
      parentModel: fakeModel,
      spawnOverride: { command: process.execPath, args: [FIXTURE, "--mode=exit"] },
    });
    assert.notEqual(result.status, "completed");
    assert.ok(Date.now() - started < 10_000);
    assert.equal(sv.listRuns().filter((r) => r.status === "running").length, 0);
    sv.dispose();
    fs.rmSync(agentDir, { recursive: true, force: true });
  });
});
