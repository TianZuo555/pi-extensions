import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, test } from "node:test";
import type { ExecResult } from "../lib/naming.ts";
import {
  cleanPaneLabel,
  expandHome,
  isEmptySession,
  movePane,
  parseApps,
  paneLabel,
  parseNewSession,
  registerWorktreeMove,
  resolveTarget,
  SWITCH_COMMAND,
} from "../lib/worktree-move.ts";
import { parseWindowLayout } from "../lib/rex-output.ts";

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
    /** Panes in the tab of this pane. */
    myBlocks?: string[];
    paneMove?: ExecResult;
  } = {},
) {
  const calls: string[][] = [];
  const exec = async (command: string, args: string[]): Promise<ExecResult> => {
    calls.push([command, ...args]);
    if (command === "git") return { code: 1, stdout: "" };
    if (args[0] === "whoami") {
      return json({ session_id: "session:old", window_id: "window:me", block_id: "block:me" });
    }
    if (args[0] === "session" && args[1] === "inspect") {
      const mine = {
        window_id: "window:me",
        label: "task-tab",
        layers: [{ blocks: (overrides.myBlocks ?? ["block:me"]).map((id) => ({ block_id: id })) }],
      };
      const windows =
        "oldWindows" in overrides ? overrides.oldWindows : [mine, { window_id: "window:2" }];
      return json({ session_id: "session:old", label: "old", windows });
    }
    if (args[0] === "window" && args[1] === "new") {
      return json({ window_id: "window:park", block_ids: ["block:park"] });
    }
    if (args[0] === "move") return overrides.paneMove ?? ok;
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

test("expandHome expands a leading tilde only", () => {
  assert.equal(expandHome("~", "/home/me"), "/home/me");
  assert.equal(expandHome("~/work/repo", "/home/me"), path.join("/home/me", "work/repo"));
  assert.equal(expandHome("repo/~", "/home/me"), "repo/~");
  assert.equal(expandHome("~other/repo", "/home/me"), "~other/repo");
});

test("resolveTarget expands the home folder", () => {
  const home = realpathSync(os.homedir());
  assert.equal(resolveTarget("~", "/"), home);
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

test("movePane opens a session, moves this pane, and closes the shell tab", async () => {
  const { worktree } = folders();
  const { calls, exec } = fakeExec();
  const moved = await movePane({ target: worktree, exec });
  assert.deepEqual(moved, {
    sessionId: "session:new",
    sessionLabel: "repo-feature",
    paneLabel: "repo-feature",
    followed: ["Air"],
    refused: [],
  });
  assert.deepEqual(
    calls.filter((call) => call[0] === "rex"),
    [
      ["rex", "whoami", "--json"],
      ["rex", "client", "ls", "-s", "session:old", "--json"],
      ["rex", "session", "inspect", "session:old", "--json"],
      ["rex", "new", "repo-feature", "--cwd", worktree, "--json"],
      ["rex", "window", "move", "window:me", "--to", "session:new", "--focus"],
      ["rex", "window", "close", "-s", "session:new", "window:shell"],
      ["rex", "block", "rename", "-s", "session:new", "block:me", "repo-feature"],
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

test("movePane moves only this pane when the tab has other panes", async () => {
  const { worktree } = folders();
  const { calls, exec } = fakeExec({ myBlocks: ["block:me", "block:editor"] });
  await movePane({ target: worktree, exec });
  const rex = calls.filter((call) => call[0] === "rex").map((call) => call.slice(1).join(" "));
  const from = rex.indexOf(`new repo-feature --cwd ${worktree} --json`);
  assert.deepEqual(rex.slice(from + 1, from + 5), [
    "window new -s session:old task-tab --focus=false --json",
    "move -s session:old block:me right block:park",
    "block close -s session:old block:park",
    "window move window:park --to session:new --focus",
  ]);
  assert.ok(
    rex.includes("-C client:air do session.select session_id=session:new window_id=window:park"),
  );
  assert.ok(!rex.some((call) => call.includes("block:editor")), "the other pane stays");
});

test("movePane undoes the pane move when Rex refuses it", async () => {
  const { worktree } = folders();
  const { calls, exec } = fakeExec({
    myBlocks: ["block:me", "block:editor"],
    paneMove: { code: 1, stdout: "" },
  });
  await assert.rejects(movePane({ target: worktree, exec }), /rex move failed/);
  const rex = calls.filter((call) => call[0] === "rex").map((call) => call.slice(1).join(" "));
  assert.deepEqual(rex.slice(-2), ["window close -s session:old window:park", "kill session:new"]);
});

test("movePane names the pane after the feature", async () => {
  const { worktree } = folders();
  const { calls, exec } = fakeExec();
  const moved = await movePane({ target: worktree, exec, label: "  pin\n theme  " });
  assert.equal(moved.paneLabel, "pin theme");
  assert.ok(
    calls.some((call) => call.join(" ") === "rex block rename -s session:new block:me pin theme"),
  );
});

test("paneLabel falls back to the branch, then to the folder", async () => {
  const branch = async () => ({ code: 0, stdout: "feat/pin-theme\n" });
  assert.equal(await paneLabel(branch, "/w/repo-x"), "feat/pin-theme");
  assert.equal(await paneLabel(branch, "/w/repo-x", "dark mode"), "dark mode");
  const detached = async () => ({ code: 0, stdout: "\n" });
  assert.equal(await paneLabel(detached, "/w/repo-x"), "repo-x");
  assert.equal(cleanPaneLabel("x".repeat(60))?.length, 40);
  assert.equal(cleanPaneLabel("   "), undefined);
});

test("parseWindowLayout reads the panes of every layer", () => {
  const state = {
    windows: [
      {
        window_id: "window:me",
        label: "task",
        layers: [{ blocks: [{ block_id: "block:a" }] }, { blocks: [{ block_id: "block:b" }] }],
      },
    ],
  };
  assert.deepEqual(parseWindowLayout(JSON.stringify(state), "window:me"), {
    label: "task",
    blocks: ["block:a", "block:b"],
  });
  assert.equal(parseWindowLayout(JSON.stringify(state), "window:other"), undefined);
  assert.equal(parseWindowLayout("{}", "window:me"), undefined);
});

test("movePane reports a Rex app that refuses to follow the pane", async () => {
  const { worktree } = folders();
  const { exec } = fakeExec({
    select: { code: 1, stdout: "", stderr: "Error: Turn on Remote Control.\n" },
  });
  const moved = await movePane({ target: worktree, exec });
  assert.deepEqual(moved.followed, []);
  assert.deepEqual(moved.refused, ["Air: Turn on Remote Control"]);
});

test("parseApps keeps only Rex apps", () => {
  assert.deepEqual(parseApps(JSON.stringify(APPS)), [{ id: "client:air", label: "Air" }]);
  assert.deepEqual(parseApps("not json"), []);
  assert.deepEqual(parseApps("{}"), []);
});

test("movePane removes the old session when the move leaves it without tabs", async () => {
  const { worktree } = folders();
  const { calls, exec } = fakeExec({ oldWindows: null });
  await movePane({ target: worktree, exec });
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

test("movePane kills the new session when the move fails", async () => {
  const { worktree } = folders();
  const { calls, exec } = fakeExec({ move: { code: 1, stdout: "" } });
  await assert.rejects(movePane({ target: worktree, exec }), /rex window move failed/);
  assert.deepEqual(calls.at(-1), ["rex", "kill", "session:new"]);
});

test("movePane stops when rex new fails", async () => {
  const { worktree } = folders();
  const { calls, exec } = fakeExec({ created: { code: 1, stdout: "" } });
  await assert.rejects(movePane({ target: worktree, exec }), /rex new failed/);
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

/** Run the switch command with a fake pi context. */
async function runSwitch(result: { cancelled: boolean } | Error) {
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
      // The new runtime and its extensions start in the worktree.
      events.push(`switch ${path.extname(file)} in ${process.cwd()}`);
      if (result instanceof Error) throw result;
      if (!result.cancelled) {
        await options.withSession({
          sendUserMessage: async (text: string) => {
            sent.push(text);
          },
        });
      }
      return result;
    },
  };
  const before = {
    cwd: process.cwd(),
    pwd: process.env.PWD,
    agent: process.env.PI_CODING_AGENT_DIR,
  };
  process.env.PI_CODING_AGENT_DIR = path.join(path.dirname(repo), "agent");
  process.chdir(repo);
  let after = { cwd: "", pwd: "" as string | undefined };
  let error: unknown;
  try {
    await commands.get(SWITCH_COMMAND)!.handler(worktree, ctx);
  } catch (caught) {
    error = caught;
  } finally {
    after = { cwd: process.cwd(), pwd: process.env.PWD };
    process.chdir(before.cwd);
    if (before.pwd === undefined) delete process.env.PWD;
    else process.env.PWD = before.pwd;
    if (before.agent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = before.agent;
  }
  return { repo, worktree, events, sent, after, error };
}

test("the command forks the session and switches pi and the process to it", async () => {
  const { worktree, events, sent, after } = await runSwitch({ cancelled: false });
  assert.deepEqual(events, ["idle", `switch .jsonl in ${worktree}`]);
  assert.equal(sent.length, 1);
  assert.match(sent[0] ?? "", /Pi now works in the worktree .*repo-feature/);
  assert.deepEqual(after, { cwd: worktree, pwd: worktree });
});

test("a cancelled switch keeps the process in the old folder", async () => {
  const { repo, sent, after } = await runSwitch({ cancelled: true });
  assert.equal(sent.length, 0);
  assert.equal(after.cwd, repo);
  assert.equal(after.pwd, repo);
});

test("a failed switch keeps the process in the old folder", async () => {
  const { repo, after, error } = await runSwitch(new Error("boom"));
  assert.match(String(error), /boom/);
  assert.equal(after.cwd, repo);
});
