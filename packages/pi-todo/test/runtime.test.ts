import assert from "node:assert/strict";
import test from "node:test";
import type { TodoItem } from "../lib/state.ts";
import {
  createTodoRuntime,
  runTodo,
  TodoRuntime,
} from "../src/runtime.ts";

test("TodoRuntime write and read lifecycle", async () => {
  const runtime = createTodoRuntime();
  const service = runtime.runSync(TodoRuntime);

  const initial = await runTodo(runtime, service.read);
  assert.equal(initial.todos.length, 0);
  assert.match(initial.text, /empty/);

  const written = await runTodo(
    runtime,
    service.write([
      { id: 1, title: "First task", status: "completed" },
      { id: 2, title: "Second task", status: "in-progress" },
    ]),
  );

  assert.equal(written.todos.length, 2);
  assert.equal(written.dropped.length, 0);
  assert.match(written.text, /1\/2 completed/);

  // Dropping an in-progress item
  const updated = await runTodo(
    runtime,
    service.write([{ id: 1, title: "First task", status: "completed" }]),
  );
  assert.equal(updated.dropped.length, 1);
  assert.equal(updated.dropped[0].id, 2);
  assert.match(updated.text, /1 unfinished item/);

  await runTodo(runtime, service.clear);
  const cleared = await runTodo(runtime, service.read);
  assert.equal(cleared.todos.length, 0);

  await runtime.dispose();
});

test("TodoRuntime rejects duplicate ids and missing list", async () => {
  const runtime = createTodoRuntime();
  const service = runtime.runSync(TodoRuntime);

  await assert.rejects(
    async () => {
      await runTodo(runtime, service.write(undefined));
    },
    (err: Error) => err.message.includes("requires todoList"),
  );

  await assert.rejects(
    async () => {
      await runTodo(
        runtime,
        service.write([
          { id: 1, title: "Task 1", status: "not-started" },
          { id: 1, title: "Task 2", status: "not-started" },
        ]),
      );
    },
    (err: Error) => err.message.includes("duplicate id"),
  );

  await runtime.dispose();
});

test("TodoRuntime reconstructs branch state", async () => {
  const runtime = createTodoRuntime();
  const service = runtime.runSync(TodoRuntime);

  const todos: TodoItem[] = [
    { id: 10, title: "Branch restored task", status: "in-progress" },
  ];

  const branch = [
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: "todo",
        details: {
          todos,
        },
      },
    },
  ];

  const restored = await runTodo(runtime, service.reconstructFromBranch(branch));
  assert.equal(restored.length, 1);
  assert.equal(restored[0].id, 10);
  assert.equal(restored[0].title, "Branch restored task");

  await runtime.dispose();
});
