import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, test } from "node:test";
import { AUTO_NAME_INSTRUCTION } from "../lib/prompt.ts";
import rexExtension from "../index.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;
type ExecResult = { stdout: string; stderr: string; code: number; killed: boolean };

// The TUI tests run the legacy resume cleanup. Keep it out of the real home.
const sandbox = mkdtempSync(path.join(os.tmpdir(), "pi-rex-index-"));
process.env.HOME = sandbox;
process.env.XDG_CONFIG_HOME = path.join(sandbox, ".config");
process.env.ZDOTDIR = sandbox;
process.env.PI_CODING_AGENT_DIR = path.join(sandbox, "agent");

const ok: ExecResult = { stdout: "", stderr: "", code: 0, killed: false };
const json = (value: unknown): ExecResult => ({ ...ok, stdout: JSON.stringify(value) });

const REX_TEXT = `You're running in a Rex terminal.

\`\`\`text
REX_SESSION=session:01
\`\`\`

Use the \`rex\` command to create sessions, open tabs, split panes, run commands,
and read terminal output.

Name the session as part of handling the first request that identifies the work.
Run \`rex session rename "$REX_SESSION" <label>\` without waiting for the user to
ask and before loading the skill.`;

const REX_START = { ...ok, stdout: REX_TEXT };

const INSPECT = {
  label: "shy-strait",
  windows: [{ window_id: "window:02", label: "Window 0bbb" }],
};

function setup(
  options: { settings?: unknown; reply?: string; start?: ExecResult; mode?: string } = {},
) {
  const handlers = new Map<string, Handler[]>();
  const calls: { command: string; args: string[]; options: unknown }[] = [];
  const prompts: string[] = [];
  const notices: string[] = [];
  const tools: string[] = [];
  const commands: string[] = [];
  const pi = {
    on: (name: string, handler: Handler) =>
      handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    exec: async (command: string, args: string[], execOptions: unknown) => {
      calls.push({ command, args, options: execOptions });
      if (args[0] === "__internal") return options.start ?? REX_START;
      if (args[0] === "whoami") return json({ window_id: "window:02" });
      if (args[0] === "session" && args[1] === "inspect") return json(INSPECT);
      return ok;
    },
    getSettings: () => options.settings ?? {},
    registerTool: (tool: { name: string }) => tools.push(tool.name),
    registerCommand: (name: string) => commands.push(name),
    sendUserMessage: () => undefined,
  };
  const ctx = {
    cwd: "/repo",
    mode: options.mode ?? "print",
    sessionManager: { getSessionName: () => "Test session" },
    ui: { notify: (message: string) => notices.push(message) },
    model: { provider: "fake", id: "fake-model" },
    signal: undefined,
    modelRegistry: {
      complete: async (
        _model: unknown,
        context: { messages: { content: { text: string }[] }[] },
      ) => {
        prompts.push(context.messages[0]?.content[0]?.text ?? "");
        return {
          stopReason: "stop",
          content: [{ type: "text", text: options.reply ?? "fix-login-redirect" }],
        };
      },
    },
  };
  rexExtension(pi as never);
  // Run every handler for the event, as pi does. Synchronous handlers finish
  // before fire returns.
  const fire = (name: string, event: unknown, context: unknown = ctx) =>
    Promise.all((handlers.get(name) ?? []).map((handler) => handler(event, context)));
  const start = () => fire("session_start", { type: "session_start" });
  const prompt = (text: string) =>
    fire("before_agent_start", {
      type: "before_agent_start",
      messageType: "user",
      prompt: text,
      systemPrompt: "",
      systemPromptOptions: { sections: {} as Record<string, string> },
    });
  const emit = (event: unknown) => fire("before_agent_start", event);
  const sections = () => {
    const event = { systemPromptOptions: { sections: {} as Record<string, string> } };
    fire("before_agent_start", {
      type: "before_agent_start",
      messageType: "user",
      prompt: "",
      systemPrompt: "",
      systemPromptOptions: event.systemPromptOptions,
    });
    return event.systemPromptOptions.sections;
  };
  return { calls, notices, prompts, tools, commands, fire, start, prompt, emit, sections };
}

/** Wait until the background naming work made a rename call. */
async function waitForRename(calls: { args: string[] }[]): Promise<void> {
  const start = Date.now();
  while (!calls.some((call) => call.args[0] === "window" && call.args[1] === "rename")) {
    if (Date.now() - start > 1000) throw new Error("naming did not run");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

beforeEach(() => {
  delete process.env.REX_SESSION;
  delete process.env.REX_BLOCK;
});

test("adds the Rex output and replaces the naming paragraph", async () => {
  process.env.REX_SESSION = "s1";
  const { calls, start, sections } = setup();
  await start();
  assert.deepEqual(calls[0], {
    command: "rex",
    args: ["__internal", "session-start", "--agent", "pi"],
    options: { cwd: "/repo", timeout: 5000 },
  });
  const section = sections().rex ?? "";
  assert.ok(section.includes("You're running in a Rex terminal."), section);
  assert.ok(!section.includes("Name the session as part of"), section);
  assert.ok(section.endsWith(AUTO_NAME_INSTRUCTION), section);
});

test("does nothing outside a Rex terminal", async () => {
  const { calls, start, sections } = setup();
  await start();
  assert.equal(calls.length, 0);
  assert.deepEqual(sections(), {});
});

test("warns and adds no section when the rex command fails", async () => {
  process.env.REX_SESSION = "s1";
  const { notices, start, sections } = setup({
    start: { ...ok, stderr: "boom", code: 1 },
  });
  await start();
  assert.deepEqual(notices, ["rex session-start failed (exit 1): boom"]);
  assert.deepEqual(sections(), {});
});

test("keeps the Rex text when rex.autoName is false", async () => {
  process.env.REX_SESSION = "s1";
  const { start, sections } = setup({ settings: { rex: { autoName: false } } });
  await start();
  assert.deepEqual(sections(), { rex: REX_TEXT });
});

test("keeps auto naming on when the rex setting is not an object", async () => {
  process.env.REX_SESSION = "s1";
  const { start, sections } = setup({ settings: { rex: "on" } });
  await start();
  assert.ok((sections().rex ?? "").includes(AUTO_NAME_INSTRUCTION));
});

test("adds no section when the rex command prints nothing", async () => {
  process.env.REX_SESSION = "s1";
  const { calls, start, sections } = setup({ start: { ...ok, stdout: "  \n" } });
  await start();
  assert.equal(calls.length, 1);
  assert.deepEqual(sections(), {});
});

test("names the session from the folder and the tab on the first prompt", async () => {
  process.env.REX_SESSION = "s1";
  const { calls, prompts, start, prompt } = setup();
  await start();
  prompt("fix the login redirect");
  await waitForRename(calls);
  assert.ok(prompts[0]?.includes("fix the login redirect"), prompts[0]);
  const renames = calls.filter(
    (call) => call.command === "rex" && call.args[0] !== "__internal" && call.args[0] !== "whoami",
  );
  assert.deepEqual(
    renames.map((call) => call.args),
    [
      ["session", "inspect", "s1", "--json"],
      ["session", "rename", "s1", "repo"],
      ["window", "rename", "-s", "s1", "window:02", "fix-login-redirect"],
    ],
  );
});

test("uses the full block ID for context and naming in a current Rex pane", async () => {
  const block = "block:01a1-test";
  process.env.REX_BLOCK = block;
  const { calls, start, prompt, sections } = setup();
  await start();
  assert.ok(sections().rex?.includes(AUTO_NAME_INSTRUCTION));
  await prompt("fix the login redirect");
  await waitForRename(calls);
  assert.deepEqual(
    calls.slice(-3).map((call) => call.args),
    [
      ["session", "inspect", block, "--json"],
      ["session", "rename", block, "repo"],
      ["window", "rename", "-s", block, "window:02", "fix-login-redirect"],
    ],
  );
});

test("reports a run with a dialog and settles without reading a stale context", async (t) => {
  process.env.REX_SESSION = "s1";
  const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
  const programStatus = process.env.PI_PROGRAM_STATUS;
  delete process.env.PI_PROGRAM_STATUS;
  t.after(() => {
    if (tty) Object.defineProperty(process.stdout, "isTTY", tty);
    else Reflect.deleteProperty(process.stdout, "isTTY");
    if (programStatus !== undefined) process.env.PI_PROGRAM_STATUS = programStatus;
  });
  const reports: string[] = [];
  t.mock.method(process.stdout, "write", (data: string) => {
    reports.push(data);
    return true;
  });
  const { fire, start, emit } = setup({ mode: "tui", settings: { rex: { autoName: false } } });
  await start();
  await emit({ messageType: "custom", systemPromptOptions: { sections: {} } });
  await fire("ui_prompt_start", {});
  await fire("ui_prompt_end", {});
  const staleContext = {
    get sessionManager(): never {
      throw new Error("stale Pi context");
    },
  };
  await fire("agent_settled", { aborted: false }, staleContext);
  await fire("session_shutdown", { reason: "reload" });
  await fire("agent_settled", { aborted: false }, staleContext);
  const states = reports.map((report) => report.match(/state=(\w+)/)?.[1]);
  assert.deepEqual(states, ["working", "clear", "working", "done", "clear"]);
  assert.match(reports[3] ?? "", /id=pi-prompt:app=pi:msg=VGVzdCBzZXNzaW9u/);
});

test("names only once per pi session", async () => {
  process.env.REX_SESSION = "s1";
  const { calls, prompts, start, prompt } = setup();
  await start();
  prompt("fix the login redirect");
  await waitForRename(calls);
  prompt("do something else");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(prompts.length, 1);
});

test("renames only the tab when the model reply is not a label", async () => {
  process.env.REX_SESSION = "s1";
  const { calls, start, prompt } = setup({ reply: "Fix the login redirect!" });
  await start();
  prompt("fix the login redirect");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(calls.some((call) => call.args[0] === "session" && call.args[1] === "rename"));
  assert.ok(!calls.some((call) => call.args[0] === "window" && call.args[1] === "rename"));
});

test("skips naming for custom messages", async () => {
  process.env.REX_SESSION = "s1";
  const { prompts, start, emit } = setup();
  await start();
  emit({
    type: "before_agent_start",
    messageType: "custom",
    message: { content: "hello" },
    systemPrompt: "",
    systemPromptOptions: { sections: {} },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(prompts.length, 0);
});

test("skips naming when rex.autoName is false", async () => {
  process.env.REX_SESSION = "s1";
  const { prompts, start, prompt } = setup({ settings: { rex: { autoName: false } } });
  await start();
  prompt("fix the login redirect");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(prompts.length, 0);
});

test("registers one tool and its switch command", () => {
  const { tools, commands } = setup();
  assert.deepEqual(tools, ["rex_worktree_move"]);
  assert.deepEqual(commands, ["rex-worktree-switch"]);
});

test("removes the old resume hook once, in the TUI only", async () => {
  process.env.REX_SESSION = "s1";
  const fish = path.join(sandbox, ".config", "fish", "conf.d", "rex-resume.fish");
  const records = path.join(sandbox, "agent", "rex-resume");
  mkdirSync(path.dirname(fish), { recursive: true });
  mkdirSync(records, { recursive: true });
  writeFileSync(fish, "# Generated by @tian.zuo/pi-rex. Edit or delete this file.\n");
  writeFileSync(path.join(records, "01a1"), "/repo\npi\n");

  await setup({ mode: "print" }).start();
  assert.ok(existsSync(fish), "a print run changes no file");

  const { notices, start } = setup({ mode: "tui", settings: { rex: { autoName: false } } });
  await start();
  assert.ok(!existsSync(fish));
  assert.ok(!existsSync(records));
  assert.deepEqual(notices, [`pi-rex: removed the old resume hook from ${fish}`]);
});
