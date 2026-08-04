import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
  ensureProjectProfileAllowed,
  isProfileApproved,
  profileContentHash,
  recordProfileApproval,
} from "../lib/trust.ts";
import type { ProfileDefinition } from "../lib/domain.ts";

function sampleProjectProfile(hash: string): ProfileDefinition {
  return {
    qualifiedId: "project/test-agent",
    name: "test-agent",
    source: "project",
    description: "test",
    tools: ["read"],
    systemPrompt: "You are a test agent.",
    workspace: "shared-readonly",
    timeoutMs: 60_000,
    maxTurns: 8,
    contentHash: hash,
  };
}

describe("profile trust", () => {
  it("hashes profile content deterministically", () => {
    const hash = profileContentHash("hello");
    assert.equal(hash.length, 16);
    assert.equal(hash, profileContentHash("hello"));
    assert.notEqual(hash, profileContentHash("hello!"));
  });

  it("requires project trust before approval", async () => {
    const profile = sampleProjectProfile("abc123");
    await assert.rejects(
      () =>
        ensureProjectProfileAllowed(profile, {
          projectTrusted: false,
          hasUI: true,
          requestApproval: async () => true,
        }, "/tmp/agent"),
      /requires a trusted project/,
    );
  });

  it("records approval after interactive confirm", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-trust-"));
    const agentDir = path.join(tmp, "agent");
    fs.mkdirSync(agentDir, { recursive: true });

    const profile = sampleProjectProfile("deadbeef00000000");
    let asked = false;
    await ensureProjectProfileAllowed(profile, {
      projectTrusted: true,
      hasUI: true,
      requestApproval: async () => {
        asked = true;
        return true;
      },
    }, agentDir);
    assert.equal(asked, true);
    assert.equal(isProfileApproved(agentDir, profile.qualifiedId, profile.contentHash!), true);

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("skips re-prompt when hash already approved", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-trust-"));
    const agentDir = path.join(tmp, "agent");
    fs.mkdirSync(agentDir, { recursive: true });

    const profile = sampleProjectProfile("cafebabe00000000");
    recordProfileApproval(agentDir, profile.qualifiedId, profile.contentHash!);
    let asked = false;
    await ensureProjectProfileAllowed(profile, {
      projectTrusted: true,
      hasUI: true,
      requestApproval: async () => {
        asked = true;
        return true;
      },
    }, agentDir);
    assert.equal(asked, false);

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
