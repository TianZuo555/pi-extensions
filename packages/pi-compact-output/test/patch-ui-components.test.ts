import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  AssistantMessageComponent,
  initTheme,
  ToolExecutionComponent,
  VERSION,
} from "@earendil-works/pi-coding-agent";
import { Image, Text, type TUI } from "@earendil-works/pi-tui";
import compactOutputExtension from "../index.ts";
import {
  __getPatchStateForTests,
  __resetPatchStateForTests,
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

test("images are absent collapsed and restored by the original expanded renderer", () => {
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
  assert.equal(collapsed.length, 1);
  assert.doesNotMatch(collapsed[0], /image|█/i);

  const originalRender = __getPatchStateForTests()?.originalToolRender;
  assert.ok(originalRender);
  component.setExpanded(true);
  const expanded = component.render(80);
  const expected = originalRender.call(component, 80);
  assert.deepEqual(expanded, expected);
});

test("FFF-style grep results disappear collapsed and return expanded", () => {
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

    const collapsed = component.render(120)[0];
    assert.match(collapsed, /needle/);
    assert.doesNotMatch(collapsed, /one\.ts/);
    assert.doesNotMatch(collapsed, /more matches/);

    component.setExpanded(true);
    const originalRender = __getPatchStateForTests()?.originalToolRender;
    assert.ok(originalRender);
    const expanded = component.render(120);
    assert.deepEqual(expanded, originalRender.call(component, 120));
    assert.ok(expanded.join("\n").includes("one.ts"));
  }
});

test("GPT-5.6 fixture with several headings in a thinking block renders no reasoning", () => {
  const install = installUiPatches();
  if (!install.installed) {
    return;
  }

  const component = new AssistantMessageComponent();
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
  assert.doesNotMatch(rendered, /Plan|Search|Patch index/i);
});

test("several consecutive thinking blocks render no reasoning", () => {
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
  assert.equal(component.render(120).join("\n").trim(), "");
});

test("several separate thinking-only assistant messages each render no transcript lines", () => {
  const install = installUiPatches();
  if (!install.installed) {
    return;
  }

  for (const thinking of ["round one", "round two", "round three"]) {
    const component = new AssistantMessageComponent();
    component.updateContent(
      assistantMessage([{ type: "thinking", thinking }], "toolUse"),
    );
    assert.equal(component.render(120).join("\n").trim(), "");
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
  assert.match(component.render(120).join("\n"), /final answer/);
  assert.doesNotMatch(component.render(120).join("\n"), /hidden reasoning/);
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
  const beforeRender = ToolExecutionComponent.prototype.render;
  const beforeSetExpanded = ToolExecutionComponent.prototype.setExpanded;
  const beforeUpdateContent = AssistantMessageComponent.prototype.updateContent;

  const install = installUiPatches();
  if (!install.installed) {
    return;
  }

  assert.notEqual(ToolExecutionComponent.prototype.render, beforeRender);
  releaseUiPatches();
  assert.equal(ToolExecutionComponent.prototype.render, beforeRender);
  assert.equal(ToolExecutionComponent.prototype.setExpanded, beforeSetExpanded);
  assert.equal(AssistantMessageComponent.prototype.updateContent, beforeUpdateContent);
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
  assert.equal(collapsed.length, 1);
  assert.match(collapsed[0], /grep \/registerTool\/ in packages/);
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
