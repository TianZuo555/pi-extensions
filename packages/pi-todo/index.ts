// pi extension: a small `todo` tool for multi-step work.
//
// Replaces tintinweb/pi-manage-todo-list, whose model-facing prompt was a
// verbatim GitHub Copilot clone (~565 tokens per request) because it put all
// behavioural policy into `description` — pi has promptSnippet and
// promptGuidelines slots for exactly that. This one costs ~140.
//
// The list renders through pi's own ctx.ui.setWidget above the editor; there is
// no bespoke widget component to maintain.
//
// Quick try:  pi -e ./packages/pi-todo

import { StringEnum } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import {
  TODO_PARAMETER_DESCRIPTIONS,
  TODO_PROMPT_GUIDELINES,
  TODO_PROMPT_SNIPPET,
  TODO_TOOL_DESCRIPTION,
} from "./lib/prompt.ts";
import {
  describeDropped,
  findDroppedItems,
  findDuplicateIds,
  statsFor,
  type TodoItem,
} from "./lib/state.ts";

const WIDGET_KEY = "todo-list";
/** Older sessions stored their list under the replaced tool's name. */
const LEGACY_TOOL_NAME = "manage_todo_list";

const TodoItemSchema = Type.Object({
  id: Type.Number({ description: TODO_PARAMETER_DESCRIPTIONS.id }),
  title: Type.String({ description: TODO_PARAMETER_DESCRIPTIONS.title }),
  status: StringEnum(["not-started", "in-progress", "completed"] as const, {
    description: TODO_PARAMETER_DESCRIPTIONS.status,
  }),
});

const TodoParams = Type.Object({
  operation: StringEnum(["write", "read"] as const, {
    description: TODO_PARAMETER_DESCRIPTIONS.operation,
  }),
  todoList: Type.Optional(
    Type.Array(TodoItemSchema, {
      description: TODO_PARAMETER_DESCRIPTIONS.todoList,
    }),
  ),
});

type TodoInput = Static<typeof TodoParams>;
interface TodoDetails {
  operation: "read" | "write";
  todos: TodoItem[];
}

const STATUS_ICON: Record<TodoItem["status"], string> = {
  completed: "✓",
  "in-progress": "◉",
  "not-started": "○",
};

export default function todoExtension(pi: ExtensionAPI): void {
  let todos: TodoItem[] = [];

  const renderWidget = (ctx: ExtensionContext) => {
    if (todos.length === 0) {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      return;
    }
    const { total, completed } = statsFor(todos);
    const snapshot = [...todos];
    ctx.ui.setWidget(
      WIDGET_KEY,
      (_tui, theme: Theme) => ({
        render: () => [
          theme.fg("accent", " Todos ") +
            theme.fg("muted", `${completed}/${total}`),
          ...snapshot.map((todo) => {
            const label =
              todo.status === "completed"
                ? theme.fg("dim", todo.title)
                : todo.status === "in-progress"
                  ? theme.fg("warning", todo.title)
                  : todo.title;
            return `  ${STATUS_ICON[todo.status]} ${theme.fg("accent", `${todo.id}.`)} ${label}`;
          }),
        ],
        invalidate: () => {},
      }),
      { placement: "aboveEditor" },
    );
  };

  // State lives in tool-result details, so branching, forking, and resuming all
  // rebuild the list that belongs to that point in history.
  const reconstruct = (ctx: ExtensionContext) => {
    todos = [];
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "message") continue;
      const message = entry.message;
      if (message.role !== "toolResult") continue;
      if (message.toolName !== "todo" && message.toolName !== LEGACY_TOOL_NAME) {
        continue;
      }
      const details = message.details as { todos?: TodoItem[] } | undefined;
      if (!details?.todos) continue;
      todos = details.todos.map(({ id, title, status }) => ({
        id,
        title,
        status,
      }));
    }
    renderWidget(ctx);
  };

  // Only these two exist in pi's event union; `session_tree` already covers
  // branching, forking, and navigating history.
  pi.on("session_start", async (_event, ctx) => reconstruct(ctx));
  pi.on("session_tree", async (_event, ctx) => reconstruct(ctx));

  pi.registerTool({
    name: "todo",
    label: "Todo",
    description: TODO_TOOL_DESCRIPTION,
    promptSnippet: TODO_PROMPT_SNIPPET,
    promptGuidelines: TODO_PROMPT_GUIDELINES,
    parameters: TodoParams,

    async execute(_toolCallId, params: TodoInput, _signal, _onUpdate, ctx) {
      if (params.operation === "read") {
        return {
          content: [
            {
              type: "text" as const,
              text: todos.length
                ? todos
                    .map((todo) => `${todo.id}. [${todo.status}] ${todo.title}`)
                    .join("\n")
                : "The todo list is empty.",
            },
          ],
          details: { operation: "read", todos: [...todos] } satisfies TodoDetails,
        };
      }

      const next = params.todoList;
      if (!next) {
        throw new Error("todo: write requires todoList — send every item, not just the changed ones.");
      }
      const duplicates = findDuplicateIds(next);
      if (duplicates.length > 0) {
        throw new Error(
          `todo: duplicate id${duplicates.length === 1 ? "" : "s"} ${duplicates.join(", ")}. Ids identify items across writes, so each must appear once.`,
        );
      }

      // Warn rather than refuse: pruning a list is legitimate, but losing
      // unfinished work to a partial resend is invisible without this.
      const dropped = findDroppedItems(todos, next);
      todos = next.map(({ id, title, status }) => ({ id, title, status }));
      renderWidget(ctx);

      const { total, completed } = statsFor(todos);
      let text = `Todo list updated: ${completed}/${total} completed.`;
      if (dropped.length > 0) text += `\n${describeDropped(dropped)}`;

      return {
        content: [{ type: "text" as const, text }],
        details: { operation: "write", todos: [...todos] } satisfies TodoDetails,
      };
    },

    renderCall(args: TodoInput, theme: Theme) {
      let text = theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", args.operation);
      if (args.operation === "write" && args.todoList) {
        text += theme.fg("dim", ` (${args.todoList.length} items)`);
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme: Theme) {
      const details = result.details as TodoDetails | undefined;
      if (!details) return new Text("", 0, 0);
      const { total, completed } = statsFor(details.todos);
      if (total === 0) return new Text(theme.fg("dim", "No todos"), 0, 0);

      let text = theme.fg("success", "✓ ") + theme.fg("muted", `${completed}/${total} completed`);
      if (expanded) {
        for (const todo of details.todos) {
          text += `\n  ${STATUS_ICON[todo.status]} ${theme.fg("accent", `${todo.id}.`)} ${
            todo.status === "completed" ? theme.fg("dim", todo.title) : todo.title
          }`;
        }
      }
      return new Text(text, 0, 0);
    },
  });

  pi.registerCommand("todos", {
    description: "Show the todo list, or clear it with /todos clear",
    handler: async (args, ctx) => {
      if (args?.trim().toLowerCase() === "clear") {
        todos = [];
        ctx.ui.setWidget(WIDGET_KEY, undefined);
        ctx.ui.notify("Todo list cleared.", "info");
        return;
      }
      renderWidget(ctx);
      const { total, completed } = statsFor(todos);
      ctx.ui.notify(
        total === 0 ? "No todos." : `${completed}/${total} todos completed.`,
        "info",
      );
    },
  });
}
