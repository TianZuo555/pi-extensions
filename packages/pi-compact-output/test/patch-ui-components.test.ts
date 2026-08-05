import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  AssistantMessageComponent,
  initTheme,
  ToolExecutionComponent,
  VERSION,
} from "@earendil-works/pi-coding-agent";
import { Container, Image, Text, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import compactOutputExtension from "../index.ts";
import {
  __getPatchStateForTests,
  __resetPatchStateForTests,
  formatThinkingWorkingMessage,
  installUiPatches,
  isSupportedPiVersion,
  releaseUiPatches,
  setCompactOutputLimits,
  setReasoningStreaming,
} from "../lib/patch-ui-components.ts";
import { tryReadToolExecutionInternals } from "../lib/tool-internals.ts";

initTheme();

afterEach(() => {
  __resetPatchStateForTests();
});

function createTui(): TUI {
  return { requestRender: () => {} } as TUI;
}

/**
 * A Container from the same pi-tui instance ToolExecutionComponent extends.
 * (pi-coding-agent carries its own nested pi-tui copy, so a bare `new
 * Container()` from the hoisted copy never triggers the addChild wrapper.)
 */
function createGroupParent(): Container {
  const toolContainerPrototype = Object.getPrototypeOf(
    ToolExecutionComponent.prototype,
  ) as Container;
  const ToolContainer = toolContainerPrototype.constructor as unknown as new () => Container;
  return new ToolContainer();
}

function renderAssistantTurn(
  message: AssistantMessage,
  tools: Array<{ id: string; name: string; description: string }> = [],
): string {
  const parent = createGroupParent();
  const assistant = new AssistantMessageComponent(undefined, true);
  parent.addChild(assistant);
  assistant.updateContent(message);
  for (const tool of tools) {
    const component = new ToolExecutionComponent(
      tool.name,
      tool.id,
      {},
      {},
      {
        name: tool.name,
        renderCall: () => new Text(tool.description, 0, 0),
        renderResult: () => new Text("", 0, 0),
      } as never,
      createTui(),
      process.cwd(),
    );
    component.setExpanded(false);
    component.updateResult({ isError: false, content: [] }, false);
    parent.addChild(component);
  }
  return parent.render(120).join("\n");
}

function testUsage() {
  return {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function assistantMessage(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"],
  extra: Partial<AssistantMessage> = {},
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-responses",
    provider: "openai",
    model: "gpt-test",
    timestamp: Date.now(),
    usage: testUsage(),
    stopReason,
    ...extra,
  };
}

function createGrepToolDefinition() {
  return {
    name: "grep",
    renderCall: (args: { pattern?: string; path?: string }) =>
      new Text(`grep ${args.pattern ?? ""} in ${args.path ?? ""}`, 0, 0),
    renderResult: (
      result: { content: Array<{ type: string; text?: string }> },
      options: { expanded?: boolean },
    ) => {
      if (!options.expanded) {
        return new Text("", 0, 0);
      }
      const text = result.content
        .filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
        .join("\n");
      return new Text(text, 0, 0);
    },
  };
}

function createToolComponent(toolName = "grep") {
  return new ToolExecutionComponent(
    toolName,
    "call-1",
    { pattern: "/registerTool/", path: "packages" },
    {},
    createGrepToolDefinition() as never,
    createTui(),
    process.cwd(),
  );
}

test("expanded rendering is byte-for-byte identical to the saved original renderer", () => {
  const install = installUiPatches();
  if (!install.installed) {
    return;
  }

  const component = createToolComponent();
  component.updateResult(
    {
      isError: false,
      content: [{ type: "text", text: "packages/pi-compact-output/index.ts:1:export" }],
    },
    false,
  );

  const originalRender = __getPatchStateForTests()?.originalToolRender;
  assert.ok(originalRender);

  component.setExpanded(true);
  const expanded = component.render(100);
  const expected = originalRender.call(component, 100);
  assert.deepEqual(expanded, expected);
});

test("images are absent from the collapsed tool area and restored when expanded", () => {
  const install = installUiPatches();
  if (!install.installed) {
    return;
  }

  const component = createToolComponent();
  component.updateResult(
    {
      isError: false,
      content: [
        {
          type: "image",
          data: "aGVsbG8=",
          mimeType: "image/png",
        },
      ],
    },
    false,
  );

  const collapsed = component.render(80);
  assert.ok(collapsed.length >= 3);
  assert.doesNotMatch(collapsed.join("\n"), /image|█/i);

  const originalRender = __getPatchStateForTests()?.originalToolRender;
  assert.ok(originalRender);
  component.setExpanded(true);
  const expanded = component.render(80);
  const expected = originalRender.call(component, 80);
  assert.deepEqual(expanded, expected);
});

test("FFF-style grep results show the call plus two result lines and return expanded", () => {
  const install = installUiPatches();
  if (!install.installed) {
    return;
  }

  for (const toolName of ["grep", "find", "ffgrep", "fffind"]) {
    const component = new ToolExecutionComponent(
      toolName,
      `call-${toolName}`,
      { pattern: "needle", path: "haystack" },
      {},
      {
        name: toolName,
        renderCall: (args: { pattern?: string; path?: string }) =>
          new Text(`${toolName} ${args.pattern} in ${args.path}`, 0, 0),
        renderResult: (
          result: { content: Array<{ type: string; text?: string }> },
          options: { expanded?: boolean },
        ) => {
          if (!options.expanded) {
            return new Text("", 0, 0);
          }
          return new Text(result.content[0]?.text ?? "", 0, 0);
        },
      } as never,
      createTui(),
      process.cwd(),
    );
    component.updateResult(
      {
        isError: false,
        content: [{ type: "text", text: "haystack/one.ts\nhaystack/two.ts\n... 3 more matches" }],
      },
      false,
    );

    const collapsed = component.render(120).join("\n");
    assert.match(collapsed, /needle/);
    assert.match(collapsed, /one\.ts/);
    assert.match(collapsed, /two\.ts/);
    assert.doesNotMatch(collapsed, /more matches/);

    component.setExpanded(true);
    const originalRender = __getPatchStateForTests()?.originalToolRender;
    assert.ok(originalRender);
    const expanded = component.render(120);
    assert.deepEqual(expanded, originalRender.call(component, 120));
    assert.ok(expanded.join("\n").includes("one.ts"));
  }
});

test("working indicator preview summarizes up to three reasoning lines", () => {
  const message = assistantMessage(
    [
      {
        type: "thinking",
        thinking: "# Plan\n\n## Search\nLook for registerTool.",
      },
      { type: "thinking", thinking: "second pass\nwith more detail" },
    ],
    "toolUse",
  );

  const preview = formatThinkingWorkingMessage(message);
  assert.equal(preview.message, "Thinking: second pass · with more detail");
  assert.doesNotMatch(preview.message, /\r?\n/);
});

test("GPT-5.6 fixture with several headings renders the latest five reasoning lines", () => {
  const install = installUiPatches();
  if (!install.installed) {
    return;
  }

  const rendered = renderAssistantTurn(
    assistantMessage(
      [
        {
          type: "thinking",
          thinking:
            "# Plan\n\n## Search\nLook for registerTool.\n\n## Edit\nPatch index.ts.\n\n## Verify\nRun the tests.",
        },
      ],
      "toolUse",
    ),
  );
  assert.doesNotMatch(rendered, /Plan/i, "first lines scroll out of view");
  assert.doesNotMatch(rendered, /Search/i, "first lines scroll out of view");
  assert.match(rendered, /Look for registerTool/i);
  assert.match(rendered, /Patch index/i);
  assert.match(rendered, /Run the tests/i, "the latest streamed line stays visible");
});

test("Ctrl+O expands the full reasoning block and collapses it again", () => {
  const install = installUiPatches();
  if (!install.installed) {
    return;
  }

  const parent = createGroupParent();
  const component = new AssistantMessageComponent();
  const message = assistantMessage(
    [
      {
        type: "thinking",
        thinking:
          "# Plan\n\n## Search\nLook for registerTool.\n\n## Edit\nPatch index.ts.\n\n## Verify\nRun the tests.",
      },
    ],
    "toolUse",
  );
  parent.addChild(component);
  component.updateContent(message);
  assert.match(parent.render(120).join("\n"), /Patch index/i);
  assert.match(parent.render(120).join("\n"), /Run the tests/i);
  assert.doesNotMatch(parent.render(120).join("\n"), /# Plan/);
  component.invalidate();
  assert.match(parent.render(120).join("\n"), /Patch index/i);
  assert.doesNotMatch(parent.render(120).join("\n"), /# Plan/);

  const expandable = component as unknown as { setExpanded(expanded: boolean): void };
  expandable.setExpanded(true);
  const expanded = parent.render(120).join("\n");
  assert.match(expanded, /# Plan/);
  assert.match(expanded, /Patch index/i);

  expandable.setExpanded(false);
  const collapsedAgain = parent.render(120).join("\n");
  assert.match(collapsedAgain, /Patch index/i);
  assert.doesNotMatch(collapsedAgain, /# Plan/);
  component.invalidate();
  expandable.setExpanded(true);
  assert.match(parent.render(120).join("\n"), /# Plan/);
  assert.match(parent.render(120).join("\n"), /Patch index/i);
});

test("several consecutive thinking blocks render the latest compact reasoning segment", () => {
  const install = installUiPatches();
  if (!install.installed) {
    return;
  }

  const rendered = renderAssistantTurn(
    assistantMessage(
      [
        { type: "thinking", thinking: "first pass" },
        { type: "thinking", thinking: "second pass" },
      ],
      "toolUse",
    ),
  );
  assert.match(rendered, /first pass/);
});

test("several separate thinking-only assistant messages each render one line", () => {
  const install = installUiPatches();
  if (!install.installed) {
    return;
  }

  for (const thinking of ["round one", "round two", "round three"]) {
    const rendered = renderAssistantTurn(
      assistantMessage([{ type: "thinking", thinking }], "toolUse"),
    );
    assert.match(rendered, new RegExp(thinking));
  }
});

test("thinking followed by final text preserves the final text", () => {
  const install = installUiPatches();
  if (!install.installed) {
    return;
  }

  const rendered = renderAssistantTurn(
    assistantMessage(
      [
        { type: "thinking", thinking: "hidden reasoning" },
        { type: "text", text: "Here is the final answer." },
      ],
      "stop",
    ),
  );
  assert.match(rendered, /final answer/);
  assert.match(rendered, /hidden reasoning/);
});

test("length, aborted, and error stop reasons remain visible", () => {
  const install = installUiPatches();
  if (!install.installed) {
    return;
  }

  const cases: AssistantMessage[] = [
    assistantMessage([{ type: "text", text: "partial" }], "length"),
    assistantMessage([{ type: "text", text: "partial" }], "aborted", {
      errorMessage: "Request was aborted",
    }),
    assistantMessage([{ type: "text", text: "partial" }], "error", {
      errorMessage: "Provider exploded",
    }),
  ];

  for (const message of cases) {
    const component = new AssistantMessageComponent();
    component.updateContent(message);
    const rendered = component.render(120).join("\n");
    if (message.stopReason === "length") {
      assert.match(rendered, /maximum output token limit/i);
    } else if (message.stopReason === "aborted") {
      assert.match(rendered, /aborted/i);
    } else {
      assert.match(rendered, /Provider exploded/);
    }
  }
});

test("frozen input messages prove the wrapper does not mutate session data", () => {
  const install = installUiPatches();
  if (!install.installed) {
    return;
  }

  const thinking = Object.freeze({ type: "thinking" as const, thinking: "secret" });
  const text = Object.freeze({ type: "text" as const, text: "visible" });
  const content = Object.freeze([thinking, text]);
  const message = Object.freeze({
    role: "assistant" as const,
    content,
    api: "openai-responses" as const,
    provider: "openai" as const,
    model: "gpt-test",
    timestamp: 1,
    stopReason: "stop" as const,
    usage: Object.freeze(testUsage()),
  }) as AssistantMessage;

  const component = new AssistantMessageComponent();
  component.updateContent(message);
  assert.equal(content.length, 2);
  assert.equal(content[0], thinking);
  assert.equal(Object.isFrozen(message), true);
});

test("installation is idempotent", () => {
  const first = installUiPatches();
  const second = installUiPatches();
  if (!first.installed) {
    assert.equal(second.installed, false);
    return;
  }
  assert.equal(second.installed, true);
  assert.equal(__getPatchStateForTests()?.refCount, 2);
  releaseUiPatches();
  assert.equal(__getPatchStateForTests()?.refCount, 1);
});

test("restoration restores the exact saved methods", () => {
  const toolContainerPrototype = Object.getPrototypeOf(ToolExecutionComponent.prototype) as Container;
  const beforeAddChild = toolContainerPrototype.addChild;
  const beforeRender = ToolExecutionComponent.prototype.render;
  const beforeSetExpanded = ToolExecutionComponent.prototype.setExpanded;
  const beforeUpdateContent = AssistantMessageComponent.prototype.updateContent;
  const beforeAssistantSetExpanded = (AssistantMessageComponent.prototype as unknown as {
    setExpanded?: (expanded: boolean) => void;
  }).setExpanded;

  const install = installUiPatches();
  if (!install.installed) {
    return;
  }

  assert.notEqual(ToolExecutionComponent.prototype.render, beforeRender);
  releaseUiPatches();
  assert.equal(toolContainerPrototype.addChild, beforeAddChild);
  assert.equal(ToolExecutionComponent.prototype.render, beforeRender);
  assert.equal(ToolExecutionComponent.prototype.setExpanded, beforeSetExpanded);
  assert.equal(AssistantMessageComponent.prototype.updateContent, beforeUpdateContent);
  assert.equal(
    (AssistantMessageComponent.prototype as unknown as {
      setExpanded?: (expanded: boolean) => void;
    }).setExpanded,
    beforeAssistantSetExpanded,
  );
});

test("unsupported Pi versions leave original rendering active", () => {
  assert.equal(isSupportedPiVersion(VERSION), VERSION.startsWith("0.83."));
  if (VERSION.startsWith("0.83.")) {
    return;
  }

  const beforeRender = ToolExecutionComponent.prototype.render;
  const result = installUiPatches();
  assert.equal(result.installed, false);
  assert.ok(result.reason);
  assert.equal(ToolExecutionComponent.prototype.render, beforeRender);
});

test("extension leaves pi's default working message untouched", () => {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const pi = {
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
      handlers.set(event, handler);
    },
  } as unknown as ExtensionAPI;
  compactOutputExtension(pi);

  let setWorkingMessageCalls = 0;
  const ctx = {
    mode: "tui",
    cwd: process.cwd(),
    isProjectTrusted: () => true,
    ui: {
      setWorkingMessage() {
        setWorkingMessageCalls++;
      },
    },
  } as unknown as ExtensionContext;

  const sessionStart = handlers.get("session_start");
  assert.ok(sessionStart);
  sessionStart({}, ctx);

  // The agent handlers only drive the reasoning loading sign; the floating
  // line stays pi's own "Working..." and never mirrors reasoning content.
  const agentStart = handlers.get("agent_start");
  assert.ok(agentStart);
  agentStart({}, ctx);
  const agentEnd = handlers.get("agent_end");
  assert.ok(agentEnd);
  agentEnd({}, ctx);
  assert.equal(handlers.get("message_update"), undefined);
  assert.equal(setWorkingMessageCalls, 0);
});

test("compact reasoning renders a bordered header with a loading sign while streaming", () => {
  const install = installUiPatches();
  if (!install.installed) {
    return;
  }

  const parent = createGroupParent();
  const component = new AssistantMessageComponent();
  parent.addChild(component);
  component.updateContent(
    assistantMessage([{ type: "thinking", thinking: "Inspect the registry." }], "toolUse"),
  );

  const done = parent.render(120).join("\n");
  assert.match(done, /Reasoning/, "header label on the border");
  assert.match(done, /╭/, "top border");
  assert.match(done, /╯/, "bottom border");
  assert.match(done, /│/, "side borders");
  assert.doesNotMatch(done, /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/, "no loading sign when idle");

  setReasoningStreaming(true);
  const streaming = parent.render(120).join("\n");
  assert.match(streaming, /Reasoning/);
  assert.match(streaming, /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/, "loading sign while streaming");

  setReasoningStreaming(false);
  const stopped = parent.render(120).join("\n");
  assert.doesNotMatch(stopped, /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
});

test("streaming within one reasoning segment keeps the first compact preview", () => {
  const install = installUiPatches();
  if (!install.installed) {
    return;
  }

  const first = assistantMessage([{ type: "thinking", thinking: "alpha" }], "toolUse");
  const second = assistantMessage([{ type: "thinking", thinking: "alpha beta" }], "toolUse");
  const firstPreview = formatThinkingWorkingMessage(first);
  const secondPreview = formatThinkingWorkingMessage(second, firstPreview.state);
  assert.equal(firstPreview.message, "Thinking: alpha");
  assert.equal(secondPreview.message, "Thinking: alpha");
});

test("streaming within one reasoning segment grows the compact transcript preview", () => {
  const install = installUiPatches();
  if (!install.installed) {
    return;
  }

  const parent = createGroupParent();
  const component = new AssistantMessageComponent();
  parent.addChild(component);

  component.updateContent(assistantMessage([{ type: "thinking", thinking: "The" }], "toolUse"));
  const firstRender = parent.render(120).join("\n");
  assert.match(firstRender, /The/);
  assert.doesNotMatch(firstRender, /registry/);

  component.updateContent(
    assistantMessage(
      [{ type: "thinking", thinking: "The plan is to search the registry for registerTool." }],
      "toolUse",
    ),
  );
  const secondRender = parent.render(120).join("\n");
  assert.match(secondRender, /plan is to search the registry/);
});

test("setCompactOutputLimits controls tool and reasoning line counts", () => {
  const install = installUiPatches();
  if (!install.installed) {
    return;
  }

  setCompactOutputLimits(2, 2);

  // Tool group: two tools, only two lines shown.
  const toolParent = createGroupParent();
  const assistant = new AssistantMessageComponent();
  toolParent.addChild(assistant);
  assistant.updateContent(
    assistantMessage(
      [
        { type: "toolCall", id: "t1", name: "grep", arguments: {} },
        { type: "toolCall", id: "t2", name: "read", arguments: {} },
      ],
      "toolUse",
    ),
  );
  for (const id of ["t1", "t2"]) {
    toolParent.addChild(
      new ToolExecutionComponent(
        id === "t1" ? "grep" : "read",
        id,
        {},
        {},
        {
          name: id === "t1" ? "grep" : "read",
          renderCall: () => new Text(id === "t1" ? "grep t1" : "read t2", 0, 0),
          renderResult: () => new Text("", 0, 0),
        } as never,
        createTui(),
        process.cwd(),
      ),
    );
  }
  const toolRendered = toolParent.render(120).join("\n");
  assert.match(toolRendered, /read t2 · \+1 more/);

  // Reasoning: three lines of thinking, only two shown (auto-scroll keeps the tail).
  const reasonParent = createGroupParent();
  const reasonAssistant = new AssistantMessageComponent();
  reasonParent.addChild(reasonAssistant);
  reasonAssistant.updateContent(
    assistantMessage(
      [{ type: "thinking", thinking: "one\ntwo\nthree" }],
      "toolUse",
    ),
  );
  const reasonRendered = reasonParent.render(120).join("\n");
  assert.doesNotMatch(reasonRendered, /one/);
  assert.match(reasonRendered, /two/);
  assert.match(reasonRendered, /three/);
});

test("compact reasoning auto-scrolls to the latest five lines while collapsed", () => {
  const install = installUiPatches();
  if (!install.installed) {
    return;
  }

  const parent = createGroupParent();
  const component = new AssistantMessageComponent();
  parent.addChild(component);
  const thinking = Array.from({ length: 7 }, (_, i) => `line ${i + 1}`).join("\n");
  component.updateContent(assistantMessage([{ type: "thinking", thinking }], "toolUse"));

  const rendered = parent.render(120).join("\n");
  assert.doesNotMatch(rendered, /line 1/, "first lines scroll out of view");
  assert.doesNotMatch(rendered, /line 2/, "first lines scroll out of view");
  assert.match(rendered, /line 3/);
  assert.match(rendered, /line 7/, "the latest streamed line stays visible");
});

test("codex commentary text is hidden while thinking is compact", () => {
  const install = installUiPatches();
  if (!install.installed) {
    return;
  }

  const parent = createGroupParent();
  const component = new AssistantMessageComponent();
  parent.addChild(component);
  component.updateContent(
    assistantMessage(
      [
        { type: "thinking", thinking: "Inspect the registry." },
        {
          type: "text",
          text: "Inspect the registry.",
          textSignature: JSON.stringify({ v: 1, id: "msg_1", phase: "commentary" }),
        },
      ],
      "toolUse",
    ),
  );
  const collapsed = parent.render(120).join("\n");
  assert.match(collapsed, /Inspect the registry/i);
  assert.equal((collapsed.match(/Inspect the registry/gi) ?? []).length, 1);

  const expandable = component as unknown as { setExpanded(expanded: boolean): void };
  expandable.setExpanded(true);
  const expanded = parent.render(120).join("\n");
  assert.match(expanded, /Inspect the registry/i);
  assert.doesNotMatch(expanded, /Thinking\.\.\./i);
  assert.equal((expanded.match(/Inspect the registry/gi) ?? []).length, 1);
});

test("reasoning and tool groups stay in content order", () => {
  const install = installUiPatches();
  if (!install.installed) {
    return;
  }

  const rendered = renderAssistantTurn(
    assistantMessage(
      [
        { type: "thinking", thinking: "before tools" },
        { type: "toolCall", id: "t1", name: "read", arguments: {} },
        { type: "toolCall", id: "t2", name: "edit", arguments: {} },
        { type: "thinking", thinking: "after tools" },
        { type: "toolCall", id: "t3", name: "bash", arguments: {} },
      ],
      "toolUse",
    ),
    [
      { id: "t1", name: "read", description: "read one.ts" },
      { id: "t2", name: "edit", description: "edit two.ts" },
      { id: "t3", name: "bash", description: "npm test" },
    ],
  );

  const beforeIdx = rendered.indexOf("before tools");
  const toolGroupIdx = rendered.indexOf("edit two.ts");
  const afterIdx = rendered.indexOf("after tools");
  const bashIdx = rendered.indexOf("npm test");
  assert.ok(beforeIdx >= 0 && toolGroupIdx >= 0 && afterIdx >= 0 && bashIdx >= 0);
  assert.ok(beforeIdx < toolGroupIdx);
  assert.ok(toolGroupIdx < afterIdx);
  assert.ok(afterIdx < bashIdx);
});

test("re-created components for finished tools keep one block per run", () => {
  const install = installUiPatches();
  if (!install.installed) {
    return;
  }

  const parent = createGroupParent();
  const assistant = new AssistantMessageComponent();
  parent.addChild(assistant);
  const pendingTools = new Map<string, ToolExecutionComponent>();
  const toolCall = (id: string, name: string) => ({
    type: "toolCall" as const,
    id,
    name,
    arguments: {},
  });

  const makeTool = (id: string, name: string) => {
    const component = new ToolExecutionComponent(
      name,
      id,
      {},
      {},
      {
        name,
        renderCall: () => new Text(`${name} ${id}`, 0, 0),
        renderResult: () => new Text("", 0, 0),
      } as never,
      createTui(),
      process.cwd(),
    );
    component.setExpanded(false);
    return component;
  };

  // Mirrors pi's message_update: updateContent, then create components for
  // toolCalls that are not pending (finished tools get re-created as ghosts).
  const messageUpdate = (message: AssistantMessage) => {
    assistant.updateContent(message);
    for (const content of message.content) {
      if (content.type === "toolCall" && !pendingTools.has(content.id)) {
        const component = makeTool(content.id, content.name);
        parent.addChild(component);
        pendingTools.set(content.id, component);
      }
    }
  };

  // First tool run: t1, t2 — both finish before the next chunk arrives.
  messageUpdate(assistantMessage([toolCall("t1", "grep"), toolCall("t2", "read")], "toolUse"));
  pendingTools.delete("t1");
  pendingTools.delete("t2");

  // Next chunk re-lists t1/t2 (finished => pi re-creates ghost components),
  // then a reasoning block and the second tool run t3.
  messageUpdate(
    assistantMessage(
      [
        toolCall("t1", "grep"),
        toolCall("t2", "read"),
        { type: "thinking", thinking: "Now check the second thing." },
        toolCall("t3", "grep"),
      ],
      "toolUse",
    ),
  );

  const rendered = parent.render(120).join("\n");
  assert.match(rendered, /read t2/);
  assert.equal(
    (rendered.match(/read t2/g) ?? []).length,
    1,
    "ghost re-creations must not render a duplicate block",
  );
  assert.match(rendered, /Now check the second thing/);
  assert.match(rendered, /grep t3/);
  assert.ok(rendered.indexOf("read t2") < rendered.indexOf("Now check"), "first run before reasoning");
  assert.ok(rendered.indexOf("Now check") < rendered.indexOf("grep t3"), "reasoning before second run");
});

test("tool runs in separate turns keep their own blocks", () => {
  const install = installUiPatches();
  if (!install.installed) {
    return;
  }

  const parent = createGroupParent();
  const toolCall = (id: string, name: string) => ({
    type: "toolCall" as const,
    id,
    name,
    arguments: {},
  });

  const makeTool = (id: string, name: string) => {
    const component = new ToolExecutionComponent(
      name,
      id,
      {},
      {},
      {
        name,
        renderCall: () => new Text(`${name} ${id}`, 0, 0),
        renderResult: () => new Text("", 0, 0),
      } as never,
      createTui(),
      process.cwd(),
    );
    component.setExpanded(false);
    return component;
  };

  const runTurn = (tools: Array<[string, string]>) => {
    const assistant = new AssistantMessageComponent();
    parent.addChild(assistant);
    assistant.updateContent(
      assistantMessage(tools.map(([id, name]) => toolCall(id, name)), "toolUse"),
    );
    for (const [id, name] of tools) {
      parent.addChild(makeTool(id, name));
    }
  };

  // Turn 1: t1, t2 finish; user sends a new input; turn 2: t3, t4 run.
  runTurn([["t1", "grep"], ["t2", "read"]]);
  runTurn([["t3", "grep"], ["t4", "edit"]]);

  const rendered = parent.render(120).join("\n");
  assert.match(rendered, /read t2 · \+1 more/, "first turn keeps its block");
  assert.match(rendered, /edit t4 · \+1 more/, "second turn gets its own block");
  assert.doesNotMatch(rendered, /\+3 more/, "runs must not merge across turns");
});

test("assistant component hides original thinking while compact block renders it", () => {
  const install = installUiPatches();
  if (!install.installed) {
    return;
  }

  const parent = createGroupParent();
  const assistant = new AssistantMessageComponent(undefined, false);
  parent.addChild(assistant);
  assistant.updateContent(
    assistantMessage([{ type: "thinking", thinking: "secret reasoning" }], "toolUse"),
  );

  assert.doesNotMatch(assistant.render(120).join("\n"), /secret reasoning/i);
  assert.match(parent.render(120).join("\n"), /secret reasoning/i);
});

test("extension never calls registerTool", () => {
  let registerToolCalls = 0;
  const pi = {
    on() {},
    registerTool() {
      registerToolCalls++;
    },
  } as unknown as ExtensionAPI;

  compactOutputExtension(pi);
  assert.equal(registerToolCalls, 0);
});

test("consecutive tools collapse to one line with the last tool's message, and expand first-to-last", () => {
  const install = installUiPatches();
  if (!install.installed) {
    return;
  }

  const parent = createGroupParent();
  const makeTool = (name: string, description: string) =>
    new ToolExecutionComponent(
      name,
      `call-${name}`,
      {},
      {},
      {
        name,
        renderCall: () => new Text(description, 0, 0),
        renderResult: () => new Text("", 0, 0),
      } as never,
      createTui(),
      process.cwd(),
    );

  const first = makeTool("read", "read first.ts");
  const second = makeTool("edit", "edit second.ts");
  first.setExpanded(false);
  second.setExpanded(false);
  first.updateResult({ isError: false, content: [] }, false);
  second.updateResult({ isError: false, content: [] }, false);
  parent.addChild(first);
  parent.addChild(second);

  const collapsedLines = parent.render(100);
  const collapsed = collapsedLines.join("\n");
  assert.ok(collapsedLines.length >= 5, "padded three-line tool area with margins");
  assert.match(collapsed, /🔧 edit second\.ts/);
  assert.match(collapsed, /\+1 more/);
  assert.doesNotMatch(collapsed, /read first\.ts/);
  assert.ok(collapsedLines.every((line) => visibleWidth(line) <= 100));

  first.setExpanded(true);
  second.setExpanded(true);
  const expanded = parent.render(100).join("\n");
  assert.ok(expanded.indexOf("read first.ts") < expanded.indexOf("edit second.ts"));
});

test("collapsed group shows the last tool's call and result lines, never earlier results", () => {
  const install = installUiPatches();
  if (!install.installed) {
    return;
  }

  const parent = createGroupParent();
  const grep = new ToolExecutionComponent(
    "grep",
    "call-grep",
    { pattern: "/needle/", path: "haystack" },
    {},
    {
      name: "grep",
      renderCall: (args: { pattern?: string; path?: string }) =>
        new Text(`grep ${args.pattern ?? ""} in ${args.path ?? ""}`, 0, 0),
      renderResult: (result: { content: Array<{ type: string; text?: string }> }) =>
        new Text(result.content[0]?.text ?? "", 0, 0),
    } as never,
    createTui(),
    process.cwd(),
  );
  const fffTool = new ToolExecutionComponent(
    "read",
    "call-read",
    { path: "haystack/one.ts" },
    {},
    {
      name: "read",
      renderCall: (args: { path?: string }) => new Text(`read ${args.path ?? ""}`, 0, 0),
      renderResult: (
        result: { content: Array<{ type: string; text?: string }> },
        options: { expanded?: boolean },
      ) => {
        if (!options.expanded) {
          return new Text("", 0, 0);
        }
        return new Text(result.content[0]?.text ?? "", 0, 0);
      },
    } as never,
    createTui(),
    process.cwd(),
  );
  grep.updateResult(
    { isError: false, content: [{ type: "text", text: "haystack/one.ts:1:export" }] },
    false,
  );
  fffTool.updateResult(
    { isError: false, content: [{ type: "text", text: "SECRET BUFFER" }] },
    false,
  );
  parent.addChild(grep);
  parent.addChild(fffTool);

  const collapsed = parent.render(100).join("\n");
  assert.match(collapsed, /🔧 read haystack\/one\.ts/);
  assert.match(collapsed, /SECRET BUFFER/);
  assert.doesNotMatch(collapsed, /one\.ts:1:export/);
  assert.match(collapsed, /\+1 more/);

  grep.setExpanded(true);
  fffTool.setExpanded(true);
  const expanded = parent.render(100).join("\n");
  assert.ok(expanded.includes("SECRET BUFFER"));
  assert.ok(expanded.indexOf("grep /needle/ in haystack") < expanded.indexOf("read haystack/one.ts"));
});

test("compact render uses call renderer first line for real ToolExecutionComponent", () => {
  const install = installUiPatches();
  if (!install.installed) {
    return;
  }

  const component = createToolComponent();
  component.markExecutionStarted();
  component.setArgsComplete();
  component.updateResult({ isError: false, content: [] }, false);

  const collapsed = component.render(120);
  assert.ok(collapsed.length >= 3);
  assert.match(collapsed.join("\n"), /grep \/registerTool\/ in packages/);
});

test("invalid runtime shape falls back to the original renderer", () => {
  const install = installUiPatches();
  if (!install.installed) {
    return;
  }

  const component = createToolComponent();
  assert.ok(tryReadToolExecutionInternals(component));

  (component as unknown as { toolName: unknown }).toolName = 42;
  assert.equal(tryReadToolExecutionInternals(component), undefined);

  const originalRender = __getPatchStateForTests()?.originalToolRender;
  assert.ok(originalRender);
  const expected = originalRender.call(component, 80);
  assert.deepEqual(component.render(80), expected);
});

test("custom image renderer is not shown collapsed", () => {
  const install = installUiPatches();
  if (!install.installed) {
    return;
  }

  const component = new ToolExecutionComponent(
    "screenshot",
    "img-1",
    {},
    {},
    {
      name: "screenshot",
      renderCall: () => new Text("capture desktop", 0, 0),
      renderResult: () =>
        new Image("aGVsbG8=", "image/png", { fallbackColor: (s: string) => s }, { maxWidthCells: 20 }),
    } as never,
    createTui(),
    process.cwd(),
  );
  component.updateResult(
    {
      isError: false,
      content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
    },
    false,
  );

  const collapsed = component.render(80).join("\n");
  assert.match(collapsed, /capture desktop/);
  assert.doesNotMatch(collapsed, /█/);
});
