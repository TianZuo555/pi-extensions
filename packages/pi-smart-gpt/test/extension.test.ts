import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import smartGpt from "../index.ts";

interface Registered {
  name: string;
  description?: string;
  parameters?: unknown;
  execute?: (...args: unknown[]) => Promise<unknown>;
  handler?: (args: string, ctx: unknown) => Promise<void>;
}

function fakePi(): { pi: ExtensionAPI; tools: Registered[]; commands: Registered[] } {
  const tools: Registered[] = [];
  const commands: Registered[] = [];
  const pi = {
    registerTool: (tool: Registered) => tools.push(tool),
    registerCommand: (name: string, command: Registered) => commands.push({ ...command, name }),
  };
  return { pi: pi as unknown as ExtensionAPI, tools, commands };
}

function ui() {
  const notes: string[] = [];
  return { notes, ctx: { ui: { notify: (message: string) => notes.push(message) } } };
}

test("registers one tool and one command, and no timers or listeners", () => {
  const { pi, tools, commands } = fakePi();
  smartGpt(pi);
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["smart_gpt"],
  );
  assert.equal(tools[0]!.parameters !== undefined, true);
  assert.deepEqual(
    commands.map((command) => command.name),
    ["smart"],
  );
});

test("/smart history shows an empty series, and neither probe runs", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-smart-gpt-ext-"));
  process.env.PI_SMART_STATE_DIR = dir;
  try {
    const { pi, commands } = fakePi();
    smartGpt(pi);
    const { notes, ctx } = ui();
    await commands[0]!.handler!("history", ctx);
    assert.equal(notes.length, 1);
    assert.match(notes[0]!, /no runs yet/u);
    assert.equal(fs.existsSync(path.join(dir, "runs.jsonl")), false);
  } finally {
    delete process.env.PI_SMART_STATE_DIR;
  }
});

test("/smart with a word that is not an email prints the usage", async () => {
  const { pi, commands } = fakePi();
  smartGpt(pi);
  const { notes, ctx } = ui();
  await commands[0]!.handler!("everyone", ctx);
  assert.match(notes[0]!, /\/smart history/u);
});
