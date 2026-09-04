import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionCommandContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  completeProviderOrder,
  type OrderTab,
  type ProviderOrders,
  promptProviderOrder,
} from "../src/order-ui.ts";

const tabs: [OrderTab, OrderTab] = [
  {
    id: "search",
    label: "Search",
    items: [
      { id: "firecrawl", detail: "keyless", active: true },
      { id: "openai", detail: "not configured", active: false },
    ],
  },
  {
    id: "fetch",
    label: "Fetch",
    items: [
      { id: "firecrawl", detail: "keyless", active: true },
      { id: "direct", detail: "built-in HTTP fallback", active: true },
    ],
  },
];

function openDialog(): {
  component: Component;
  result: Promise<ProviderOrders | null>;
  renderRequests: () => number;
} {
  let component: Component | undefined;
  let finish: ((value: ProviderOrders | null) => void) | undefined;
  let renders = 0;
  const result = new Promise<ProviderOrders | null>((resolve) => {
    finish = resolve;
  });
  const tui = {
    requestRender: () => {
      renders++;
    },
  } as unknown as TUI;
  const theme = {
    fg: (_color: string, value: string) => value,
    bg: (_color: string, value: string) => value,
    bold: (value: string) => value,
  } as unknown as Theme;
  const bindings: Record<string, string> = {
    escape: "tui.select.cancel",
    up: "tui.select.up",
    down: "tui.select.down",
    enter: "tui.select.confirm",
    tab: "tui.input.tab",
  };
  const keybindings = {
    matches: (data: string, id: string) => bindings[data] === id,
  } as unknown as KeybindingsManager;
  const ctx = {
    ui: {
      custom: (
        factory: (
          tui: TUI,
          theme: Theme,
          keybindings: KeybindingsManager,
          done: typeof finish,
        ) => Component,
      ) => {
        component = factory(tui, theme, keybindings, finish);
        return result;
      },
    },
  } as unknown as ExtensionCommandContext;

  const returned = promptProviderOrder(ctx, tabs);
  assert.equal(returned, result);
  assert.ok(component);
  return { component, result, renderRequests: () => renders };
}

test("completeProviderOrder retains unavailable providers in their saved positions", () => {
  const canonical = ["firecrawl", "openai", "exa", "tavily"];
  assert.deepEqual(
    completeProviderOrder<string>(canonical, ["firecrawl", "exa"], undefined, [
      "tavily",
      "exa",
      "firecrawl",
      "unknown",
    ]),
    ["tavily", "exa", "firecrawl", "openai"],
  );
  assert.deepEqual(
    completeProviderOrder(canonical, ["firecrawl", "exa"], undefined, "bad json" as never),
    ["firecrawl", "exa", "openai", "tavily"],
  );
});

test("order dialog uses Tab to switch from search to fetch", () => {
  const dialog = openDialog();
  const searchLines = dialog.component.render(80);
  assert.ok(searchLines.some((line) => line.includes("firecrawl")));
  assert.ok(searchLines.some((line) => line.includes("openai")));
  assert.ok(!searchLines.some((line) => line.includes("direct")));

  dialog.component.handleInput?.("tab");
  const fetchLines = dialog.component.render(80);
  assert.ok(fetchLines.some((line) => line.includes("direct")));
  assert.ok(!fetchLines.some((line) => line.includes("openai")));
  assert.equal(dialog.renderRequests(), 1);
});

test("order dialog preserves edits on both tabs and saves them together", async () => {
  const dialog = openDialog();

  dialog.component.handleInput?.("down");
  dialog.component.handleInput?.("enter");
  dialog.component.handleInput?.("up");
  dialog.component.handleInput?.(" ");
  dialog.component.handleInput?.("tab");
  dialog.component.handleInput?.("enter");
  dialog.component.handleInput?.("down");
  dialog.component.handleInput?.("enter");

  assert.deepEqual(await dialog.result, {
    search: ["openai", "firecrawl"],
    fetch: ["direct", "firecrawl"],
  });
});

test("order dialog cancels without returning edits and stays width-safe", async () => {
  const dialog = openDialog();
  assert.ok(dialog.component.render(0).every((line) => visibleWidth(line) === 0));
  for (const line of dialog.component.render(18)) {
    assert.ok(visibleWidth(line) <= 18, `${visibleWidth(line)} > 18: ${line}`);
  }
  dialog.component.handleInput?.("tab");
  for (const line of dialog.component.render(18)) {
    assert.ok(visibleWidth(line) <= 18, `${visibleWidth(line)} > 18: ${line}`);
  }
  dialog.component.handleInput?.("escape");
  assert.equal(await dialog.result, null);
});
