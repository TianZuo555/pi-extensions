import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runDevinTasksPicker } from "../src/tasks-ui.ts";

for (const busy of [false, true]) {
  test(`tasks kill uses steer delivery (${busy ? "busy" : "idle"})`, async () => {
    const notifications: string[] = [];
    const ctx = {
      isIdle: () => !busy,
      ui: {
        select: async (_title: string, labels: string[]) => labels[0],
        confirm: async () => true,
        notify: (message: string) => notifications.push(message),
      },
    } as unknown as ExtensionContext;
    let sent = false;
    await runDevinTasksPicker(ctx, {
      listOps: () => [{ view: { id: "exec", shellId: "shell-1" }, startedAt: 0 }],
      sendToSession: (text, options) => {
        if (busy && !options?.deliverAs) throw new Error("Agent is busy; specify deliverAs");
        assert.equal(text, "Kill background shell shell-1 and confirm it stopped.");
        assert.equal(options?.deliverAs, "steer");
        assert.equal(options?.expandPromptTemplates, false);
        assert.deepEqual(notifications, [], "acknowledge only after submitting");
        sent = true;
      },
    });
    assert.equal(sent, true);
    assert.match(notifications[0], /queued request/);
  });
}

test("tasks kill reports send failures instead of acknowledging success", async () => {
  const notifications: { message: string; level: string }[] = [];
  await runDevinTasksPicker(
    {
      ui: {
        select: async (_title: string, labels: string[]) => labels[0],
        confirm: async () => true,
        notify: (message: string, level: string) => notifications.push({ message, level }),
      },
    } as unknown as ExtensionContext,
    {
      listOps: () => [{ view: { id: "exec", shellId: "shell-1" }, startedAt: 0 }],
      sendToSession: () => {
        throw new Error("session closed");
      },
    },
  );
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].level, "error");
  assert.match(notifications[0].message, /session closed/);
});
