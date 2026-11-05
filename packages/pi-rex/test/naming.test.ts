import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isGeneratedSessionLabel,
  isGeneratedWindowLabel,
  MAX_TASK_LENGTH,
  nameSession,
  parseLabel,
  type ExecResult,
} from "../lib/naming.ts";

const SESSION = "session:01";
const WINDOW = "window:02";

const ok: ExecResult = { code: 0, stdout: "" };
const json = (value: unknown): ExecResult => ({ ...ok, stdout: JSON.stringify(value) });

type Call = { command: string; args: string[] };

function setup(
  options: {
    whoami?: ExecResult;
    inspect?: ExecResult;
    state?: { label: string; windows: { window_id: string; label?: string }[] };
    label?: string;
    ask?: (prompt: string) => Promise<string>;
  } = {},
) {
  const calls: Call[] = [];
  const prompts: string[] = [];
  const exec = async (command: string, args: string[]): Promise<ExecResult> => {
    calls.push({ command, args });
    if (args[0] === "whoami") return options.whoami ?? json({ window_id: WINDOW });
    if (args[0] === "session" && args[1] === "inspect") {
      return (
        options.inspect ??
        json(
          options.state ?? {
            label: options.label ?? "shy-strait",
            windows: [{ window_id: WINDOW, label: "Window 0bbb" }],
          },
        )
      );
    }
    return ok;
  };
  const ask = async (prompt: string): Promise<string> => {
    prompts.push(prompt);
    return options.ask ? options.ask(prompt) : "fix-login-redirect";
  };
  return { calls, prompts, exec, ask };
}

function run(deps: ReturnType<typeof setup>, task = "fix the login redirect"): Promise<void> {
  return nameSession({
    session: SESSION,
    cwd: "/repo",
    task,
    exec: deps.exec,
    ask: deps.ask,
  });
}

test("parseLabel accepts one plain label", () => {
  assert.equal(parseLabel("fix-login-redirect"), "fix-login-redirect");
  assert.equal(parseLabel("  Fix-Login-Redirect  \n"), "fix-login-redirect");
});

test("parseLabel accepts a fenced or quoted reply", () => {
  assert.equal(parseLabel("```text\nfix-login\n```"), "fix-login");
  assert.equal(parseLabel("`fix-login`"), "fix-login");
  assert.equal(parseLabel('"fix-login"'), "fix-login");
  assert.equal(parseLabel("Label: fix-login"), "fix-login");
});

test("parseLabel rejects a reply that is not one label", () => {
  assert.equal(parseLabel(""), undefined);
  assert.equal(parseLabel("fix the login redirect"), undefined);
  assert.equal(parseLabel("fix_login"), undefined);
  assert.equal(parseLabel("fix-login-redirect-now-please"), undefined);
  assert.equal(parseLabel("修复登录跳转"), undefined);
  assert.equal(parseLabel("a".repeat(41)), undefined);
});

test("generated labels are told apart from hand-set labels", () => {
  assert.equal(isGeneratedSessionLabel("shy-strait"), true);
  assert.equal(isGeneratedSessionLabel("fix-login-redirect"), false);
  assert.equal(isGeneratedSessionLabel("Window 0bbb"), false);
  assert.equal(isGeneratedWindowLabel("Window 629d2113"), true);
  assert.equal(isGeneratedWindowLabel("Tests"), false);
});

test("the first tab renames the session and its own tab", async () => {
  const deps = setup();
  await run(deps);
  assert.deepEqual(
    deps.calls.map((call) => call.args),
    [
      ["whoami", "--json"],
      ["session", "inspect", SESSION, "--json"],
      ["session", "rename", SESSION, "fix-login-redirect"],
      ["window", "rename", "-s", SESSION, WINDOW, "fix-login-redirect"],
    ],
  );
  assert.ok(deps.prompts[0]?.includes("fix the login redirect"), deps.prompts[0]);
});

test("a later tab renames only itself", async () => {
  const deps = setup({
    inspect: json({
      label: "shy-strait",
      windows: [
        { window_id: "window:01", label: "Window 0aaa" },
        { window_id: "window:03", label: "Window 0ccc" },
        { window_id: WINDOW, label: "Window 0bbb" },
      ],
    }),
  });
  await run(deps);
  assert.deepEqual(
    deps.calls
      .filter((call) => call.args[0] !== "whoami" && call.args[0] !== "session")
      .map((call) => call.args),
    [["window", "rename", "-s", SESSION, WINDOW, "fix-login-redirect"]],
  );
});

test("a hand-set session label is kept", async () => {
  const deps = setup({ label: "fix-login-redirect" });
  await run(deps);
  assert.ok(!deps.calls.some((call) => call.args[0] === "session" && call.args[1] === "rename"));
  assert.ok(deps.calls.some((call) => call.args[0] === "window" && call.args[1] === "rename"));
});

test("a hand-set tab label is kept", async () => {
  const deps = setup({
    inspect: json({
      label: "shy-strait",
      windows: [{ window_id: WINDOW, label: "Tests" }],
    }),
  });
  await run(deps);
  assert.ok(deps.calls.some((call) => call.args[0] === "session" && call.args[1] === "rename"));
  assert.ok(!deps.calls.some((call) => call.args[0] === "window" && call.args[1] === "rename"));
});

test("does nothing when whoami fails", async () => {
  const deps = setup({ whoami: { code: 1, stdout: "not json" } });
  await run(deps);
  assert.equal(deps.calls.length, 1);
  assert.equal(deps.prompts.length, 0);
});

test("does nothing when the session lookup fails", async () => {
  const deps = setup({ inspect: { code: 1, stdout: "" } });
  await run(deps);
  assert.equal(deps.prompts.length, 1);
  assert.equal(deps.calls.length, 2);
});

test("does nothing when the current window is not in the session", async () => {
  const deps = setup({
    inspect: json({
      label: "shy-strait",
      windows: [{ window_id: "window:01", label: "Window 0aaa" }],
    }),
  });
  await run(deps);
  assert.equal(deps.prompts.length, 1);
});

test("keeps labels set while the model runs", async () => {
  const state = { label: "shy-strait", windows: [{ window_id: WINDOW, label: "Window 0bbb" }] };
  const deps = setup({
    state,
    ask: async () => {
      state.label = "user-picked-label";
      state.windows[0]!.label = "user-picked-tab";
      return "fix-login-redirect";
    },
  });
  await run(deps);
  assert.ok(!deps.calls.some((call) => call.args[0] === "session" && call.args[1] === "rename"));
  assert.ok(!deps.calls.some((call) => call.args[0] === "window" && call.args[1] === "rename"));
});

test("does nothing when the model fails", async () => {
  const deps = setup({
    ask: async () => {
      throw new Error("boom");
    },
  });
  await run(deps);
  assert.ok(!deps.calls.some((call) => call.args[0] === "session" && call.args[1] === "rename"));
});

test("does nothing when the model reply is not a label", async () => {
  const deps = setup({ ask: async () => "Fix the login redirect!" });
  await run(deps);
  assert.ok(!deps.calls.some((call) => call.args[0] === "session" && call.args[1] === "rename"));
});

test("trims the task before it asks the model", async () => {
  const deps = setup();
  const task = `start ${"x".repeat(MAX_TASK_LENGTH * 2)} end`;
  await run(deps, task);
  assert.ok(deps.prompts[0]?.includes("start xxx"), deps.prompts[0]);
  assert.ok(!deps.prompts[0]?.includes(" end"), deps.prompts[0]);
});
