import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { KEEP_SESSION_INSTRUCTION, TAB_RENAME_INSTRUCTION } from "../lib/prompt.ts";
import { countWindows, stripSessionNaming } from "../lib/rex-output.ts";
import rexExtension from "../index.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;
type ExecResult = { stdout: string; stderr: string; code: number; killed: boolean };

const ok = { stdout: "You're running in a Rex terminal.\n", stderr: "", code: 0, killed: false };

const REX_TEXT = `You're running in a Rex terminal.

\`\`\`text
REX_SESSION=session:01
\`\`\`

Use the \`rex\` command to create sessions, open tabs, split panes, run commands,
and read terminal output.

Name the session as part of handling the first request that identifies the work.
Run \`rex session rename "$REX_SESSION" <label>\` without waiting for the user to
ask and before loading the skill.`;

const REX_NAMING = "Name the session as part of handling the first request";

const inspect = (windows: number) => ({
  stdout: JSON.stringify({
    label: "locked-parent",
    windows: Array.from({ length: windows }, (_, i) => ({ window_id: `w${i}` })),
  }),
  stderr: "",
  code: 0,
  killed: false,
});

function setup(options: { start?: ExecResult; inspect?: ExecResult; settings?: unknown } = {}) {
  const handlers = new Map<string, Handler>();
  const calls: { command: string; args: string[]; options: unknown }[] = [];
  const notices: string[] = [];
  const pi = {
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    exec: async (command: string, args: string[], execOptions: unknown) => {
      calls.push({ command, args, options: execOptions });
      if (args[0] === "session") return options.inspect ?? inspect(1);
      return options.start ?? ok;
    },
    getSettings: () => options.settings ?? {},
  };
  rexExtension(pi as never);
  const ctx = { cwd: "/repo", ui: { notify: (message: string) => notices.push(message) } };
  const start = () => handlers.get("session_start")?.({ type: "session_start" }, ctx);
  const sections = () => {
    const event = { systemPromptOptions: { sections: {} as Record<string, string> } };
    handlers.get("before_agent_start")?.(event, ctx);
    return event.systemPromptOptions.sections;
  };
  return { calls, notices, start, sections };
}

afterEach(() => {
  delete process.env.REX_SESSION;
});

test("adds the Rex session-start output as a system prompt section", async () => {
  process.env.REX_SESSION = "s1";
  const { calls, start, sections } = setup();
  await start();
  assert.deepEqual(calls[0], {
    command: "rex",
    args: ["__internal", "session-start", "--agent", "pi"],
    options: { cwd: "/repo", timeout: 5000 },
  });
  assert.deepEqual(calls[1], {
    command: "rex",
    args: ["session", "inspect", "s1", "--json"],
    options: { cwd: "/repo", timeout: 5000 },
  });
  assert.deepEqual(sections(), { rex: "You're running in a Rex terminal." });
});

test("does nothing outside a Rex terminal", async () => {
  const { calls, start, sections } = setup();
  await start();
  assert.equal(calls.length, 0);
  assert.deepEqual(sections(), {});
});

test("warns and adds no section when the rex command fails", async () => {
  process.env.REX_SESSION = "s1";
  const { calls, notices, start, sections } = setup({
    start: { stdout: "", stderr: "boom", code: 1, killed: false },
  });
  await start();
  assert.equal(calls.length, 1);
  assert.deepEqual(sections(), {});
  assert.deepEqual(notices, ["rex session-start failed (exit 1): boom"]);
});

test("keeps tab naming off by default", async () => {
  process.env.REX_SESSION = "s1";
  const { start, sections } = setup();
  await start();
  assert.deepEqual(sections(), { rex: "You're running in a Rex terminal." });
});

test("keeps tab naming off when rex.renameTab is false", async () => {
  process.env.REX_SESSION = "s1";
  const { start, sections } = setup({ settings: { rex: { renameTab: false } } });
  await start();
  assert.deepEqual(sections(), { rex: "You're running in a Rex terminal." });
});

test("appends the tab rename instruction when rex.renameTab is true", async () => {
  process.env.REX_SESSION = "s1";
  const { start, sections } = setup({ settings: { rex: { renameTab: true } } });
  await start();
  assert.deepEqual(sections(), {
    rex: `You're running in a Rex terminal.\n\n${TAB_RENAME_INSTRUCTION}`,
  });
});

test("ignores a rex setting that is not an object", async () => {
  process.env.REX_SESSION = "s1";
  const { start, sections } = setup({ settings: { rex: "on" } });
  await start();
  assert.deepEqual(sections(), { rex: "You're running in a Rex terminal." });
});

test("adds no section when the rex command prints nothing", async () => {
  process.env.REX_SESSION = "s1";
  const { calls, start, sections } = setup({
    start: { stdout: "  \n", stderr: "", code: 0, killed: false },
  });
  await start();
  assert.equal(calls.length, 1);
  assert.deepEqual(sections(), {});
});

test("drops the session-naming paragraph when the session has more than one tab", async () => {
  process.env.REX_SESSION = "s1";
  const { start, sections } = setup({
    start: { ...ok, stdout: REX_TEXT },
    inspect: inspect(2),
  });
  await start();
  const section = sections().rex ?? "";
  assert.ok(!section.includes(REX_NAMING), section);
  assert.ok(section.includes("Use the `rex` command"), section);
  assert.ok(section.endsWith(KEEP_SESSION_INSTRUCTION), section);
});

test("keeps the session-naming paragraph for the only tab of a session", async () => {
  process.env.REX_SESSION = "s1";
  const { start, sections } = setup({ start: { ...ok, stdout: REX_TEXT } });
  await start();
  const section = sections().rex ?? "";
  assert.ok(section.includes("rex session rename"), section);
  assert.ok(!section.includes(KEEP_SESSION_INSTRUCTION), section);
});

test("keeps the session label and names the tab when both apply", async () => {
  process.env.REX_SESSION = "s1";
  const { start, sections } = setup({
    start: { ...ok, stdout: REX_TEXT },
    inspect: inspect(3),
    settings: { rex: { renameTab: true } },
  });
  await start();
  const section = sections().rex ?? "";
  assert.ok(!section.includes(REX_NAMING), section);
  assert.ok(section.includes(KEEP_SESSION_INSTRUCTION), section);
  assert.ok(section.includes(TAB_RENAME_INSTRUCTION), section);
});

test("keeps the Rex text when the session lookup fails", async () => {
  process.env.REX_SESSION = "s1";
  const { start, sections } = setup({
    start: { ...ok, stdout: REX_TEXT },
    inspect: { stdout: "", stderr: "no server", code: 1, killed: false },
  });
  await start();
  const section = sections().rex ?? "";
  assert.ok(section.includes("rex session rename"), section);
  assert.deepEqual(sections(), { rex: REX_TEXT });
});

test("keeps the Rex text when the session lookup returns no JSON", async () => {
  process.env.REX_SESSION = "s1";
  const { start, sections } = setup({
    start: { ...ok, stdout: REX_TEXT },
    inspect: { stdout: "not json", stderr: "", code: 0, killed: false },
  });
  await start();
  assert.deepEqual(sections(), { rex: REX_TEXT });
});

test("stripSessionNaming drops only the paragraph with the rename command", () => {
  assert.equal(
    stripSessionNaming(REX_TEXT),
    `You're running in a Rex terminal.

\`\`\`text
REX_SESSION=session:01
\`\`\`

Use the \`rex\` command to create sessions, open tabs, split panes, run commands,
and read terminal output.`,
  );
});

test("countWindows reads the window list", () => {
  assert.equal(countWindows(JSON.stringify({ windows: [{}, {}] })), 2);
  assert.equal(countWindows(JSON.stringify({ windows: [] })), 0);
  assert.equal(countWindows(JSON.stringify({ label: "x" })), undefined);
  assert.equal(countWindows("not json"), undefined);
  assert.equal(countWindows("null"), undefined);
});
