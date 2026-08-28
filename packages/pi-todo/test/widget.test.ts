import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import todoExtension from "../index.ts";

interface TodoTool {
  execute: (...args: any[]) => Promise<unknown>;
}

interface WidgetComponent {
  render: (width: number) => string[];
}

test("todo widget truncates every ANSI-styled line to the render width", async () => {
  let tool: TodoTool | undefined;
  let widgetFactory: ((tui: unknown, theme: Theme) => WidgetComponent) | undefined;

  todoExtension({
    on: () => {},
    registerTool: (definition: TodoTool) => {
      tool = definition;
    },
    registerCommand: () => {},
  } as unknown as ExtensionAPI);

  assert.ok(tool);
  await tool.execute(
    "todo-call",
    {
      operation: "write",
      todoList: [
        {
          id: 1,
          title: "Inspect current terminal output contracts",
          status: "completed",
        },
        {
          id: 2,
          title: "Implement Stage 0 output safety fixes 日本語",
          status: "in-progress",
        },
      ],
    },
    undefined,
    undefined,
    {
      ui: {
        setWidget: (_key: string, value: typeof widgetFactory) => {
          widgetFactory = value;
        },
      },
    },
  );

  assert.ok(widgetFactory);
  const theme = {
    fg: (_color: string, text: string) => `\x1b[38;5;5m${text}\x1b[39m`,
  } as Theme;
  const widget = widgetFactory({}, theme);

  for (const width of [35, 12, 1]) {
    const lines = widget.render(width);
    assert.ok(
      lines.every((line) => visibleWidth(line) <= width),
      `all lines fit ${width} columns: ${lines.map(visibleWidth).join(", ")}`,
    );
  }

  assert.equal(visibleWidth(widget.render(35)[1]!), 35);
});
