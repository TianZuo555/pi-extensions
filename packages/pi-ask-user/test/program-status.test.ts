import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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

test("the TUI form reports blocked through ctx.ui.custom while open", async () => {
  const tui = { requestRender: () => {}, terminal: {} };
  let customOptions: unknown;
  const ctx = {
    mode: "tui",
    hasUI: true,
    ui: {
      custom: (factory: (...args: unknown[]) => unknown, options?: unknown) => {
        customOptions = options;
        return new Promise((resolve) => {
          factory(tui, {}, {}, resolve);
          resolve(null);
        });
      },
    },
  };

  await registeredTool().execute(
    "call-1",
    { questions: [{ question: "Pick a color", options: [{ label: "Red" }, { label: "Blue" }] }] },
    undefined,
    undefined,
    ctx,
  );

  assert.deepEqual(customOptions, {
    blocked: { kind: "question", message: "Pick a color" },
  });
});
