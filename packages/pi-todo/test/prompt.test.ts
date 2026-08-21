import assert from "node:assert/strict";
import test from "node:test";
import { TodoParams } from "../index.ts";
import {
  TODO_PARAMETER_DESCRIPTIONS,
  TODO_PROMPT_GUIDELINES,
  TODO_PROMPT_SNIPPET,
  TODO_TOOL_DESCRIPTION,
} from "../lib/prompt.ts";

test("todo metadata stays concise and non-redundant", () => {
  assert.equal(TODO_PROMPT_GUIDELINES.length, 2);
  assert.match(TODO_PROMPT_GUIDELINES[0]!, /skip single-step/);
  assert.match(TODO_PROMPT_GUIDELINES[1]!, /in-progress/);
  assert.match(TODO_PROMPT_GUIDELINES[1]!, /completed/);

  assert.ok(TODO_TOOL_DESCRIPTION.length <= 50);
  assert.ok(TODO_PROMPT_SNIPPET.length <= 24);
  assert.doesNotMatch(TODO_TOOL_DESCRIPTION, /read|write|id/i);

  const modelChars = JSON.stringify({
    name: "todo",
    description: TODO_TOOL_DESCRIPTION,
    parameters: TodoParams,
  }).length +
    TODO_PROMPT_SNIPPET.length +
    TODO_PROMPT_GUIDELINES.reduce((total, guideline) => total + guideline.length, 0);
  assert.ok(modelChars <= 900, `prompt budget exceeded: ${modelChars} chars`);
});

test("todo schema carries localized contracts and validation", () => {
  assert.deepEqual(Object.keys(TodoParams.properties), ["operation", "todoList"]);

  const operation = TodoParams.properties.operation;
  const todoList = TodoParams.properties.todoList;
  const item = todoList.items;
  const { id, title, status } = item.properties;

  assert.deepEqual(operation.enum, ["write", "read"]);
  assert.equal(id.type, "integer");
  assert.equal(id.minimum, 1);
  assert.equal(title.type, "string");
  assert.equal(title.minLength, 1);
  assert.deepEqual(status.enum, ["not-started", "in-progress", "completed"]);

  for (const [name, node] of [
    ["operation", operation],
    ["todoList", todoList],
    ["todoList.id", id],
    ["todoList.title", title],
    ["todoList.status", status],
  ] as const) {
    assert.ok(node.description, `${name} has no description`);
  }

  assert.match(TODO_PARAMETER_DESCRIPTIONS.operation, /write replaces/);
  assert.match(TODO_PARAMETER_DESCRIPTIONS.todoList, /Required for write/);
  assert.match(TODO_PARAMETER_DESCRIPTIONS.id, /reuse across writes/);
  assert.doesNotMatch(TODO_PARAMETER_DESCRIPTIONS.status, /not-started|completed/);
  assert.ok(JSON.stringify(TodoParams).length <= 625);
});
