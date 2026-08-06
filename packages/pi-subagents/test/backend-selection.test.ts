import assert from "node:assert/strict";
import * as fs from "node:fs";
import { describe, it, afterEach } from "node:test";
import { SubagentBackendPool } from "../lib/backend-pool.ts";
import { resolveBackendKind } from "../lib/backend-selection.ts";
import type { ProfileDefinition } from "../lib/domain.ts";
import {
  isHerdrAvailable,
  resetHerdrCapabilityCache,
  setHerdrBinaryPathForTests,
} from "../lib/herdr/capability.ts";

function baseProfile(overrides: Partial<ProfileDefinition> = {}): ProfileDefinition {
  return {
    qualifiedId: "user/test",
    name: "test",
    source: "user",
    description: "test",
    tools: ["read"],
    systemPrompt: "test",
    workspace: "shared-readonly",
    timeoutMs: 60_000,
    maxTurns: 8,
    kind: "pi",
    backend: "auto",
    agentArgs: [],
    ...overrides,
  };
}

const savedHerdrEnv = process.env.HERDR_ENV;

afterEach(() => {
  resetHerdrCapabilityCache();
  setHerdrBinaryPathForTests(undefined);
  if (savedHerdrEnv === undefined) delete process.env.HERDR_ENV;
  else process.env.HERDR_ENV = savedHerdrEnv;
});

describe("backend selection", () => {
  it("pins rpc when profile.backend is rpc", () => {
    process.env.HERDR_ENV = "1";
    setHerdrBinaryPathForTests("/tmp/fake-herdr");
    assert.equal(resolveBackendKind(baseProfile({ backend: "rpc" })), "rpc");
  });

  it("requires Herdr when profile.backend is herdr and Herdr is unavailable", () => {
    delete process.env.HERDR_ENV;
    setHerdrBinaryPathForTests(null);
    assert.throws(
      () => resolveBackendKind(baseProfile({ backend: "herdr" })),
      /requires Herdr but no Herdr session is available/i,
    );
  });

  it("selects herdr when profile.backend is herdr and Herdr is available", () => {
    process.env.HERDR_ENV = "1";
    setHerdrBinaryPathForTests("/tmp/fake-herdr");
    assert.equal(resolveBackendKind(baseProfile({ backend: "herdr" })), "herdr");
  });

  it("selects herdr for auto when Herdr is available", () => {
    process.env.HERDR_ENV = "1";
    setHerdrBinaryPathForTests("/tmp/fake-herdr");
    assert.equal(resolveBackendKind(baseProfile({ backend: "auto", kind: "codex" })), "herdr");
  });

  it("selects rpc for auto pi profile when Herdr is unavailable", () => {
    delete process.env.HERDR_ENV;
    setHerdrBinaryPathForTests(null);
    assert.equal(resolveBackendKind(baseProfile({ backend: "auto", kind: "pi" })), "rpc");
  });

  it("fails auto non-pi profile when Herdr is unavailable", () => {
    delete process.env.HERDR_ENV;
    setHerdrBinaryPathForTests(null);
    assert.throws(
      () => resolveBackendKind(baseProfile({ backend: "auto", kind: "codex" })),
      /requires agent kind "codex", which needs a Herdr session/,
    );
  });

  it("does not silently downgrade codex to rpc when Herdr is unavailable", () => {
    delete process.env.HERDR_ENV;
    setHerdrBinaryPathForTests(null);
    assert.equal(isHerdrAvailable(), false);
    assert.throws(() => resolveBackendKind(baseProfile({ kind: "codex", backend: "auto" })));
  });
});

describe("test-suite safety guards", () => {
  it("PI_SUBAGENTS_DISABLE_HERDR forces unavailable even inside a real Herdr session", () => {
    process.env.HERDR_ENV = "1";
    process.env.PI_SUBAGENTS_DISABLE_HERDR = "1";
    setHerdrBinaryPathForTests(undefined);
    resetHerdrCapabilityCache();
    try {
      assert.equal(isHerdrAvailable(), false);
      assert.equal(resolveBackendKind(baseProfile({ backend: "auto", kind: "pi" })), "rpc");
    } finally {
      delete process.env.PI_SUBAGENTS_DISABLE_HERDR;
      resetHerdrCapabilityCache();
    }
  });

  it("the package test script sets the guard so suites never drive a live Herdr server", () => {
    const pkg = JSON.parse(
      fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { scripts: Record<string, string> };
    assert.match(pkg.scripts.test, /PI_SUBAGENTS_DISABLE_HERDR=1/);
  });

  it("RPC-only controls force the rpc backend even when Herdr is available", () => {
    process.env.HERDR_ENV = "1";
    setHerdrBinaryPathForTests("/tmp/fake-herdr");
    assert.equal(isHerdrAvailable(), true);
    const pool = new SubagentBackendPool({ artifactRoot: "/tmp/pi-subagents-pool-test" });
    assert.equal(pool.resolve(baseProfile({ backend: "auto", kind: "pi" })).backendId, "herdr");
    assert.equal(pool.resolve(baseProfile({ backend: "auto", kind: "pi" }), true).backendId, "rpc");
  });
});
