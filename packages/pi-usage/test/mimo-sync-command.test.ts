import assert from "node:assert/strict";
import test from "node:test";
import usageExtension from "../index.ts";

test("MiMo browser sync explains cookie access and requires confirmation", async () => {
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
  const events = new Map<string, (event: unknown, ctx: any) => Promise<void> | void>();
  usageExtension({
    registerCommand: (name: string, command: any) => {
      commands.set(name, command);
    },
    on: (name: string, handler: any) => {
      events.set(name, handler);
    },
  } as any);
  const messages: string[] = [];
  const ctx = {
    hasUI: true,
    modelRegistry: { getProviderAuthStatus: () => ({ configured: true }) },
    ui: {
      notify: (message: string) => {
        messages.push(message);
      },
      confirm: async (title: string, explanation: string) => {
        messages.push(title, explanation);
        return false;
      },
      setStatus: () => {},
    },
  };
  await commands.get("usage-mimo-sync")!.handler("", ctx);
  assert.match(
    messages.join(" "),
    /Xiaomi does not provide a balance API that accepts your model API key/,
  );
  assert.match(messages.join(" "), /Continue\?/);
  assert.equal(messages.length, 2);
  await events.get("session_shutdown")!({}, ctx);
});
