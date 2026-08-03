import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { ProfileCatalog } from "../lib/profile-catalog.ts";
import {
  REPORT_MAX_BYTES,
  TASK_MAX_LENGTH,
  TRUNCATION_MARKER,
  truncateText,
  truncateUtf8,
} from "../lib/domain.ts";

function isolatedAgentDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-catalog-"));
  fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
  return dir;
}

describe("ProfileCatalog", () => {
  it("loads builtin profiles including reviewer and worker", () => {
    const agentDir = isolatedAgentDir();
    const catalog = new ProfileCatalog(process.cwd(), agentDir);
    const scout = catalog.resolve("scout");
    assert.equal(scout.qualifiedId, "builtin/scout");
    assert.equal(scout.workspace, "shared-readonly");
    const worker = catalog.resolve("builtin/worker");
    assert.equal(worker.workspace, "worktree");
    assert.ok(worker.tools.includes("write"));
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it("lists qualified ids", () => {
    const agentDir = isolatedAgentDir();
    const catalog = new ProfileCatalog(process.cwd(), agentDir);
    const ids = catalog.listQualifiedIds();
    assert.ok(ids.includes("builtin/scout"));
    assert.ok(ids.includes("builtin/worker"));
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it("loads user profile with tools * and inferred shared-write", () => {
    const agentDir = isolatedAgentDir();
    const agentsDir = path.join(agentDir, "agents");
    fs.writeFileSync(
      path.join(agentsDir, "executor.md"),
      `---
name: executor
tools: "*"
description: full tool access
---
You are an executor.
`,
      "utf8",
    );

    const catalog = new ProfileCatalog(process.cwd(), agentDir);
    const profile = catalog.resolve("user/executor");
    assert.equal(profile.workspace, "shared-write");
    assert.ok(profile.tools.includes("write"));
    assert.equal(catalog.getLoadDiagnostics().length, 0);

    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it("records skip diagnostics without console noise", () => {
    const agentDir = isolatedAgentDir();
    const agentsDir = path.join(agentDir, "agents");
    fs.writeFileSync(
      path.join(agentsDir, "bad.md"),
      `---
name: bad
tools: teleport
---
Broken
`,
      "utf8",
    );

    const catalog = new ProfileCatalog(process.cwd(), agentDir);
    const diags = catalog.getLoadDiagnostics();
    assert.equal(diags.length, 1);
    assert.match(diags[0], /teleport/);

    fs.rmSync(agentDir, { recursive: true, force: true });
  });
});

describe("truncation", () => {
  it("marks UTF-16 truncation for task/context limits", () => {
    const long = "a".repeat(TASK_MAX_LENGTH + 10);
    const out = truncateText(long, TASK_MAX_LENGTH);
    assert.ok(out.endsWith(TRUNCATION_MARKER));
    assert.ok(out.length <= TASK_MAX_LENGTH);
  });

  it("marks byte truncation for reports", () => {
    const long = "é".repeat(REPORT_MAX_BYTES);
    const out = truncateUtf8(long, 64);
    assert.ok(out.endsWith(TRUNCATION_MARKER));
    assert.ok(Buffer.byteLength(out, "utf8") <= 64);
  });
});
