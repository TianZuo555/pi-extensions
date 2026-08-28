import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import askUser from "../index.ts";

type RegisteredTool = {
  execute: (
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: unknown,
  ) => Promise<{ content: Array<{ text: string }> }>;
};

function registeredTool(): RegisteredTool {
  let tool: RegisteredTool | undefined;
  const pi = {
    registerTool: (definition: unknown) => {
      tool = definition as RegisteredTool;
    },
    events: { emit: () => {} },
  } as unknown as ExtensionAPI;
  askUser(pi);
  if (!tool) throw new Error("ask_user was not registered");
  return tool;
}

/** No UI, so a call that passes validation settles with the no-ui outcome. */
const ctx = { mode: "print", hasUI: false } as unknown;

function ask(labels: string[]) {
  return registeredTool().execute(
    "call-1",
    {
      questions: [{ question: "Pick one", options: labels.map((label) => ({ label })) }],
    },
    undefined,
    undefined,
    ctx,
  );
}

test("a model-supplied Other option is refused instead of rendered twice", async () => {
  for (const label of [
    "Other",
    "other",
    "OTHER",
    "Other...",
    "Other (specify)",
    "Other — type your own answer",
    "Something else",
    "None of the above",
    "Custom",
  ]) {
    await assert.rejects(
      ask(["Redis", label]),
      /option 2 .*duplicates the free-form Other choice.*were not shown/s,
      label,
    );
  }
});

test("labels that merely start with those words are left alone", async () => {
  for (const label of [
    "Other database",
    "Another approach",
    "Custom domain per tenant",
    "Other services — everything not listed above",
    "Otherwise keep the default",
  ]) {
    const result = await ask(["Redis", label]);
    assert.match(result.content[0].text, /No interactive UI is available/, label);
  }
});

test("option and question counts are still validated first", async () => {
  await assert.rejects(ask(["Only one"]), /between 2 and 5 options/);
  await assert.rejects(
    registeredTool().execute("call-2", { questions: [] }, undefined, undefined, ctx),
    /between 1 and 5 questions/,
  );
});
