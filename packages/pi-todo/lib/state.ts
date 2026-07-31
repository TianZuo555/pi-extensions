/**
 * Todo state: the list itself, plus the one check that matters.
 *
 * `write` has replace-the-whole-list semantics, so an incomplete write silently
 * loses items — no error, and the model never learns. `findDroppedItems` makes
 * that visible in the tool result instead.
 */

export type TodoStatus = "not-started" | "in-progress" | "completed";

export interface TodoItem {
  id: number;
  title: string;
  status: TodoStatus;
}

export interface TodoStats {
  total: number;
  completed: number;
  inProgress: number;
}

export function statsFor(todos: readonly TodoItem[]): TodoStats {
  return {
    total: todos.length,
    completed: todos.filter((todo) => todo.status === "completed").length,
    inProgress: todos.filter((todo) => todo.status === "in-progress").length,
  };
}

/**
 * Items that existed unfinished before this write and are absent from it.
 * Completed items may be pruned freely; unfinished ones vanishing is almost
 * always a partial resend rather than an intentional deletion.
 */
export function findDroppedItems(
  previous: readonly TodoItem[],
  next: readonly TodoItem[],
): TodoItem[] {
  const keptIds = new Set(next.map((todo) => todo.id));
  return previous.filter(
    (todo) => todo.status !== "completed" && !keptIds.has(todo.id),
  );
}

export function describeDropped(dropped: readonly TodoItem[]): string {
  const list = dropped.map((todo) => `${todo.id}. ${todo.title}`).join("; ");
  return (
    `Warning: ${dropped.length} unfinished item${dropped.length === 1 ? "" : "s"} ` +
    `disappeared from this write and ${dropped.length === 1 ? "is" : "are"} now gone: ${list}. ` +
    "write replaces the whole list, so resend every item you still intend to do."
  );
}

/** Duplicate ids make later updates ambiguous, so reject them outright. */
export function findDuplicateIds(todos: readonly TodoItem[]): number[] {
  const seen = new Set<number>();
  const duplicates = new Set<number>();
  for (const todo of todos) {
    if (seen.has(todo.id)) duplicates.add(todo.id);
    seen.add(todo.id);
  }
  return [...duplicates];
}
