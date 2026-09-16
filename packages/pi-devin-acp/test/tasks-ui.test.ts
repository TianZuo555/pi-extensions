import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  buildDevinOpInfo,
  buildDevinOpOutputLines,
  cycleDevinDetailTab,
  DEFAULT_DEVIN_DETAIL_TAB,
  reconcileOpsSelection,
  runDevinTasksPicker,
  type OpsSelection,
} from "../src/tasks-ui.ts";

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
/** Staged keybinding stubs: raw byte → action, like a real terminal. */
const stagedKeys = {
  matches: (data: string, binding: string) =>
    ({
      "\r": "tui.select.confirm",
      "\x1b": "tui.select.cancel",
      "\x03": "app.interrupt",
    })[data] === binding,
  getKeys: () => [],
};
const tuiStub = { terminal: { rows: 12 }, requestRender: () => {} };
/** Taller terminal so detail-view assertions see a full viewport. */
const tuiStub30 = { terminal: { rows: 30 }, requestRender: () => {} };

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

type OverlayComponent = Component & {
  handleInput(data: string): void;
  render(width: number): string[];
  dispose(): void;
};

function overlayCtx(
  drive: (component: OverlayComponent, done: (value: unknown) => void) => void | Promise<void>,
  confirmResult: boolean | undefined = undefined,
) {
  const notifications: { message: string; level: string }[] = [];
  const confirms: string[] = [];
  const ctx = {
    mode: "tui",
    ui: {
      custom: async (factory: (...args: unknown[]) => OverlayComponent) => {
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

/** ctx.ui.custom that runs one drive stage per call; getCalls() reports
 * invocations (a getter, because a destructured number would not update). */
function stagedOverlayCtx(
  stages: Array<(component: OverlayComponent) => void | Promise<void>>,
  confirmResult: boolean | undefined = undefined,
) {
  const notifications: { message: string; level: string }[] = [];
  const confirms: string[] = [];
  let customCalls = 0;
  const ctx = {
    mode: "tui",
    ui: {
      custom: async (factory: (...args: unknown[]) => OverlayComponent) => {
        customCalls += 1;
        let result: { value: unknown } | undefined;
        const done = (value: unknown) => {
          result = { value };
        };
        const component = factory(tuiStub30, themeStub, stagedKeys, done);
        try {
          const stage = stages[customCalls - 1];
          if (stage) await stage(component);
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
  return {
    ctx: ctx as unknown as ExtensionContext,
    getCalls: () => customCalls,
    notifications,
    confirms,
  };
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
    assert.match(joined, /inspect/);
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

test("tasks overlay navigates with j/k and x kills the selected shell", async () => {
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
      custom: async (factory: (...args: unknown[]) => OverlayComponent) => {
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

// --- Detail view (/ps parity: enter inspects) --------------------------------------

test("enter opens the detail view; cancel returns to the dashboard", async () => {
  const { ctx, getCalls, confirms } = stagedOverlayCtx([
    async (dashboard) => {
      await flush();
      dashboard.handleInput("\r"); // enter → inspect the selected op
    },
    async (detail) => {
      await flush();
      const joined = detail.render(80).join("\n");
      assert.match(joined, /Info/);
      assert.match(joined, /id: op-1/);
      assert.match(joined, /title: Running tests/);
      assert.match(joined, /scope: background shell 3/);
      assert.match(joined, /t\/←\/→ to switch/);
      assert.match(joined, /x kill/);
      // Narrow terminals stay width-safe too.
      for (const line of detail.render(24)) {
        assert.ok(visibleWidth(line) <= 24, `narrow line exceeds width: ${line}`);
      }
      detail.handleInput("\x1b"); // back to the dashboard
    },
    async (dashboard) => {
      await flush();
      assert.match(dashboard.render(80).join("\n"), /Devin operations/);
    },
  ]);
  await runDevinTasksPicker(ctx, {
    listOps: () => OPS,
    sendToSession: () => {
      throw new Error("inspecting must not send anything");
    },
  });
  assert.equal(getCalls(), 3, "dashboard → detail → dashboard");
  assert.equal(confirms.length, 0);
});

test("detail view tabs between metadata and streamed output with scrolling", async () => {
  const streamed = Array.from({ length: 80 }, (_, i) => `out-${i}`).join("\n");
  const ops = () => [
    {
      view: {
        id: "op-1",
        title: "Running tests",
        kind: "execute",
        shellId: "3",
        output: streamed,
        rawInput: { command: "npm test" },
      },
      startedAt: Date.now() - 65_000,
    },
    OPS[1],
  ];
  const { ctx } = stagedOverlayCtx([
    async (dashboard) => {
      await flush();
      dashboard.handleInput("\r");
    },
    async (detail) => {
      await flush();
      assert.match(detail.render(80).join("\n"), /id: op-1/);
      detail.handleInput("t"); // → output tab, pinned to the live tail
      assert.match(detail.render(80).join("\n"), /out-79/);
      assert.doesNotMatch(detail.render(80).join("\n"), /out-0/);
      detail.handleInput("k"); // scroll up freezes the reading position
      const scrolled = detail.render(80).join("\n");
      assert.match(scrolled, /lines below/);
      assert.doesNotMatch(scrolled, /out-79/);
      detail.handleInput("G"); // back to the tail
      assert.match(detail.render(80).join("\n"), /out-79/);
      detail.handleInput("g"); // top
      assert.match(detail.render(80).join("\n"), /out-0/);
      detail.handleInput("h"); // ← back to info
      assert.match(detail.render(80).join("\n"), /id: op-1/);
    },
  ]);
  await runDevinTasksPicker(ctx, {
    listOps: ops,
    sendToSession: () => {},
  });
});

test("x from the detail view kills the inspected shell", async () => {
  const sent: string[] = [];
  const { ctx, getCalls, confirms } = stagedOverlayCtx(
    [
      async (dashboard) => {
        await flush();
        dashboard.handleInput("\r");
      },
      async (detail) => {
        await flush();
        detail.handleInput("x");
      },
    ],
    true,
  );
  await runDevinTasksPicker(ctx, {
    listOps: () => OPS,
    sendToSession: (text: string, options?: { deliverAs?: string }) => {
      sent.push(`${options?.deliverAs}:${text}`);
    },
  });
  assert.equal(getCalls(), 2, "the kill leaves the overlay flow");
  assert.equal(confirms.length, 1);
  assert.deepEqual(sent, ["steer:Kill background shell 3 and confirm it stopped."]);
});

test("detail view freezes once the op settles and stops offering kill", async () => {
  let calls = 0;
  const ops = () => {
    calls += 1;
    // picker fetch + dashboard refresh see the op; later polls see it gone.
    return calls <= 2 ? [OPS[0]] : [];
  };
  const sent: string[] = [];
  const { ctx, getCalls, confirms } = stagedOverlayCtx([
    async (dashboard) => {
      await flush();
      dashboard.handleInput("\r");
    },
    async (detail) => {
      await flush();
      assert.match(detail.render(80).join("\n"), /Running tests/);
      // The 1 Hz ticker is the next poll after the seeded snapshot.
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const settled = detail.render(80).join("\n");
      assert.match(settled, /settled/);
      detail.handleInput("x"); // settled: no kill action
      detail.handleInput("\x1b"); // back out to the dashboard
    },
    async (dashboard) => {
      await flush();
      await flush();
    },
  ]);
  await runDevinTasksPicker(ctx, {
    listOps: ops,
    sendToSession: (text: string) => sent.push(text),
  });
  assert.deepEqual(sent, [], "a settled op can no longer be killed");
  assert.equal(confirms.length, 0);
  // Backing out reopens the dashboard, whose refresh finds no ops and closes.
  assert.equal(getCalls(), 3, "the emptied dashboard closes itself");
});

// --- Detail view helpers -----------------------------------------------------------

test("detail tabs start on Info and cycle with Output", () => {
  assert.equal(DEFAULT_DEVIN_DETAIL_TAB, "info");
  assert.equal(cycleDevinDetailTab("info"), "output");
  assert.equal(cycleDevinDetailTab("output"), "info");
  assert.equal(cycleDevinDetailTab("info", -1), "output");
  assert.equal(cycleDevinDetailTab("output", -1), "info");
});

test("buildDevinOpInfo includes invocation metadata and sanitized input", () => {
  const info = buildDevinOpInfo(
    {
      view: {
        id: "call_abc123",
        title: "Wrote \u001b[31m/tmp/x.txt\u001b[0m",
        kind: "execute",
        tool: "shell",
        status: "pending",
        shellId: "7",
        rawInput: { command: "npm test" },
        locations: ["/a.ts", "/b.ts"],
      },
      startedAt: Date.parse("2026-01-01T00:00:00.000Z"),
    },
    Date.parse("2026-01-01T00:00:09.000Z"),
  );
  assert.match(info, /id: call_abc123/);
  assert.match(info, /title: Wrote \/tmp\/x\.txt/);
  assert.match(info, /tool: shell/);
  assert.match(info, /status: pending/);
  assert.match(info, /started: 2026-01-01T00:00:00\.000Z/);
  assert.match(info, /elapsed: 9s/);
  assert.match(info, /scope: background shell 7/);
  assert.match(info, /locations: \/a\.ts, \/b\.ts/);
  assert.match(info, /input:\n\{\n  "command": "npm test"\n\}/);
  assert.doesNotMatch(info, /\u001b\[/);
});

test("buildDevinOpOutputLines collapses CR progress, strips ANSI, expands tabs, wraps", () => {
  assert.deepEqual(buildDevinOpOutputLines("progress 1\rprogress 2\rdone\nnext", 80), [
    "done",
    "next",
  ]);
  assert.deepEqual(buildDevinOpOutputLines("progress 1\rprogress 2\r", 80), ["progress 2"]);
  assert.equal(buildDevinOpOutputLines("a\tb", 80).join(""), "a  b");
  assert.equal(buildDevinOpOutputLines("\u001b[31mred\u001b[0m", 80).join(""), "red");
  const wrapped = buildDevinOpOutputLines("x".repeat(25), 10);
  assert.ok(wrapped.length > 1);
  assert.equal(wrapped.join(""), "x".repeat(25));
  assert.deepEqual(buildDevinOpOutputLines("a\nb\n", 80), ["a", "b"]);
  assert.deepEqual(buildDevinOpOutputLines("", 80), []);
});
