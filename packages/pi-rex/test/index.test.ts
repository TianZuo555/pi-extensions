import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import rexExtension from "../index.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;
type ExecResult = { stdout: string; stderr: string; code: number; killed: boolean };

function setup(result: ExecResult) {
  const handlers = new Map<string, Handler>();
  const calls: { command: string; args: string[]; options: unknown }[] = [];
  const notices: string[] = [];
  const pi = {
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    exec: async (command: string, args: string[], options: unknown) => {
      calls.push({ command, args, options });
      return result;
    },
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

const ok = { stdout: "You're running in a Rex terminal.\n", stderr: "", code: 0, killed: false };

afterEach(() => {
  delete process.env.REX_SESSION;
});

test("adds the Rex session-start output as a system prompt section", async () => {
  process.env.REX_SESSION = "s1";
  const { calls, start, sections } = setup(ok);
  await start();
  assert.deepEqual(calls, [
    {
      command: "rex",
      args: ["__internal", "session-start", "--agent", "pi"],
      options: { cwd: "/repo", timeout: 5000 },
    },
  ]);
  assert.deepEqual(sections(), { rex: "You're running in a Rex terminal." });
});

test("does nothing outside a Rex terminal", async () => {
  const { calls, start, sections } = setup(ok);
  await start();
  assert.equal(calls.length, 0);
  assert.deepEqual(sections(), {});
});

test("warns and adds no section when the rex command fails", async () => {
  process.env.REX_SESSION = "s1";
  const { notices, start, sections } = setup({
    stdout: "",
    stderr: "boom",
    code: 1,
    killed: false,
  });
  await start();
  assert.deepEqual(sections(), {});
  assert.deepEqual(notices, ["rex session-start failed (exit 1): boom"]);
});
