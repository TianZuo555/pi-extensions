import assert from "node:assert/strict";
import test from "node:test";
import { TodoParams } from "../index.ts";
import {
  TODO_PARAMETER_DESCRIPTIONS,
  TODO_PROMPT_GUIDELINES,
  TODO_PROMPT_SNIPPET,
  TODO_TOOL_DESCRIPTION,
} from "../lib/prompt.ts";

type SchemaNode = {
  type?: string;
  description?: string;
  enum?: string[];
  minimum?: number;
  minLength?: number;
  items?: SchemaNode;
  properties?: Record<string, SchemaNode>;
};

test("todo metadata stays concise and non-redundant", () => {
  assert.equal(TODO_PROMPT_GUIDELINES.length, 2);
  assert.match(TODO_PROMPT_GUIDELINES[0]!, /skip single-step/);
  assert.match(TODO_PROMPT_GUIDELINES[1]!, /in-progress/);
  assert.match(TODO_PROMPT_GUIDELINES[1]!, /completed/);

  assert.ok(TODO_TOOL_DESCRIPTION.length <= 50);
  assert.ok(TODO_PROMPT_SNIPPET.length <= 24);
  assert.doesNotMatch(TODO_TOOL_DESCRIPTION, /read|write|id/i);

  const metadataChars = JSON.stringify({
    name: "todo",
    description: TODO_TOOL_DESCRIPTION,
    parameters: TodoParams,
    promptSnippet: TODO_PROMPT_SNIPPET,
    promptGuidelines: TODO_PROMPT_GUIDELINES,
  }).length;
  assert.ok(
    metadataChars <= 950,
    `prompt budget exceeded: ${metadataChars} chars`,
  );
});

test("todo schema carries localized contracts and validation", () => {
  const schema = JSON.parse(JSON.stringify(TodoParams)) as SchemaNode;
  assert.deepEqual(Object.keys(schema.properties ?? {}), ["operation", "todoList"]);

  const operation = schema.properties?.operation;
  const todoList = schema.properties?.todoList;
  const id = todoList?.items?.properties?.id;
  const title = todoList?.items?.properties?.title;
  const status = todoList?.items?.properties?.status;

  assert.deepEqual(operation?.enum, ["write", "read"]);
  assert.equal(id?.type, "integer");
  assert.equal(id?.minimum, 1);
  assert.equal(title?.type, "string");
  assert.equal(title?.minLength, 1);
  assert.deepEqual(status?.enum, ["not-started", "in-progress", "completed"]);

  for (const [name, node] of [
    ["operation", operation],
    ["todoList", todoList],
    ["todoList.id", id],
    ["todoList.title", title],
    ["todoList.status", status],
  ] as const) {
    assert.ok(node?.description, `${name} has no description`);
  }

  assert.match(TODO_PARAMETER_DESCRIPTIONS.operation, /write replaces/);
  assert.match(TODO_PARAMETER_DESCRIPTIONS.todoList, /required for write/);
  assert.match(TODO_PARAMETER_DESCRIPTIONS.id, /reuse across writes/);
  assert.doesNotMatch(TODO_PARAMETER_DESCRIPTIONS.status, /not-started|completed/);
  assert.ok(JSON.stringify(TodoParams).length <= 625);
});
