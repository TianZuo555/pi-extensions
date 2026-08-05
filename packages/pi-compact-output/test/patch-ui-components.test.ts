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

test("FFF-style grep results show one collapsed line and return expanded", () => {
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
    assert.doesNotMatch(collapsed, /one\.ts/);
    assert.doesNotMatch(collapsed, /two\.ts/);
    assert.doesNotMatch(collapsed, /more matches/);

    component.setExpanded(true);
    const originalRender = __getPatchStateForTests()?.originalToolRender;
    assert.ok(originalRender);
    const expanded = component.render(120);
    assert.deepEqual(expanded, originalRender.call(component, 120));
    assert.ok(expanded.join("\n").includes("one.ts"));
  }
});

test("working indicator preview keeps reasoning on one line", () => {
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
  assert.equal(preview, "Thinking: # Plan · second pass");
  assert.doesNotMatch(preview, /\r?\n/);
});

test("GPT-5.6 fixture with several headings in a thinking block renders one reasoning line", () => {
  const install = installUiPatches();
  if (!install.installed) {
    return;
  }

  const component = new AssistantMessageComponent(undefined, true);
  component.updateContent(
    assistantMessage(
      [
        {
          type: "thinking",
          thinking: "# Plan\n\n## Search\nLook for registerTool.\n\n## Edit\nPatch index.ts.",
        },
      ],
      "toolUse",
    ),
  );
  const rendered = component.render(120).join("\n");
  assert.match(rendered, /Plan/i);
  assert.doesNotMatch(rendered, /Search|Patch index/i);
  assert.equal(
    (component as unknown as { hideThinkingBlock: boolean }).hideThinkingBlock,
    true,
  );
});

test("Ctrl+O expands the full reasoning block and collapses it again", () => {
  const install = installUiPatches();
  if (!install.installed) {
    return;
  }

  const component = new AssistantMessageComponent();
  const message = assistantMessage(
    [
      {
        type: "thinking",
        thinking: "# Plan\n\n## Search\nLook for registerTool.\n\n## Edit\nPatch index.ts.",
      },
    ],
    "toolUse",
  );
  component.updateContent(message);
  assert.match(component.render(120).join("\n"), /Plan/i);
  assert.doesNotMatch(component.render(120).join("\n"), /Search|Patch index/i);
  component.invalidate();
  assert.match(component.render(120).join("\n"), /Plan/i);
  assert.doesNotMatch(component.render(120).join("\n"), /Search|Patch index/i);

  const expandable = component as unknown as { setExpanded(expanded: boolean): void };
  expandable.setExpanded(true);
  const expanded = component.render(120).join("\n");
  assert.match(expanded, /Plan|Search|Patch index/i);

  expandable.setExpanded(false);
  const collapsedAgain = component.render(120).join("\n");
  assert.match(collapsedAgain, /Plan/i);
  assert.doesNotMatch(collapsedAgain, /Search|Patch index/i);
  component.invalidate();
  expandable.setExpanded(true);
  assert.match(component.render(120).join("\n"), /Plan|Search|Patch index/i);
});

test("several consecutive thinking blocks render one compact reasoning line", () => {
  const install = installUiPatches();
  if (!install.installed) {
    return;
  }

  const component = new AssistantMessageComponent();
  component.updateContent(
    assistantMessage(
      [
        { type: "thinking", thinking: "first pass" },
        { type: "thinking", thinking: "second pass" },
      ],
      "toolUse",
    ),
  );
  assert.match(component.render(120).join("\n"), /first pass · second pass/);
});

test("several separate thinking-only assistant messages each render one line", () => {
  const install = installUiPatches();
  if (!install.installed) {
    return;
  }

  for (const thinking of ["round one", "round two", "round three"]) {
    const component = new AssistantMessageComponent();
    component.updateContent(
      assistantMessage([{ type: "thinking", thinking }], "toolUse"),
    );
    assert.match(component.render(120).join("\n"), new RegExp(thinking));
  }
});

test("thinking followed by final text preserves the final text", () => {
  const install = installUiPatches();
  if (!install.installed) {
    return;
  }

  const component = new AssistantMessageComponent();
  component.updateContent(
    assistantMessage(
      [
        { type: "thinking", thinking: "hidden reasoning" },
        { type: "text", text: "Here is the final answer." },
      ],
      "stop",
    ),
  );
  const rendered = component.render(120).join("\n");
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

test("live assistant updates put the one-line reasoning preview in the working message", () => {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const pi = {
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
      handlers.set(event, handler);
    },
  } as unknown as ExtensionAPI;
  compactOutputExtension(pi);

  let workingMessage: string | undefined;
  const ctx = {
    mode: "tui",
    ui: {
      setWorkingMessage(message?: string) {
        workingMessage = message;
      },
    },
  } as unknown as ExtensionContext;
  const handler = handlers.get("message_update");
  assert.ok(handler);
  handler(
    {
      message: assistantMessage(
        [{ type: "thinking", thinking: "# Plan\n\n## Search\nInspect the registry." }],
        "toolUse",
      ),
    },
    ctx,
  );
  assert.equal(workingMessage, "Thinking: # Plan");
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
  assert.ok(collapsedLines.length === 3, "one padded line area");
  assert.match(collapsed, /🔧 edit second\.ts/);
  assert.match(collapsed, /\+1 more/);
  assert.doesNotMatch(collapsed, /read first\.ts/);
  assert.ok(collapsedLines.every((line) => visibleWidth(line) <= 100));

  first.setExpanded(true);
  second.setExpanded(true);
  const expanded = parent.render(100).join("\n");
  assert.ok(expanded.indexOf("read first.ts") < expanded.indexOf("edit second.ts"));
});

test("collapsed group shows only the last tool's call — no result preview", () => {
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
  assert.doesNotMatch(collapsed, /SECRET BUFFER/);
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
