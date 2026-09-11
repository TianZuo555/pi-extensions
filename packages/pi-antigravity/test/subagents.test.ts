import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type AgySubagentEntry,
  formatAgySubagents,
  isAgySubagentTool,
  trackAgySubagent,
} from "../lib/subagents.ts";

function roster(): Map<string, AgySubagentEntry> {
  return new Map();
}

test("isAgySubagentTool covers the subagent tool family only", () => {
  for (const name of [
    "invoke_subagent",
    "run_subagent",
    "define_subagent",
    "browser_subagent",
    "send_message",
    "manage_subagents",
  ]) {
    assert.ok(isAgySubagentTool(name), name);
  }
  for (const name of ["run_command", "view_file", "manage_task", "antigravity"]) {
    assert.ok(!isAgySubagentTool(name), name);
  }
});

test("spawn/done lifecycle produces a finished entry with name and detail", () => {
  const map = roster();
  trackAgySubagent(map, {
    type: "tool_start",
    stepId: 7,
    name: "invoke_subagent",
    args: { Name: "researcher", Task: "map the repo layout" },
  });
  trackAgySubagent(map, {
    type: "tool_done",
    stepId: 7,
    name: "invoke_subagent",
    args: { Name: "researcher" },
    durationSeconds: 12.4,
  });
  const entries = [...map.values()];
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, "researcher");
  assert.equal(entries[0].status, "done");
  assert.equal(entries[0].durationSeconds, 12.4);
  assert.equal(entries[0].detail, "map the repo layout");
});

test("error steps mark the entry without losing earlier state", () => {
  const map = roster();
  trackAgySubagent(map, {
    type: "tool_start",
    stepId: 1,
    name: "run_subagent",
    args: { name: "worker" },
  });
  trackAgySubagent(map, {
    type: "tool_error",
    stepId: 1,
    name: "run_subagent",
    args: {},
    message: "quota exhausted",
  });
  const entry = [...map.values()][0];
  assert.equal(entry.status, "error");
  assert.equal(entry.error, "quota exhausted");
});

test("parallel spawns keep separate entries keyed by step id", () => {
  const map = roster();
  for (const stepId of [1, 2]) {
    trackAgySubagent(map, {
      type: "tool_start",
      stepId,
      name: "invoke_subagent",
      args: { Name: "researcher" },
    });
  }
  trackAgySubagent(map, {
    type: "tool_done",
    stepId: 2,
    name: "invoke_subagent",
    args: {},
  });
  const statuses = [...map.values()].map((entry) => entry.status).sort();
  assert.deepEqual(statuses, ["done", "running"]);
});

test("send_message counts messages against the addressed subagent", () => {
  const map = roster();
  trackAgySubagent(map, {
    type: "tool_start",
    stepId: 3,
    name: "invoke_subagent",
    args: { Name: "Planner" },
  });
  for (let i = 0; i < 2; i++) {
    trackAgySubagent(map, {
      type: "tool_start",
      stepId: 10 + i,
      name: "send_message",
      args: { To: "planner", Message: "status?" },
    });
  }
  // Unknown targets do not create phantom entries.
  trackAgySubagent(map, {
    type: "tool_start",
    stepId: 20,
    name: "send_message",
    args: { To: "ghost", Message: "hi" },
  });
  const entry = [...map.values()][0];
  assert.equal(entry.messages, 2);
  assert.equal(map.size, 1);
});

test("manage_subagents kill marks named target or all running", () => {
  const map = roster();
  for (const [stepId, name] of [
    [1, "a"],
    [2, "b"],
  ] as const) {
    trackAgySubagent(map, {
      type: "tool_start",
      stepId,
      name: "invoke_subagent",
      args: { Name: name },
    });
  }
  trackAgySubagent(map, {
    type: "tool_start",
    stepId: 5,
    name: "manage_subagents",
    args: { Action: "kill", Name: "a" },
  });
  assert.equal(findEntry(map, "a").status, "killed");
  assert.equal(findEntry(map, "b").status, "running");
  trackAgySubagent(map, {
    type: "tool_start",
    stepId: 6,
    name: "manage_subagents",
    args: { Action: "kill all" },
  });
  assert.equal(findEntry(map, "b").status, "killed");
});

function findEntry(map: Map<string, AgySubagentEntry>, name: string): AgySubagentEntry {
  const entry = [...map.values()].find((candidate) => candidate.name === name);
  assert.ok(entry, `missing entry ${name}`);
  return entry;
}

test("non-subagent tools and non-tool activities are ignored", () => {
  const map = roster();
  trackAgySubagent(map, { type: "tool_start", stepId: 1, name: "run_command", args: {} });
  trackAgySubagent(map, { type: "text", delta: "hello" });
  trackAgySubagent(map, { type: "usage", usage: {} });
  assert.equal(map.size, 0);
});

test("formatAgySubagents renders header and bounded one-line entries", () => {
  const map = roster();
  trackAgySubagent(
    map,
    {
      type: "tool_start",
      stepId: 1,
      name: "invoke_subagent",
      args: { Name: "researcher", Task: "x".repeat(300) },
    },
    1_000,
  );
  trackAgySubagent(map, {
    type: "tool_start",
    stepId: 2,
    name: "run_subagent",
    args: { name: "worker" },
  });
  trackAgySubagent(map, {
    type: "tool_done",
    stepId: 2,
    name: "run_subagent",
    args: {},
    durationSeconds: 95,
  });
  const report = formatAgySubagents(map, 61_000);
  assert.ok(report);
  const lines = report.split("\n");
  assert.equal(lines[0], "antigravity subagents: 2 tracked · 1 running");
  assert.ok(lines[1].includes("researcher") && lines[1].includes("running"));
  assert.ok(lines[2].includes("worker") && lines[2].includes("done") && lines[2].includes("1m35s"));
  for (const line of lines) {
    assert.ok(line.length < 220, `line too long: ${line.length}`);
  }
});

test("formatAgySubagents returns undefined for an empty roster", () => {
  assert.equal(formatAgySubagents(roster()), undefined);
});
