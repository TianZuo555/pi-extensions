import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import backgroundTerminals, { createBackgroundTerminalsExtension } from "../index.ts";

function command(script: string) {
  const encoded = Buffer.from(script).toString("base64");
  return `node -e "eval(Buffer.from('${encoded}','base64').toString())"`;
}

const testExtension = createBackgroundTerminalsExtension({
  resolveShellSettings: () => ({}),
});

function harness(extension = testExtension) {
  const handlers = new Map<string, Array<(...args: any[]) => any>>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const messageRenderers = new Map<string, any>();
  const messages: Array<{ message: any; options: any }> = [];

  const pi = {
    on(name: string, handler: (...args: any[]) => any) {
      const current = handlers.get(name) ?? [];
      current.push(handler);
      handlers.set(name, current);
    },
    registerTool(definition: any) {
      tools.set(definition.name, definition);
    },
    registerCommand(name: string, definition: any) {
      commands.set(name, definition);
    },
    registerMessageRenderer(name: string, renderer: any) {
      messageRenderers.set(name, renderer);
    },
    getThinkingLevel() {
      return "high";
    },
    sendMessage(message: any, options: any) {
      messages.push({ message, options });
    },
  } as unknown as ExtensionAPI;

  extension(pi);
  const ctx = {
    cwd: process.cwd(),
    hasUI: false,
    mode: "print",
    isIdle: () => true,
    isProjectTrusted: () => false,
    model: { provider: "test-provider", id: "test-model" },
    sessionManager: {
      getSessionId: () => "test-session",
      getSessionFile: () => "/tmp/test-session.jsonl",
    },
  } as any;
  for (const handler of handlers.get("session_start") ?? []) {
    handler({}, ctx);
  }

  return {
    pi,
    handlers,
    tools,
    commands,
    messageRenderers,
    messages,
    ctx,
    async shutdown() {
      for (const handler of handlers.get("session_shutdown") ?? []) {
        await handler({}, ctx);
      }
    },
  };
}

async function pollUntil(
  check: () => boolean,
  timeoutMs = process.platform === "win32" ? 15_000 : 5_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return true;
}

test("a pre-aborted Bash call does not initialize or spawn", async () => {
  let initialized = false;
  const app = harness(
    createBackgroundTerminalsExtension({
      resolveShellSettings: () => ({}),
      createRuntime: () => {
        initialized = true;
        throw new Error("must not initialize");
      },
      createForegroundBash: () => {
        throw new Error("must not fall back");
      },
    }),
  );
  const controller = new AbortController();
  controller.abort();
  try {
    await assert.rejects(
      app.tools
        .get("bash")
        .execute("aborted", { command: "echo forbidden" }, controller.signal, undefined, app.ctx),
      { name: "AbortError" },
    );
    assert.equal(initialized, false);
  } finally {
    await app.shutdown();
  }
});

test("cancellation during manager initialization prevents spawn and fallback", async () => {
  const { createTerminalRuntime } = await import("../src/runtime.ts");
  const { TerminalManager } = await import("../src/manager.ts");
  const runtime = createTerminalRuntime();
  const controller = new AbortController();
  const manager = await runtime.runPromise(TerminalManager);
  const abortingRuntime = new Proxy(runtime, {
    get(target, property, receiver) {
      if (property !== "runPromise") return Reflect.get(target, property, receiver);
      return (effect: Parameters<typeof runtime.runPromise>[0]) => {
        const result = runtime.runPromise(effect);
        controller.abort();
        return result;
      };
    },
  });
  const app = harness(
    createBackgroundTerminalsExtension({
      resolveShellSettings: () => ({}),
      createRuntime: () => abortingRuntime,
      createForegroundBash: () => {
        throw new Error("must not fall back");
      },
    }),
  );
  try {
    await assert.rejects(
      app.tools
        .get("bash")
        .execute(
          "aborted-init",
          { command: "echo forbidden" },
          controller.signal,
          undefined,
          app.ctx,
        ),
      { name: "AbortError" },
    );
    assert.equal(manager.view.size(), 0);
  } finally {
    await app.shutdown();
  }
});

test("extension overrides bash, adds log reading, and keeps the user /ps command", async () => {
  const app = harness(backgroundTerminals);
  try {
    assert.deepEqual([...app.tools.keys()], ["bash", "terminal_log_read"]);
    assert.equal(app.tools.get("terminal_log_read").promptSnippet, "Read a terminal archive page");
    assert.ok(app.tools.get("terminal_log_read").outputSchema);
    assert.equal(app.tools.get("terminal_log_read").promptGuidelines, undefined);
    assert.deepEqual([...app.commands.keys()], ["ps"]);
  } finally {
    await app.shutdown();
  }
});

test("background tool metadata stays concise", async () => {
  const app = harness(backgroundTerminals);
  try {
    const budgets = new Map([
      ["bash", 1_050],
      ["terminal_log_read", 520],
    ]);

    for (const [name, tool] of app.tools) {
      for (const [parameter, schema] of Object.entries(tool.parameters.properties)) {
        assert.ok(
          (schema as { description?: string }).description,
          `${name}.${parameter} has no description`,
        );
      }
      const modelChars =
        JSON.stringify({
          name,
          description: tool.description,
          parameters: tool.parameters,
        }).length +
        (tool.promptSnippet?.length ?? 0) +
        (tool.promptGuidelines ?? []).reduce(
          (total: number, guideline: string) => total + guideline.length,
          0,
        );
      assert.ok(
        modelChars <= budgets.get(name)!,
        `${name} prompt budget exceeded: ${modelChars} chars`,
      );
    }
  } finally {
    await app.shutdown();
  }
});

test("terminal_log_read validates opaque refs and bounded pages", async () => {
  const app = harness();
  try {
    const schema = app.tools.get("terminal_log_read").parameters;
    assert.equal(Check(schema, { ref: "bt-1:stdout" }), true);
    assert.equal(Check(schema, { ref: "bt-1:stdout", offset: 0, limit: 64 * 1024 }), true);
    assert.equal(Check(schema, { ref: "bt-1:stdout", limit: 64 * 1024 + 1 }), false);
    assert.equal(Check(schema, { ref: "bt-1:stdout", offset: -1 }), false);
  } finally {
    await app.shutdown();
  }
});

test("terminal_log_read resolves an opaque ref from bash", async () => {
  const app = harness();
  try {
    const result = await app.tools.get("bash").execute(
      "call-log-source",
      {
        command: command('process.stdout.write("0123456789".repeat(20_000))'),
        yield_time_ms: 30_000,
      },
      undefined,
      undefined,
      app.ctx,
    );
    const ref = /archive ref (bt-[a-f0-9]{16}-\d+:stdout)/.exec(result.content[0].text)?.[1];
    assert.ok(ref, result.content[0].text);

    const page = await app.tools
      .get("terminal_log_read")
      .execute("call-log-read", { ref, offset: 0, limit: 1_024 }, undefined, undefined, app.ctx);
    assert.match(page.content[0].text, /bytes 0-1023/);
    assert.match(page.content[0].text, /settled: yes/);
    assert.match(page.content[0].text, /complete: yes/);
    assert.match(page.content[0].text, /0123456789/);
    assert.equal(page.structuredContent.text.slice(0, 10), "0123456789");
    assert.equal(page.structuredContent.nextOffset, 1024);
    assert.equal(
      "text" in page.details && page.details.text !== undefined,
      false,
      "page text must not be duplicated into details",
    );
  } finally {
    await app.shutdown();
  }
});

test("terminal_log_read is bounded by a per-run call budget", async () => {
  const app = harness();
  try {
    const result = await app.tools.get("bash").execute(
      "call-budget-source",
      {
        command: command('process.stdout.write("0123456789".repeat(20_000))'),
        yield_time_ms: 30_000,
      },
      undefined,
      undefined,
      app.ctx,
    );
    const ref = /archive ref (bt-[a-f0-9]{16}-\d+:stdout)/.exec(result.content[0].text)?.[1];
    assert.ok(ref, result.content[0].text);

    const read = (id: string) =>
      app.tools
        .get("terminal_log_read")
        .execute(id, { ref, offset: 0, limit: 1 }, undefined, undefined, app.ctx);

    // A byte budget alone cannot stop this: eight one-byte reads spend eight
    // bytes, so only a call budget bounds a polling loop.
    for (let call = 0; call < 8; call++) {
      const page = await read(`call-budget-${call}`);
      assert.match(page.content[0].text, /of \d+/);
      assert.equal(
        "text" in page.details && page.details.text !== undefined,
        false,
        "page text must not be duplicated into details",
      );
    }
    await assert.rejects(
      () => read("call-budget-over"),
      /budget exhausted for this agent run \(maximum 8 reads\)/,
    );

    // The budget is per agent run, not per session.
    for (const handler of app.handlers.get("agent_start") ?? []) {
      handler({}, app.ctx);
    }
    const afterReset = await read("call-budget-after-reset");
    assert.match(afterReset.content[0].text, /of \d+/);
  } finally {
    await app.shutdown();
  }
});

test("renderers distinguish quick bash from actually yielded terminals", async () => {
  const app = harness();
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as any;
  try {
    const tool = app.tools.get("bash");
    const call = tool.renderCall({ command: "printf visible-command" }, theme, {});
    assert.equal(call.render(120).join("\n").trimEnd(), "$ printf visible-command");

    // Ctrl+O expansion shows the full command text instead of the title
    // (render pads each line to width — compare trimmed lines).
    const expandedCall = tool.renderCall({ command: "printf first\nprintf second" }, theme, {
      expanded: true,
    });
    assert.deepEqual(
      expandedCall.render(120).map((line: string) => line.trimEnd()),
      ["$ printf first", "printf second"],
    );
    const collapsedCall = tool.renderCall({ command: "printf first\nprintf second" }, theme, {
      expanded: false,
    });
    assert.equal(collapsedCall.render(120).join("\n").trimEnd(), "$ printf first printf second");

    const quick = tool.renderResult(
      {
        content: [
          {
            type: "text",
            text: ["Command finished in 0s (exit 0).", "", "stdout:", "visible-output"].join("\n"),
          },
        ],
        // Structured details — not the text — decide the row shape.
        details: { id: "bt-1111111111111111-1", status: "done", yielded: false },
      },
      { isPartial: false, expanded: false },
      theme,
      { isError: false },
    );
    const renderedQuick = quick.render(120).join("\n").trimEnd();
    assert.match(renderedQuick, /bash done.*\/ps for details/);
    assert.match(renderedQuick, /stdout:\s*\nvisible-output/);
    assert.doesNotMatch(renderedQuick, /terminal bt-/);

    const yielded = tool.renderResult(
      {
        content: [
          {
            type: "text",
            text: [
              'Command is still running as background terminal bt-0123456789abcdef-9 "server".',
              'bt-0123456789abcdef-9 [running] "server" (pid 99)',
              "",
              "stdout:",
              "startup-output",
            ].join("\n"),
          },
        ],
        details: {
          id: "bt-0123456789abcdef-9",
          status: "running",
          yielded: true,
        },
      },
      { isPartial: false, expanded: true },
      theme,
      { isError: false },
    );
    const renderedYielded = yielded.render(120).join("\n").trimEnd();
    assert.match(renderedYielded, /terminal bt-0123456789abcdef-9 running.*\/ps to inspect/);
    assert.doesNotMatch(renderedYielded, /stdout|startup-output|server"/);

    // Text that merely *looks* like a status word cannot mislabel the row:
    // a cwd named "killed" is content, not state.
    const cwdCoincidence = tool.renderResult(
      {
        content: [
          {
            type: "text",
            text: "Command finished in 0s (exit 0) in /repo/killed-jobs.\n\nstdout:\nok",
          },
        ],
        details: { id: "bt-2222222222222222-2", status: "done", yielded: false },
      },
      { isPartial: false, expanded: false },
      theme,
      { isError: false },
    );
    assert.match(cwdCoincidence.render(120).join("\n").trimEnd(), /bash done.*\/ps for details/);
    // An Esc-aborted initial wait carries the *live* status, not a failure.
    const abortedWait = tool.renderResult(
      {
        content: [
          {
            type: "text",
            text: "Initial wait aborted; bt-3333333333333333-3 continues in the background and will report when it exits.",
          },
        ],
        details: { id: "bt-3333333333333333-3", status: "running", yielded: true },
      },
      { isPartial: false, expanded: false },
      theme,
      { isError: true },
    );
    assert.match(
      abortedWait.render(120).join("\n").trimEnd(),
      /terminal bt-3333333333333333-3 running/,
    );

    const completionRenderer = app.messageRenderers.get("background-terminal-result");
    const completion = completionRenderer(
      {
        content: "Background terminal bt-9 exited.\n\nstdout:\nlater-output",
        details: {
          id: "bt-9",
          title: "server",
          status: "done",
          exitCode: 0,
        },
      },
      { expanded: true },
      theme,
    );
    const renderedCompletion = completion.render(120).join("\n").trimEnd();
    assert.match(renderedCompletion, /terminal bt-9.*\/ps to inspect/);
    assert.doesNotMatch(renderedCompletion, /stdout|later-output|server/);

    const completionBatch = completionRenderer(
      {
        content: "3 background terminals completed.",
        details: {
          count: 3,
          ids: ["bt-1", "bt-2", "bt-3"],
          results: [
            { id: "bt-1", status: "done", exitCode: 0 },
            { id: "bt-2", status: "failed", exitCode: 1 },
            { id: "bt-3", status: "done", exitCode: 0 },
          ],
        },
      },
      { expanded: true },
      theme,
    );
    assert.match(
      completionBatch.render(120).join("\n").trimEnd(),
      /3 terminals.*1 failed.*\/ps to inspect/,
    );
  } finally {
    await app.shutdown();
  }
});

test("yield wait schema delegates bounds to manager clamping", async () => {
  const app = harness();
  try {
    const schema = app.tools.get("bash").parameters;
    assert.equal(Check(schema, { command: "true", yield_time_ms: 120_000 }), true);
    assert.equal(Check(schema, { command: "true", yield_time_ms: -1 }), true);
    assert.equal(Check(schema, { command: "true", yield_time_ms: 1.5 }), false);
  } finally {
    await app.shutdown();
  }
});

test("a command that only mutates the discarded shell is refused before spawning", async () => {
  const app = harness();
  try {
    await assert.rejects(
      app.tools
        .get("bash")
        .execute(
          "call-cd-only",
          { command: "cd /tmp", yield_time_ms: 30_000 },
          undefined,
          undefined,
          app.ctx,
        ),
      /was not executed.*working_dir/is,
    );
    // The same directory change with real work attached still runs.
    const result = await app.tools
      .get("bash")
      .execute(
        "call-cd-with-work",
        { command: "cd /tmp && pwd", yield_time_ms: 30_000 },
        undefined,
        undefined,
        app.ctx,
      );
    assert.match(result.content[0].text, /tmp/);
  } finally {
    await app.shutdown();
  }
});

test("re-running a still-running command is refused instead of duplicating it", async () => {
  const app = harness();
  try {
    const tool = app.tools.get("bash");
    const script = command("setTimeout(() => {}, 2000)");
    const first = await tool.execute(
      "call-duplicate-1",
      { command: script, yield_time_ms: 250 },
      undefined,
      undefined,
      app.ctx,
    );
    assert.match(first.content[0].text, /still running as background terminal/);

    await assert.rejects(
      tool.execute(
        "call-duplicate-2",
        { command: script, yield_time_ms: 250 },
        undefined,
        undefined,
        app.ctx,
      ),
      /already running as background terminal bt-[a-f0-9]{16}-\d+.*has not failed/is,
    );
  } finally {
    await app.shutdown();
  }
});

test("quick command returns final output without a duplicate follow-up", async () => {
  const app = harness();
  try {
    const tool = app.tools.get("bash");
    const result = await tool.execute(
      "call-quick",
      {
        command: command('process.stdout.write("quick\\n")'),
        yield_time_ms: 30_000,
      },
      undefined,
      undefined,
      app.ctx,
    );

    // Structured details carry the terminal identity even when the
    // model-facing text does not mention it (quick completions have no id).
    assert.match(result.details?.id ?? "", /^bt-[a-f0-9]{16}-\d+$/);
    assert.equal(result.details?.status, "done");
    assert.equal(result.details?.yielded, false);
    assert.match(result.content[0].text, /stdout:\nquick/);
    assert.equal(app.messages.length, 0);
  } finally {
    await app.shutdown();
  }
});

test("foreground wait streams bounded progress updates", async () => {
  const app = harness();
  const updates: any[] = [];
  try {
    const script =
      'process.stdout.write("early\\n"); setTimeout(() => process.stdout.write("late\\n"), 300)';
    const result = await app.tools
      .get("bash")
      .execute(
        "call-progress",
        { command: command(script), yield_time_ms: 30_000 },
        undefined,
        (update: any) => updates.push(update),
        app.ctx,
      );
    assert.match(result.content[0].text, /early/);
    assert.match(result.content[0].text, /late/);
    assert.ok(
      updates.some((update) => update.content?.[0]?.text?.includes("early")),
      "received a live output update",
    );
  } finally {
    await app.shutdown();
  }
});

test("bash exposes the current Pi session environment", async () => {
  const app = harness();
  try {
    const script =
      'process.stdout.write([process.env.PI_SESSION_ID, process.env.PI_PROVIDER, process.env.PI_MODEL, process.env.PI_REASONING_LEVEL].join("|"))';
    const result = await app.tools
      .get("bash")
      .execute(
        "call-env",
        { command: command(script), yield_time_ms: 30_000 },
        undefined,
        undefined,
        app.ctx,
      );
    assert.match(result.content[0].text, /test-session\|test-provider\|test-model\|high/);
  } finally {
    await app.shutdown();
  }
});

test("bash mirrors Pi's managed bin PATH handling", async () => {
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const previousPath = process.env[pathKey];
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-dir-"));
  const binDir = path.join(agentDir, "bin");
  const baseEntries = (previousPath ?? "")
    .split(path.delimiter)
    .filter((entry) => entry && entry !== binDir);
  const nodeDir = path.dirname(process.execPath);
  if (!baseEntries.includes(nodeDir)) baseEntries.unshift(nodeDir);
  const basePath = baseEntries.join(path.delimiter);

  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env[pathKey] = basePath;
  const app = harness();
  const inspectPath = async (toolCallId: string) => {
    const script = [
      'const path = require("node:path")',
      'const key = Object.keys(process.env).find((key) => key.toLowerCase() === "path") || "PATH"',
      `const binDir = ${JSON.stringify(binDir)}`,
      'const value = process.env[key] || ""',
      "const entries = value.split(path.delimiter).filter(Boolean)",
      "process.stdout.write(JSON.stringify({ value, count: entries.filter((entry) => entry === binDir).length }))",
    ].join(";");
    return app.tools
      .get("bash")
      .execute(
        toolCallId,
        { command: command(script), yield_time_ms: 30_000 },
        undefined,
        undefined,
        app.ctx,
      );
  };

  const assertManagedPath = (result: any, expectedPath: string) => {
    const text = result.content[0].text as string;
    if (process.platform !== "win32") {
      assert.ok(
        text.includes(`stdout:\n${JSON.stringify({ value: expectedPath, count: 1 })}`),
        text,
      );
      return;
    }

    // Git Bash prepends its own runtime directories and normalizes Windows
    // PATH entries. The managed contract is that Pi's bin directory survives
    // exactly once, not that Bash leaves the complete PATH byte-identical.
    const output = /stdout:\n({[^\n]+})/.exec(text);
    assert.ok(output, text);
    const parsed = JSON.parse(output[1]) as { value: string; count: number };
    assert.equal(parsed.count, 1, text);
    assert.equal(parsed.value.split(path.delimiter).includes(binDir), true, text);
  };

  try {
    const prependedPath = [binDir, basePath].filter(Boolean).join(path.delimiter);
    const prepended = await inspectPath("call-managed-path-prepend");
    assertManagedPath(prepended, prependedPath);

    const existingPath = [basePath, binDir].filter(Boolean).join(path.delimiter);
    process.env[pathKey] = existingPath;
    const preserved = await inspectPath("call-managed-path-preserve");
    assertManagedPath(preserved, existingPath);
  } finally {
    await app.shutdown();
    if (previousPath === undefined) delete process.env[pathKey];
    else process.env[pathKey] = previousPath;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

test("bash preserves Pi's configured command prefix", async () => {
  const extension = createBackgroundTerminalsExtension({
    resolveShellSettings: () => ({
      commandPrefix: "export PI_PREFIX_FROM_SETTINGS=preserved",
    }),
  });
  const app = harness(extension);
  try {
    const result = await app.tools.get("bash").execute(
      "call-prefix",
      {
        command: command('process.stdout.write(process.env.PI_PREFIX_FROM_SETTINGS || "missing")'),
        yield_time_ms: 30_000,
      },
      undefined,
      undefined,
      app.ctx,
    );
    assert.match(result.content[0].text, /stdout:\npreserved/);
  } finally {
    await app.shutdown();
  }
});

test("managed setup failure uses the foreground fallback before spawn", async () => {
  let fallbackCalls = 0;
  const extension = createBackgroundTerminalsExtension({
    createRuntime: (() => ({
      runPromise: async () => {
        throw new Error("manager unavailable");
      },
      dispose: async () => {},
    })) as any,
    resolveShellSettings: () => ({}),
    createForegroundBash: ((_cwd: string) => ({
      execute: async (_id: string, params: { command: string }) => {
        fallbackCalls++;
        return {
          content: [{ type: "text", text: `fallback: ${params.command}` }],
          details: undefined,
        };
      },
    })) as any,
  });
  const app = harness(extension);
  try {
    const result = await app.tools
      .get("bash")
      .execute("call-fallback", { command: "printf fallback" }, undefined, undefined, app.ctx);
    assert.equal(fallbackCalls, 1);
    assert.match(result.content[0].text, /Managed bash unavailable before spawn/);
    assert.match(result.content[1].text, /fallback: printf fallback/);
  } finally {
    await app.shutdown();
  }
});

test("a proven pre-spawn shell failure may use the foreground fallback", async () => {
  let fallbackCalls = 0;
  const extension = createBackgroundTerminalsExtension({
    resolveShellSettings: () => ({
      shellPath: path.join(os.tmpdir(), "definitely-missing-pi-shell"),
    }),
    createForegroundBash: ((_cwd: string) => ({
      execute: async () => {
        fallbackCalls++;
        return {
          content: [{ type: "text", text: "pre-spawn fallback ran" }],
          details: undefined,
        };
      },
    })) as any,
  });
  const app = harness(extension);
  try {
    const result = await app.tools
      .get("bash")
      .execute(
        "call-pre-spawn-fallback",
        { command: "printf fallback" },
        undefined,
        undefined,
        app.ctx,
      );
    assert.equal(fallbackCalls, 1);
    assert.match(result.content[0].text, /unavailable before spawn/);
    assert.match(result.content[1].text, /pre-spawn fallback ran/);
  } finally {
    await app.shutdown();
  }
});

test("a failed command is never retried through the fallback", async () => {
  const app = harness();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bash-once-"));
  const marker = path.join(dir, "marker");
  try {
    const script = `require("fs").appendFileSync(${JSON.stringify(marker)}, "once\\n"); process.exit(7)`;
    const result = await app.tools
      .get("bash")
      .execute(
        "call-failed",
        { command: command(script), yield_time_ms: 30_000 },
        undefined,
        undefined,
        app.ctx,
      );
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /exit 7/);
    assert.equal(result.details?.status, "failed");
    assert.equal(fs.readFileSync(marker, "utf8"), "once\n");
  } finally {
    await app.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a hard timeout is reported as an unsuccessful bash call", async () => {
  const app = harness();
  try {
    const result = await app.tools.get("bash").execute(
      "call-timeout",
      {
        command: command("setInterval(() => {}, 1000)"),
        timeout: 0.1,
      },
      undefined,
      undefined,
      app.ctx,
    );
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /timed out/i);
    assert.equal(result.details?.status, "timed_out");
  } finally {
    await app.shutdown();
  }
});

test("a yielded hard timeout sends exactly one timed-out completion", async () => {
  const app = harness();
  try {
    const result = await app.tools.get("bash").execute(
      "call-yielded-timeout",
      {
        command: command("setInterval(() => {}, 1000)"),
        timeout: 0.5,
        yield_time_ms: 250,
      },
      undefined,
      undefined,
      app.ctx,
    );
    assert.match(result.content[0].text, /background terminal bt-[a-f0-9]{16}-\d+/);
    assert.equal(
      await pollUntil(() => app.messages.length === 1),
      true,
      "timed-out follow-up arrived",
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(app.messages.length, 1);
    assert.match(app.messages[0].message.content, /timed out after/i);
  } finally {
    await app.shutdown();
  }
});

test("failed result delivery does not write directly to the TUI terminal", async () => {
  const app = harness();
  app.ctx.mode = "tui";
  let deliveryAttempts = 0;
  (app.pi as any).sendMessage = () => {
    deliveryAttempts++;
    throw new Error("delivery unavailable");
  };
  const originalConsoleError = console.error;
  const consoleErrors: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    consoleErrors.push(args);
  };

  try {
    const result = await app.tools.get("bash").execute(
      "call-delivery-failure",
      {
        command: command('setTimeout(() => console.log("later"), 500)'),
        yield_time_ms: 250,
      },
      undefined,
      undefined,
      app.ctx,
    );
    assert.match(result.content[0].text, /background terminal bt-[a-f0-9]{16}-\d+/);
    assert.equal(await pollUntil(() => deliveryAttempts === 1), true, "delivery was attempted");
    assert.deepEqual(consoleErrors, []);
  } finally {
    console.error = originalConsoleError;
    await app.shutdown();
  }
});

test("yielded command returns an id then sends exactly one completion", async () => {
  const app = harness();
  try {
    const tool = app.tools.get("bash");
    const result = await tool.execute(
      "call-yielded",
      {
        command: command('setTimeout(() => console.log("later"), 500)'),
        title: "later command",
        yield_time_ms: 250,
      },
      undefined,
      undefined,
      app.ctx,
    );

    assert.match(result.content[0].text, /background terminal bt-[a-f0-9]{16}-\d+/);
    assert.match(result.content[0].text, /do not poll/);
    assert.equal(
      result.details?.id,
      /background terminal (bt-[a-f0-9]{16}-\d+)/.exec(result.content[0].text)?.[1],
    );
    assert.equal(result.details?.status, "running");
    assert.equal(result.details?.yielded, true);

    assert.equal(
      await pollUntil(() => app.messages.length === 1),
      true,
      "completion follow-up arrived",
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(app.messages.length, 1);
    assert.equal(app.messages[0].message.customType, "background-terminal-result");
    assert.match(app.messages[0].message.content, /exited \(exit 0\)/);
    assert.deepEqual(app.messages[0].options, {
      deliverAs: "steer",
      triggerTurn: true,
    });
  } finally {
    await app.shutdown();
  }
});

test("near-simultaneous yielded completions share one follow-up", async () => {
  const app = harness();
  try {
    const tool = app.tools.get("bash");
    const finishAt = Date.now() + 2_500;
    const results = await Promise.all(
      Array.from({ length: 3 }, (_, index) =>
        tool.execute(
          `call-batch-${index + 1}`,
          {
            command: command(
              `setTimeout(() => console.log("batch-${index + 1}"), Math.max(0, ${finishAt} - Date.now()))`,
            ),
            title: `batch command ${index + 1}`,
            yield_time_ms: 250,
          },
          undefined,
          undefined,
          app.ctx,
        ),
      ),
    );
    const ids = results.map((result) => {
      const id = /background terminal (bt-[a-f0-9]{16}-\d+)/.exec(result.content[0].text)?.[1];
      assert.ok(id, result.content[0].text);
      return id;
    });

    assert.equal(
      await pollUntil(
        () =>
          app.messages.length === 1 &&
          ids.every((id) => app.messages[0].message.content.includes(id)),
      ),
      true,
      "one follow-up contains every nearby completion",
    );
    assert.equal(app.messages.length, 1);
    assert.equal(app.messages[0].message.details.count, 3);
    assert.deepEqual([...app.messages[0].message.details.ids].sort(), [...ids].sort());
    assert.deepEqual(app.messages[0].options, {
      deliverAs: "steer",
      triggerTurn: true,
    });
  } finally {
    await app.shutdown();
  }
});

test("the widget counts only yielded terminals, not commands inside their initial wait", async () => {
  const app = harness();
  const widgets: unknown[] = [];
  app.ctx.hasUI = true;
  app.ctx.ui = {
    setWidget: (_key: string, factory: unknown) => widgets.push(factory),
    notify: () => {},
  };
  // Re-fire session_start so the extension picks up the injected ui.
  for (const handler of app.handlers.get("session_start") ?? []) {
    handler({}, app.ctx);
  }
  try {
    // A quick command's initial wait must never raise the widget.
    await app.tools
      .get("bash")
      .execute(
        "call-quick-widget",
        { command: command('process.stdout.write("quick\\n")'), yield_time_ms: 30_000 },
        undefined,
        undefined,
        app.ctx,
      );
    assert.equal(widgets.length, 0, "widget flashed for a command still inside its initial wait");

    // A command that outlives its wait raises the widget...
    await app.tools
      .get("bash")
      .execute(
        "call-long-widget",
        { command: command("setTimeout(() => {}, 600)"), yield_time_ms: 250 },
        undefined,
        undefined,
        app.ctx,
      );
    assert.ok(
      await pollUntil(() => widgets.some((factory) => typeof factory === "function")),
      "widget appeared once the command yielded",
    );
    // ...and clears when the terminal settles.
    assert.ok(await pollUntil(() => widgets.at(-1) === undefined), "widget cleared on settle");
  } finally {
    await app.shutdown();
  }
});

test("Esc during the initial wait returns a running-terminal error result, not a failure", async () => {
  const app = harness();
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as any;
  try {
    const tool = app.tools.get("bash");
    const controller = new AbortController();
    // Abort on the first live update — provably inside the initial wait,
    // after the process spawned (an earlier abort would hit the
    // pre-spawn throwIfAborted check instead).
    const executing = tool.execute(
      "call-esc",
      {
        command: command(
          'process.stdout.write("up\\n"); setTimeout(() => console.log("still ran"), 400)',
        ),
        yield_time_ms: 30_000,
      },
      controller.signal,
      () => controller.abort(),
      app.ctx,
    );

    const result = await executing;
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /continues in the background/);
    assert.equal(result.details?.status, "running");
    assert.equal(result.details?.yielded, true);
    const id = result.details?.id as string;
    assert.match(id, /^bt-/);

    // The row renders as a live terminal — not the misleading "bash failed"
    // the old text-parsing renderer produced for this exact case.
    const rendered = tool.renderResult(result, { isPartial: false, expanded: false }, theme, {
      isError: true,
    });
    assert.match(rendered.render(120).join("\n"), new RegExp(`terminal ${id} running`));

    // The process really kept running: its completion arrives as a follow-up.
    assert.equal(await pollUntil(() => app.messages.length === 1), true);
    assert.match(app.messages[0].message.content, /exited \(exit 0\)/);
    assert.match(app.messages[0].message.content, /still ran/);
  } finally {
    await app.shutdown();
  }
});

test("an Esc that lands as the command settles returns the final result exactly once", async () => {
  const { createTerminalRuntime } = await import("../src/runtime.ts");
  const { Exit } = await import("effect");
  const runtime = createTerminalRuntime();
  const controller = new AbortController();
  let calls = 0;
  // The second runPromiseExit is the initial wait. Let it observe the real
  // settlement (its waiter consumes it), then report the Esc as having won:
  // the exact interleaving where no follow-up would ever be delivered.
  const racingRuntime = new Proxy(runtime, {
    get(target, property, receiver) {
      if (property !== "runPromiseExit") return Reflect.get(target, property, receiver);
      return async (...args: Parameters<typeof runtime.runPromiseExit>) => {
        const exit = await runtime.runPromiseExit(...args);
        if (++calls !== 2) return exit;
        controller.abort();
        return Exit.interrupt();
      };
    },
  });
  const app = harness(
    createBackgroundTerminalsExtension({
      resolveShellSettings: () => ({}),
      createRuntime: () => racingRuntime,
    }),
  );
  try {
    const result = await app.tools
      .get("bash")
      .execute(
        "call-esc-race",
        { command: command('console.log("finished")'), yield_time_ms: 30_000 },
        controller.signal,
        undefined,
        app.ctx,
      );
    assert.equal(calls, 2);
    assert.equal(result.isError, undefined);
    assert.equal(result.details?.status, "done");
    assert.doesNotMatch(result.content[0].text, /continues in the background/);
    assert.match(result.content[0].text, /finished/);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    assert.equal(app.messages.length, 0, "the returned result is not also a follow-up");
  } finally {
    await app.shutdown();
  }
});

test("a result still in its quiet window is delivered before the run settles", async () => {
  const app = harness();
  const listing: string[] = [];
  const psCtx = { ...app.ctx, hasUI: true, ui: { notify: (text: string) => listing.push(text) } };
  const status = async () => {
    listing.length = 0;
    await app.commands.get("ps").handler("", psCtx);
    return listing.join("\n");
  };
  const beforeSettle = async (outcome: string) => {
    for (const handler of app.handlers.get("agent_before_settle") ?? []) {
      await handler({ type: "agent_before_settle", outcome }, app.ctx);
    }
  };
  try {
    const result = await app.tools
      .get("bash")
      .execute(
        "call-before-settle",
        { command: command('setTimeout(() => console.log("late"), 300)'), yield_time_ms: 250 },
        undefined,
        undefined,
        app.ctx,
      );
    const id = result.details?.id as string;
    assert.equal(result.details?.yielded, true);
    // Settled, but still inside the 1s quiet window: nothing sent yet.
    const deadline = Date.now() + 10_000;
    while (!(await status()).includes(`${id} [done]`)) {
      assert.ok(Date.now() < deadline, "terminal settled");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(app.messages.length, 0, "quiet window still open");

    // An aborted run must not be continued with the result.
    await beforeSettle("aborted");
    assert.equal(app.messages.length, 0);

    // A run about to complete gets it now, steered into the same run.
    await beforeSettle("completed");
    assert.equal(app.messages.length, 1);
    assert.match(app.messages[0].message.content, /late/);
    assert.deepEqual(app.messages[0].options, { deliverAs: "steer", triggerTurn: true });

    // The quiet-window timer was cancelled: no duplicate later.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    assert.equal(app.messages.length, 1);
  } finally {
    await app.shutdown();
  }
});
