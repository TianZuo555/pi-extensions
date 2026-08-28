import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { MAX_CONCURRENT_RUNS, MAX_SESSION_RUNS } from "../lib/domain.ts";
import { SubagentSupervisor } from "../lib/supervisor.ts";

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-catalog-"));
  fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
  return dir;
}

describe("SubagentSupervisor budgets", () => {
  it("rejects spawn when session run limit exceeded", async () => {
    const agentDir = isolatedAgentDir();
    const sv = new SubagentSupervisor(process.cwd(), agentDir);
    (sv as unknown as { sessionRunCount: number }).sessionRunCount = MAX_SESSION_RUNS;
    await assert.rejects(
      () =>
        sv.run({
          profile: "scout",
          task: "one more",
          cwd: process.cwd(),
          parentModel: undefined,
        }),
      /Session subagent limit reached/,
    );
    await sv.dispose();
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it("rejects when concurrent limit exceeded with live runs", async () => {
    const agentDir = isolatedAgentDir();
    const sv = new SubagentSupervisor(process.cwd(), agentDir);
    const hang = { command: process.execPath, args: [FIXTURE, "--mode=hang"] };

    const started = await Promise.all(
      Array.from({ length: MAX_CONCURRENT_RUNS }, (_, i) =>
        sv.run({
          profile: "scout",
          task: `hang ${i}`,
          cwd: process.cwd(),
          parentModel: fakeModel,
          mode: "background",
          spawnOverride: hang,
        }),
      ),
    );
    assert.equal(
      started.every((r) => r.status === "running"),
      true,
    );

    await assert.rejects(
      () =>
        sv.run({
          profile: "scout",
          task: "blocked",
          cwd: process.cwd(),
          parentModel: fakeModel,
          spawnOverride: hang,
        }),
      /Too many concurrent subagents/,
    );

    await sv.dispose();
    fs.rmSync(agentDir, { recursive: true, force: true });
  });
});
