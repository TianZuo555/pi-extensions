import assert from "node:assert/strict";
import test from "node:test";
import {
  TODO_PROMPT_GUIDELINES,
  TODO_TOOL_DESCRIPTION,
} from "../lib/prompt.ts";
import {
  describeDropped,
  findDroppedItems,
  findDuplicateIds,
  statsFor,
  type TodoItem,
} from "../lib/state.ts";

function item(id: number, status: TodoItem["status"], title = `task ${id}`): TodoItem {
  return { id, title, status };
}

test("the description states the replace-whole-list contract and nothing else", () => {
  assert.match(TODO_TOOL_DESCRIPTION, /replaces the whole list/);
  assert.match(TODO_TOOL_DESCRIPTION, /keep their id/);
  // Behavioural policy belongs in the guidelines, which pi always injects
  // alongside the description. It must not creep back into the description.
  assert.doesNotMatch(TODO_TOOL_DESCRIPTION, /When to use|frequently|IMPORTANT|CRITICAL/i);
  assert.ok(TODO_TOOL_DESCRIPTION.length < 260, "description stays short");
  assert.ok(
    TODO_PROMPT_GUIDELINES.some((line) => /skip it for single-step/.test(line)),
    "when-not-to-use lives in the guidelines",
  );
});

test("dropping an unfinished item is reported; pruning completed ones is not", () => {
  const previous = [item(1, "completed"), item(2, "in-progress"), item(3, "not-started")];

  // A partial resend that loses unfinished work.
  const dropped = findDroppedItems(previous, [item(2, "in-progress")]);
  assert.deepEqual(dropped.map((todo) => todo.id), [3]);
  const message = describeDropped(dropped);
  assert.match(message, /1 unfinished item/);
  assert.match(message, /3\. task 3/);
  assert.match(message, /resend every item/);

  // Pruning a completed item is legitimate housekeeping.
  assert.deepEqual(
    findDroppedItems(previous, [item(2, "in-progress"), item(3, "not-started")]),
    [],
  );
  // Finishing an item is not dropping it.
  assert.deepEqual(
    findDroppedItems(previous, [item(1, "completed"), item(2, "completed"), item(3, "completed")]),
    [],
  );
  assert.deepEqual(findDroppedItems([], [item(1, "not-started")]), []);
});

test("duplicate ids are detected because ids address items across writes", () => {
  assert.deepEqual(findDuplicateIds([item(1, "not-started"), item(1, "completed")]), [1]);
  assert.deepEqual(findDuplicateIds([item(1, "not-started"), item(2, "completed")]), []);
  assert.deepEqual(findDuplicateIds([]), []);
});

test("stats count completion and parallel work", () => {
  assert.deepEqual(
    statsFor([item(1, "completed"), item(2, "in-progress"), item(3, "in-progress")]),
    { total: 3, completed: 1, inProgress: 2 },
  );
  assert.deepEqual(statsFor([]), { total: 0, completed: 0, inProgress: 0 });
});
