import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ProgramStatus } from "@earendil-works/pi-tui";
import askUser from "../index.ts";

type RegisteredTool = {
  execute: (
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: unknown,
  ) => Promise<unknown>;
};

function registeredTool(): RegisteredTool {
  let tool: RegisteredTool | undefined;
  const pi = {
    registerTool: (definition: unknown) => {
      tool = definition as RegisteredTool;
    },
    events: { emit: () => {} },
    getSessionName: () => "fix-login",
  } as unknown as ExtensionAPI;
  askUser(pi);
  if (!tool) throw new Error("ask_user was not registered");
  return tool;
}

test("the TUI form reports blocked while open, then working again", async () => {
  const statuses: ProgramStatus[] = [];
  const tui = {
    requestRender: () => {},
    terminal: { setProgramStatus: (status: ProgramStatus) => statuses.push(status) },
  };
  const ctx = {
    mode: "tui",
    hasUI: true,
    ui: {
      custom: (factory: (...args: unknown[]) => unknown) =>
        new Promise((resolve) => {
          factory(tui, {}, {}, resolve);
          assert.deepEqual(statuses, [
            { state: "blocked", kind: "question", app: "pi", message: "Pick a color" },
          ]);
          resolve(null);
        }),
    },
  };

  await registeredTool().execute(
    "call-1",
    { questions: [{ question: "Pick a color", options: [{ label: "Red" }, { label: "Blue" }] }] },
    undefined,
    undefined,
    ctx,
  );

  assert.deepEqual(statuses, [
    { state: "blocked", kind: "question", app: "pi", message: "Pick a color" },
    { state: "working", app: "pi", message: "fix-login" },
  ]);
});
