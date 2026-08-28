import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import askUser from "../index.ts";

type SchemaNode = {
  description?: string;
  minItems?: number;
  maxItems?: number;
  items?: SchemaNode;
  properties?: Record<string, SchemaNode>;
};

type RegisteredTool = {
  name: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: SchemaNode;
};

function registeredTool(): RegisteredTool {
  let tool: RegisteredTool | undefined;
  askUser({
    registerTool(definition: unknown) {
      tool = definition as RegisteredTool;
    },
  } as unknown as ExtensionAPI);
  if (!tool) throw new Error("ask_user was not registered");
  return tool;
}

test("ask_user metadata stays concise and non-redundant", () => {
  const tool = registeredTool();
  const guidelines = tool.promptGuidelines ?? [];

  assert.equal(guidelines.length, 3);
  assert.match(guidelines[0]!, /ask_user instead of plain text/);
  assert.match(guidelines[1]!, /Batch/);
  assert.match(guidelines[1]!, /dependent follow-ups/);
  assert.match(guidelines[2]!, /recommend/);
  assert.match(tool.description, /custom answer/);
  assert.match(tool.description, /dismiss/);
  assert.doesNotMatch(tool.description, /[12]-5/);

  const modelChars =
    JSON.stringify({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }).length +
    (tool.promptSnippet?.length ?? 0) +
    guidelines.reduce((total, guideline) => total + guideline.length, 0);
  assert.ok(modelChars <= 1_100, `prompt budget exceeded: ${modelChars} chars`);
});

test("ask_user schema carries bounds and localized guidance", () => {
  const tool = registeredTool();
  const questions = tool.parameters.properties?.questions;
  const question = questions?.items;
  const options = question?.properties?.options;
  const option = options?.items;
  const optionLabel = option?.properties?.label;
  const optionDescription = option?.properties?.description;
  const questionText = question?.properties?.question;

  assert.equal(questions?.minItems, 1);
  assert.equal(questions?.maxItems, 5);
  assert.equal(options?.minItems, 2);
  assert.equal(options?.maxItems, 5);
  assert.match(options?.description ?? "", /recommendation first/);
  assert.match(options?.description ?? "", /Other is added automatically/);
  assert.match(options?.description ?? "", /do not include it/);
  assert.match(optionLabel?.description ?? "", /Concise/);
  assert.match(optionDescription?.description ?? "", /constraints/);
  assert.equal(question?.properties?.allow_multiple, undefined);

  for (const [name, node] of [
    ["questions", questions],
    ["question", questionText],
    ["options", options],
    ["option.label", optionLabel],
    ["option.description", optionDescription],
  ] as const) {
    assert.ok(node?.description, `${name} has no description`);
  }
  assert.ok(JSON.stringify(tool.parameters).length <= 700);
});
