/**
 * TodoRuntime — Effect v4 service for managing in-session todo list state,
 * validation, dropped-item analysis, and branch reconstruction.
 */

import {
  Cause,
  Context,
  Effect,
  Exit,
  Layer,
  ManagedRuntime,
  Result,
  SynchronizedRef,
} from "effect";
import {
  describeDropped,
  findDroppedItems,
  findDuplicateIds,
  statsFor,
  type TodoItem,
} from "../lib/state.ts";
import { TodoDuplicateIdError, TodoMissingListError } from "./errors.ts";

export const LEGACY_TOOL_NAME = "manage_todo_list";

export interface TodoWriteResult {
  readonly text: string;
  readonly todos: TodoItem[];
  readonly dropped: TodoItem[];
}

export interface TodoReadResult {
  readonly text: string;
  readonly todos: TodoItem[];
}

export interface TodoRuntimeShape {
  readonly getTodos: Effect.Effect<TodoItem[]>;
  readonly setTodos: (todos: TodoItem[]) => Effect.Effect<void>;
  readonly read: Effect.Effect<TodoReadResult>;
  readonly write: (
    items?: TodoItem[],
  ) => Effect.Effect<TodoWriteResult, TodoDuplicateIdError | TodoMissingListError>;
  readonly clear: Effect.Effect<void>;
  readonly reconstructFromBranch: (branchEntries: readonly unknown[]) => Effect.Effect<TodoItem[]>;
}

export class TodoRuntime extends Context.Service<TodoRuntime, TodoRuntimeShape>()(
  "pi-todo/TodoRuntime",
) {}

const makeTodoRuntime = Effect.gen(function* () {
  const ref = yield* SynchronizedRef.make<TodoItem[]>([]);

  const getTodos = SynchronizedRef.get(ref);

  const setTodos = (items: TodoItem[]) =>
    SynchronizedRef.set(
      ref,
      items.map(({ id, title, status }) => ({ id, title, status })),
    );

  const read = Effect.gen(function* () {
    const current = yield* SynchronizedRef.get(ref);
    const text = current.length
      ? current.map((todo) => `${todo.id}. [${todo.status}] ${todo.title}`).join("\n")
      : "The todo list is empty.";
    return { text, todos: [...current] };
  });

  const write = (items?: TodoItem[]) =>
    Effect.gen(function* () {
      if (!items) {
        return yield* new TodoMissingListError({
          message: "todo: write requires todoList — send every item, not just the changed ones.",
        });
      }

      const duplicates = findDuplicateIds(items);
      if (duplicates.length > 0) {
        return yield* new TodoDuplicateIdError({
          duplicates,
          message: `todo: duplicate id${duplicates.length === 1 ? "" : "s"} ${duplicates.join(", ")}. Ids identify items across writes, so each must appear once.`,
        });
      }

      return yield* SynchronizedRef.modify(ref, (current) => {
        const dropped = findDroppedItems(current, items);
        const next = items.map(({ id, title, status }) => ({
          id,
          title,
          status,
        }));
        const { total, completed } = statsFor(next);
        let text = `Todo list updated: ${completed}/${total} completed.`;
        if (dropped.length > 0) text += `\n${describeDropped(dropped)}`;

        return [{ text, todos: next, dropped }, next];
      });
    });

  const clear = SynchronizedRef.set(ref, []);

  const reconstructFromBranch = (branchEntries: readonly unknown[]) =>
    Effect.sync(() => {
      let restored: TodoItem[] = [];
      for (const raw of branchEntries) {
        if (!raw || typeof raw !== "object") continue;
        const entry = raw as { type?: unknown; message?: unknown };
        if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") {
          continue;
        }
        const message = entry.message as {
          role?: unknown;
          toolName?: unknown;
          details?: unknown;
        };
        if (message.role !== "toolResult") continue;
        if (message.toolName !== "todo" && message.toolName !== LEGACY_TOOL_NAME) {
          continue;
        }
        const details = message.details as { todos?: unknown } | undefined;
        if (!Array.isArray(details?.todos)) continue;
        restored = details.todos
          .filter(
            (t): t is TodoItem =>
              typeof t === "object" &&
              t !== null &&
              typeof (t as { id?: unknown }).id === "number" &&
              typeof (t as { title?: unknown }).title === "string" &&
              ((t as { status?: unknown }).status === "not-started" ||
                (t as { status?: unknown }).status === "in-progress" ||
                (t as { status?: unknown }).status === "completed"),
          )
          .map(({ id, title, status }) => ({
            id,
            title,
            status,
          }));
      }
      return restored;
    }).pipe(
      Effect.flatMap((restored) => SynchronizedRef.set(ref, restored).pipe(Effect.as(restored))),
    );

  return TodoRuntime.of({
    getTodos,
    setTodos,
    read,
    write,
    clear,
    reconstructFromBranch,
  });
});

export const TodoRuntimeLive: Layer.Layer<TodoRuntime> = Layer.effect(TodoRuntime, makeTodoRuntime);

export function createTodoRuntime() {
  return ManagedRuntime.make(TodoRuntimeLive);
}

export type TodoRuntimeInstance = ReturnType<typeof createTodoRuntime>;

/** Run an async todo effect program safely */
export async function runTodo<A, E>(
  runtime: TodoRuntimeInstance,
  effect: Effect.Effect<A, E>,
  options: { signal?: AbortSignal } = {},
): Promise<A> {
  const exit = await runtime.runPromiseExit(
    effect,
    options.signal ? { signal: options.signal } : undefined,
  );
  if (Exit.isSuccess(exit)) return exit.value;
  if (Cause.hasInterruptsOnly(exit.cause)) {
    const error = new Error("todo request aborted");
    error.name = "AbortError";
    throw error;
  }
  const failure = Cause.findFail(exit.cause);
  if (Result.isSuccess(failure)) {
    const err = failure.success.error;
    if (err instanceof Error) throw err;
    if (typeof err === "object" && err !== null && "message" in err) {
      throw new Error(String((err as { message: unknown }).message));
    }
    throw new Error(String(err));
  }
  const [first] = Cause.prettyErrors(exit.cause);
  throw new Error(first?.message ?? Cause.pretty(exit.cause));
}
