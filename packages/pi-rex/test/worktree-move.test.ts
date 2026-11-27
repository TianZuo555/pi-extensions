import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, test } from "node:test";
import type { ExecResult } from "../lib/naming.ts";
import {
  isEmptySession,
  moveTab,
  parseApps,
  parseNewSession,
  registerWorktreeMove,
  resolveTarget,
  SWITCH_COMMAND,
} from "../lib/worktree-move.ts";

const ok: ExecResult = { code: 0, stdout: "" };
const json = (value: unknown): ExecResult => ({ code: 0, stdout: JSON.stringify(value) });

const NEW_SESSION = {
  session_id: "session:new",
  initial_windows: [{ window_id: "window:shell", block_ids: ["block:shell"] }],
};

function folders() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "pi-rex-move-")));
  const repo = path.join(root, "repo");
  const worktree = path.join(root, "repo-feature");
  mkdirSync(repo);
  mkdirSync(worktree);
  return { root, repo, worktree };
}

/** A fake exec that answers Rex and git, and records every call. */
const APPS = {
  clients: [
    { client_id: "client:air", info: { kind: "app", label: "Air" } },
    { client_id: "client:cli", info: { kind: "cli", name: "rex" } },
  ],
};

function fakeExec(
  overrides: {
    move?: ExecResult;
    created?: ExecResult;
    oldWindows?: unknown;
    select?: ExecResult;
  } = {},
) {
  const calls: string[][] = [];
  const exec = async (command: string, args: string[]): Promise<ExecResult> => {
    calls.push([command, ...args]);
    if (command === "git") return { code: 1, stdout: "" };
    if (args[0] === "whoami") return json({ session_id: "session:old", window_id: "window:me" });
    if (args[0] === "session" && args[1] === "inspect") {
      const windows =
        "oldWindows" in overrides ? overrides.oldWindows : [{ window_id: "window:2" }];
      return json({ session_id: "session:old", label: "old", windows });
    }
    if (args[0] === "new") return overrides.created ?? json(NEW_SESSION);
    if (args[0] === "client" && args[1] === "ls") return json(APPS);
    if (args[0] === "-C") return overrides.select ?? ok;
    if (args[0] === "window" && args[1] === "move") return overrides.move ?? ok;
    return ok;
  };
  return { calls, exec };
}

beforeEach(() => {
  delete process.env.REX_SESSION;
  delete process.env.REX_BLOCK;
});

test("parseNewSession reads the session and its first window", () => {
  assert.deepEqual(parseNewSession(JSON.stringify(NEW_SESSION)), {
    sessionId: "session:new",
    windowId: "window:shell",
  });
  assert.deepEqual(parseNewSession('{"session_id":"session:x"}'), { sessionId: "session:x" });
  assert.equal(parseNewSession("not json"), undefined);
  assert.equal(parseNewSession('{"initial_windows":[]}'), undefined);
});

test("resolveTarget accepts an existing other folder only", () => {
  const { root, repo, worktree } = folders();
  assert.equal(resolveTarget("../repo-feature", repo), worktree);
  assert.throws(() => resolveTarget(".", repo), /already works in/);
  assert.throws(() => resolveTarget("missing", repo), /does not exist/);
  const file = path.join(root, "file.txt");
  writeFileSync(file, "x");
  assert.throws(() => resolveTarget(file, repo), /is not a folder/);
});

test("moveTab opens a session, moves this tab, and closes the shell tab", async () => {
  const { worktree } = folders();
  const { calls, exec } = fakeExec();
  const moved = await moveTab({ target: worktree, exec });
  assert.deepEqual(moved, {
    sessionId: "session:new",
    sessionLabel: "repo-feature",
    followed: ["Air"],
    refused: [],
  });
  assert.deepEqual(
    calls.filter((call) => call[0] === "rex"),
    [
      ["rex", "whoami", "--json"],
      ["rex", "client", "ls", "-s", "session:old", "--json"],
      ["rex", "new", "repo-feature", "--cwd", worktree, "--json"],
      ["rex", "window", "move", "window:me", "--to", "session:new", "--focus"],
      ["rex", "window", "close", "-s", "session:new", "window:shell"],
      ["rex", "session", "inspect", "session:old", "--json"],
      [
        "rex",
        "-C",
        "client:air",
        "do",
        "session.select",
        "session_id=session:new",
        "window_id=window:me",
      ],
    ],
  );
});

test("moveTab reports a Rex app that refuses to follow the tab", async () => {
  const { worktree } = folders();
  const { exec } = fakeExec({
    select: { code: 1, stdout: "", stderr: "Error: Turn on Remote Control.\n" },
  });
  const moved = await moveTab({ target: worktree, exec });
  assert.deepEqual(moved.followed, []);
  assert.deepEqual(moved.refused, ["Air: Turn on Remote Control"]);
});

test("parseApps keeps only Rex apps", () => {
  assert.deepEqual(parseApps(JSON.stringify(APPS)), [{ id: "client:air", label: "Air" }]);
  assert.deepEqual(parseApps("not json"), []);
  assert.deepEqual(parseApps("{}"), []);
});

test("moveTab removes the old session when the move leaves it without tabs", async () => {
  const { worktree } = folders();
  const { calls, exec } = fakeExec({ oldWindows: null });
  await moveTab({ target: worktree, exec });
  assert.ok(calls.some((call) => call.join(" ") === "rex kill session:old"));
});

test("isEmptySession reads null and empty window lists", () => {
  assert.equal(isEmptySession('{"session_id":"s"}'), true);
  assert.equal(isEmptySession('{"session_id":"s","windows":null}'), true);
  assert.equal(isEmptySession('{"session_id":"s","windows":[]}'), true);
  assert.equal(isEmptySession('{"session_id":"s","windows":[{"window_id":"w"}]}'), false);
  assert.equal(isEmptySession("{}"), false);
  assert.equal(isEmptySession("not json"), false);
});

test("moveTab kills the new session when the move fails", async () => {
  const { worktree } = folders();
  const { calls, exec } = fakeExec({ move: { code: 1, stdout: "" } });
  await assert.rejects(moveTab({ target: worktree, exec }), /rex window move failed/);
  assert.deepEqual(calls.at(-1), ["rex", "kill", "session:new"]);
});

test("moveTab stops when rex new fails", async () => {
  const { worktree } = folders();
  const { calls, exec } = fakeExec({ created: { code: 1, stdout: "" } });
  await assert.rejects(moveTab({ target: worktree, exec }), /rex new failed/);
  assert.ok(!calls.some((call) => call[1] === "window"));
});

function register() {
  const tools: {
    name: string;
    exposure?: string;
    execute: (...args: unknown[]) => Promise<{ content: { text: string }[]; terminate?: boolean }>;
  }[] = [];
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const messages: { text: string; options: unknown }[] = [];
  const { calls, exec } = fakeExec();
  const pi = {
    registerTool: (tool: (typeof tools)[number]) => tools.push(tool),
    registerCommand: (name: string, command: { handler: () => Promise<void> }) =>
      commands.set(name, command),
    sendUserMessage: (text: string, options: unknown) => messages.push({ text, options }),
    exec: async (command: string, args: string[]) => ({
      ...(await exec(command, args)),
      stderr: "",
      killed: false,
    }),
  };
  registerWorktreeMove(pi as never);
  return { tools, commands, messages, calls };
}

test("the tool is for codemode and queues the switch command", async () => {
  const { repo, worktree } = folders();
  process.env.REX_BLOCK = "block:me";
  process.env.REX_SESSION = "session:old";
  const { tools, messages } = register();
  const tool = tools[0];
  assert.equal(tool?.exposure, "codemode");
  const result = await tool!.execute("id", { path: worktree }, undefined, undefined, {
    cwd: repo,
  });
  assert.equal(result.terminate, true);
  assert.match(result.content[0]?.text ?? "", /Pi switches to .*repo-feature when this turn ends/);
  assert.deepEqual(messages, [
    {
      text: `/${SWITCH_COMMAND} ${worktree}`,
      options: { deliverAs: "followUp", expandPromptTemplates: true },
    },
  ]);
  assert.equal(process.env.REX_SESSION, "session:new");
});

test("the tool refuses to run outside Rex", async () => {
  const { repo, worktree } = folders();
  const { tools, calls } = register();
  await assert.rejects(
    tools[0]!.execute("id", { path: worktree }, undefined, undefined, { cwd: repo }),
    /does not run in a Rex terminal/,
  );
  assert.equal(calls.length, 0);
});

test("the command forks the session and switches to it", async () => {
  const { repo, worktree } = folders();
  const { commands } = register();
  const source = path.join(repo, "session.jsonl");
  writeFileSync(
    source,
    `${JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: new Date().toISOString(), cwd: repo })}\n`,
  );
  const events: string[] = [];
  const sent: string[] = [];
  const ctx = {
    cwd: repo,
    ui: { notify: (message: string) => events.push(`notify ${message}`) },
    waitForIdle: async () => {
      events.push("idle");
    },
    sessionManager: { getSessionFile: () => source },
    switchSession: async (
      file: string,
      options: { withSession: (ctx: unknown) => Promise<void> },
    ) => {
      events.push(`switch ${path.extname(file)}`);
      await options.withSession({
        sendUserMessage: async (text: string) => {
          sent.push(text);
        },
      });
      return { cancelled: false };
    },
  };
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = path.join(path.dirname(repo), "agent");
  try {
    await commands.get(SWITCH_COMMAND)!.handler(worktree, ctx);
  } finally {
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;
  }
  assert.deepEqual(events, ["idle", "switch .jsonl"]);
  assert.equal(sent.length, 1);
  assert.match(sent[0] ?? "", /Pi now works in the worktree .*repo-feature/);
});
