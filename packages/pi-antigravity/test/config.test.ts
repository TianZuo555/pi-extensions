import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { piConfigDir } from "../lib/config.ts";

test("piConfigDir lives under pi's agent dir by default", () => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  delete process.env.PI_CODING_AGENT_DIR;
  try {
    assert.equal(
      piConfigDir("antigravity"),
      path.join(os.homedir(), ".pi", "agent", "antigravity"),
    );
  } finally {
    if (previous !== undefined) process.env.PI_CODING_AGENT_DIR = previous;
  }
});

test("piConfigDir follows PI_CODING_AGENT_DIR so profiles never share caches", () => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = path.join(os.tmpdir(), "pi-agent-override");
  try {
    assert.equal(
      piConfigDir("antigravity"),
      path.join(os.tmpdir(), "pi-agent-override", "antigravity"),
    );
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});
