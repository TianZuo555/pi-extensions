import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { reconcileOpsSelection, runDevinTasksPicker, type OpsSelection } from "../src/tasks-ui.ts";

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

// --- /ps-style overlay -----------------------------------------------------------

import type { Component } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";

const themeStub = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const keybindingsStub = { matches: () => false, getKeys: () => [] };
const tuiStub = { terminal: { rows: 12 }, requestRender: () => {} };

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

type DashboardComponent = Component & {
  handleInput(data: string): void;
  render(width: number): string[];
  dispose(): void;
};

function overlayCtx(
  drive: (component: DashboardComponent, done: (value: unknown) => void) => void | Promise<void>,
  confirmResult: boolean | undefined = undefined,
) {
  const notifications: { message: string; level: string }[] = [];
  const confirms: string[] = [];
  const ctx = {
    mode: "tui",
    ui: {
      custom: async (factory: (...args: unknown[]) => DashboardComponent) => {
        let result: { value: unknown } | undefined;
        const done = (value: unknown) => {
          result = { value };
        };
        const component = factory(tuiStub, themeStub, keybindingsStub, done);
        try {
          await drive(component, done);
          return result?.value ?? null;
        } finally {
          component.dispose();
        }
      },
      confirm: async (_title: string, message: string) => {
        confirms.push(message);
        return confirmResult ?? false;
      },
      notify: (message: string, level: string) => notifications.push({ message, level }),
    },
  };
  return { ctx: ctx as unknown as ExtensionContext, notifications, confirms };
}

const OPS = [
  {
    view: { id: "op-1", title: "Running tests", kind: "execute", shellId: "3" },
    startedAt: Date.now() - 65_000,
  },
  { view: { id: "op-2", title: "Slow refactor" }, startedAt: Date.now() },
];

test("tasks overlay renders ops /ps-style with borders, hints, and live metadata", async () => {
  const { ctx } = overlayCtx(async (component) => {
    await flush(); // the initial snapshot load is async
    const lines = component.render(80);
    const joined = lines.join("\n");
    assert.match(joined, /Devin operations/);
    assert.match(joined, /devin ops · 2 running/);
    assert.match(joined, /Running tests/);
    assert.match(joined, /Slow refactor/);
    assert.match(joined, /bg shell 3/);
    assert.match(joined, /in-turn/);
    assert.match(joined, /1m5s/);
    assert.match(joined, /jk select/);
    // Bordered rows span the full width exactly.
    assert.equal(visibleWidth(lines[1]), 80);
    for (const line of lines) {
      assert.ok(visibleWidth(line) <= 80, `line exceeds width: ${line}`);
    }
    // Narrow terminals stay width-safe too.
    for (const line of component.render(24)) {
      assert.ok(visibleWidth(line) <= 24, `narrow line exceeds width: ${line}`);
    }
  });
  await runDevinTasksPicker(ctx, {
    listOps: () => OPS,
    sendToSession: () => {
      throw new Error("must not send without a kill confirmation");
    },
  });
});

test("tasks overlay navigates with j/k and confirm kills the selected shell", async () => {
  const sent: string[] = [];
  const { ctx, confirms } = overlayCtx(async (component) => {
    await flush();
    assert.match(component.render(80).join("\n"), /❯ ■ Running tests/);
    component.handleInput("j");
    assert.match(component.render(80).join("\n"), /❯ ■ Slow refactor/);
    component.handleInput("k");
    assert.match(component.render(80).join("\n"), /❯ ■ Running tests/);
    component.handleInput("x");
  }, true);
  await runDevinTasksPicker(ctx, {
    listOps: () => OPS,
    sendToSession: (text: string, options?: { deliverAs?: string }) => {
      sent.push(`${options?.deliverAs}:${text}`);
    },
  });
  assert.equal(confirms.length, 1);
  assert.match(confirms[0], /kill background shell 3/);
  assert.deepEqual(sent, ["steer:Kill background shell 3 and confirm it stopped."]);
});

test("tasks overlay declines to kill ops that are not background shells", async () => {
  const { ctx, notifications } = overlayCtx(async (component) => {
    await flush();
    component.handleInput("j"); // op-2 has no shellId
    component.handleInput("x");
  }, true);
  await runDevinTasksPicker(ctx, {
    listOps: () => OPS,
    sendToSession: () => {
      throw new Error("in-turn ops cannot be killed from pi");
    },
  });
  assert.equal(notifications.length, 1);
  assert.match(notifications[0].message, /only devin can stop it/);
});

test("tasks overlay closes itself when every op settles", async () => {
  let calls = 0;
  const dones: unknown[] = [];
  const ctx = {
    mode: "tui",
    ui: {
      custom: async (factory: (...args: unknown[]) => DashboardComponent) => {
        const component = factory(tuiStub, themeStub, keybindingsStub, (value: unknown) =>
          dones.push(value),
        );
        try {
          await flush();
          await flush();
          return null;
        } finally {
          component.dispose();
        }
      },
      confirm: async () => false,
      notify: () => {},
    },
  } as unknown as ExtensionContext;
  await runDevinTasksPicker(ctx, {
    listOps: () => (++calls === 1 ? OPS : []),
    sendToSession: () => {},
  });
  assert.ok(calls >= 2, "the dashboard must poll for updates");
  assert.deepEqual(dones, [null], "the overlay auto-closes once no ops remain");
});

test("reconcileOpsSelection anchors by id and clamps to the list", () => {
  const selection: OpsSelection = { id: "b", index: 1 };
  reconcileOpsSelection(selection, ["a", "b", "c"]);
  assert.deepEqual(selection, { id: "b", index: 1 });
  reconcileOpsSelection(selection, ["c", "a"]);
  assert.deepEqual(selection, { id: "a", index: 1 });
  reconcileOpsSelection(selection, []);
  assert.deepEqual(selection, { id: undefined, index: 0 });
});
