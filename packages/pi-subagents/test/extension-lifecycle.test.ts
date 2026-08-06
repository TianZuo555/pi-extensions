import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import subagentsExtension from "../index.ts";

function mockExtensionApi() {
  const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
  let agentsHandler: ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;

  const api = {
    on(event: string, handler: (...args: unknown[]) => unknown) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool() {},
    registerMessageRenderer() {},
    registerCommand(name: string, spec: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) {
      if (name === "agents") agentsHandler = spec.handler;
    },
    sendMessage() {
      return true;
    },
  } as unknown as ExtensionAPI;

  return {
    api,
    async sessionStart(ctx: ExtensionContext) {
      for (const handler of handlers.get("session_start") ?? []) {
        await handler({}, ctx);
      }
    },
    async sessionShutdown() {
      for (const handler of handlers.get("session_shutdown") ?? []) {
        await handler();
      }
    },
    agentsHandler: () => agentsHandler,
  };
}

function mockContext(cwd: string): ExtensionContext {
  return {
    cwd,
    hasUI: false,
    mode: "rpc",
    isProjectTrusted: () => true,
    model: { provider: "openai", id: "gpt-4.1-mini" } as ExtensionContext["model"],
    ui: {
      notify: () => {},
      confirm: async () => false,
      editor: async () => undefined,
      select: async () => undefined,
      setStatus: () => {},
      setWidget: () => {},
      pasteToEditor: () => {},
      custom: async () => ({ status: "error", error: new Error("unsupported") }),
    },
  } as unknown as ExtensionContext;
}

test("subagentsExtension isolates session lifecycle across two extension instances", async () => {
  const first = mockExtensionApi();
  const second = mockExtensionApi();
  subagentsExtension(first.api);
  subagentsExtension(second.api);

  const ctx1 = mockContext(process.cwd());
  const ctx2 = mockContext(process.cwd());
  await first.sessionStart(ctx1);
  await second.sessionStart(ctx2);

  await first.sessionShutdown();

  const agents2 = second.agentsHandler();
  assert.ok(agents2, "second instance should register /agents");
  await assert.doesNotReject(() => agents2!("", ctx2));

  await second.sessionShutdown();
});

test("subagentsExtension shutdown only clears its own session state", async () => {
  const first = mockExtensionApi();
  const second = mockExtensionApi();
  subagentsExtension(first.api);
  subagentsExtension(second.api);

  await first.sessionStart(mockContext(process.cwd()));
  await second.sessionStart(mockContext(process.cwd()));

  await first.sessionShutdown();

  const agents2 = second.agentsHandler();
  assert.ok(agents2);
  await assert.doesNotReject(() => agents2!("", mockContext(process.cwd())));

  await second.sessionShutdown();
});
