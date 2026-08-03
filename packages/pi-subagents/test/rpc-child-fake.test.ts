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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-fake-"));
  fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
  return dir;
}

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
