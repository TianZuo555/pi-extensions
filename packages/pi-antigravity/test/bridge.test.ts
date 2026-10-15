import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AgyPiBridge,
  BRIDGE_SERVER_NAME,
  BRIDGE_TOOL_PREFIX,
  resolveBridgeResultsFromContext,
  selectBridgedTools,
} from "../lib/bridge.ts";
import { createBridgeLifecycleManager } from "../lib/bridge-lifecycle.ts";
import type { SkillLite } from "../lib/skills.ts";

const TOOL_DEFS = [
  {
    name: "commit",
    description: "Generate a commit message.",
    parameters: { type: "object", properties: {} },
  },
];

async function startedBridge(
  onCall: (call: { id: string; tool: string; args: Record<string, unknown> }) => boolean,
) {
  const bridge = new AgyPiBridge();
  bridge.setOnCall(onCall);
  bridge.setToolSource(() => TOOL_DEFS);
  await bridge.start();
  return bridge;
}

function post(
  bridge: AgyPiBridge,
  body: unknown,
): Promise<{ status: number; json: Record<string, any> }> {
  return fetch(bridge.url!, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, json: (await res.json()) as Record<string, any> }));
}

test("bridge catalog revision is stable across ordering and changes with canonical content", () => {
  const bridge = new AgyPiBridge();
  let tools = [
    { name: "z", description: "z", parameters: { type: "object", properties: { b: {}, a: {} } } },
    { name: "a", description: "a", parameters: { required: ["x", "y"], type: "object" } },
  ];
  bridge.setToolSource(() => tools);
  assert.equal(bridge.refreshTools(), true);
  const first = bridge.catalogRevision;

  tools = [
    { name: "a", description: "a", parameters: { type: "object", required: ["x", "y"] } },
    { name: "z", description: "z", parameters: { properties: { a: {}, b: {} }, type: "object" } },
  ];
  assert.equal(bridge.refreshTools(), false);
  assert.equal(bridge.catalogRevision, first);

  tools[0] = { ...tools[0], description: "changed" };
  assert.equal(bridge.refreshTools(), true);
  assert.equal(bridge.catalogRevision, first + 1);

  bridge.setDynamicTools([
    {
      name: "activate_skill",
      description: "skills",
      parameters: { type: "object", properties: { name: { enum: ["one"] } } },
      handler: async () => ({ content: "ok", isError: false }),
    },
  ]);
  assert.equal(bridge.catalogRevision, first + 2);
});

test("bridge responds to initialize and lists prefixed tools", async () => {
  const bridge = await startedBridge(() => false);
  try {
    const init = await post(bridge, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05" },
    });
    assert.equal(init.json.result.serverInfo.name, BRIDGE_SERVER_NAME);

    bridge.refreshTools();
    const list = await post(bridge, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    assert.deepEqual(list.json.result.tools, [
      {
        name: `${BRIDGE_TOOL_PREFIX}commit`,
        description: "Generate a commit message.",
        inputSchema: { type: "object", properties: {} },
      },
    ]);
  } finally {
    await bridge.close();
  }
});

test("bridge routes tools/call through onCall and resolves with the pi result", async () => {
  let seen: { id: string; tool: string; args: Record<string, unknown> } | undefined;
  const bridge = await startedBridge((call) => {
    seen = call;
    // Simulate pi executing the tool on the next provider request.
    setTimeout(() => bridge.resolveCall(call.id, { content: "committed!", isError: false }), 5);
    return true;
  });
  try {
    bridge.refreshTools();
    const res = await post(bridge, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: `${BRIDGE_TOOL_PREFIX}commit`, arguments: { message: "hi" } },
    });
    assert.ok(seen);
    assert.equal(seen.tool, "commit");
    assert.deepEqual(seen.args, { message: "hi" });
    assert.equal(res.json.result.isError, false);
    assert.equal(res.json.result.content[0].text, "committed!");
  } finally {
    await bridge.close();
  }
});

for (const content of [
  [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
  [
    { type: "text", text: "Screenshot follows" },
    { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
    { type: "text", text: "End" },
  ],
]) {
  test(`bridge preserves tool result blocks: ${content.map((block) => block.type)}`, async () => {
    const bridge = await startedBridge((call) => {
      queueMicrotask(() =>
        resolveBridgeResultsFromContext(bridge, [
          {
            role: "toolResult",
            toolCallId: call.id,
            content,
            isError: true,
          },
        ]),
      );
      return true;
    });
    try {
      bridge.refreshTools();
      const response = await post(bridge, {
        jsonrpc: "2.0",
        id: 30,
        method: "tools/call",
        params: { name: `${BRIDGE_TOOL_PREFIX}commit`, arguments: {} },
      });
      assert.deepEqual(response.json.result.content, content);
      assert.equal(response.json.result.isError, true);
    } finally {
      await bridge.close();
    }
  });
}

test("bridge fails closed when no agy turn is active", async () => {
  const bridge = await startedBridge(() => false);
  try {
    bridge.refreshTools();
    const res = await post(bridge, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: `${BRIDGE_TOOL_PREFIX}commit`, arguments: {} },
    });
    assert.equal(res.json.result.isError, true);
    assert.match(res.json.result.content[0].text, /no active agy turn/);
  } finally {
    await bridge.close();
  }
});

test("bridge rejects unknown and non-prefixed tools", async () => {
  const bridge = await startedBridge(() => true);
  try {
    bridge.refreshTools();
    for (const name of ["nope", "read"]) {
      const res = await post(bridge, {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name, arguments: {} },
      });
      assert.equal(res.json.result.isError, true, name);
    }
  } finally {
    await bridge.close();
  }
});

test("bridge times out pending calls with an isError result", async () => {
  const bridge = new AgyPiBridge();
  bridge.setOnCall(() => true);
  bridge.setToolSource(() => TOOL_DEFS);
  await bridge.start();
  try {
    bridge.refreshTools();
    // Attach handlers up front: if the POST itself fails (observed once on a
    // loaded CI runner), the rejection must surface here as a test failure
    // with its real cause — never as an unhandled rejection after teardown.
    let posted: { status: number; json: Record<string, any> } | undefined;
    let postError: unknown;
    const settled = post(bridge, {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: `${BRIDGE_TOOL_PREFIX}commit`, arguments: {} },
    }).then(
      (value) => {
        posted = value;
      },
      (error) => {
        postError = error;
      },
    );
    // Wait until the call is routed and pending — a fixed sleep races on
    // slow CI runners (observed: fetch not delivered within 10ms). Stop
    // early if the POST already failed.
    const deadline = Date.now() + 5_000;
    while (bridge.pendingCount < 1 && !postError && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    if (postError) {
      await settled;
      throw postError;
    }
    assert.equal(bridge.pendingCount, 1);
    await bridge.close(); // session shutdown while pending
    // close() resolves the in-flight POST via the fail-closed path (or
    // rejects it if the socket died first) — either way it is settled now.
    await settled;
    if (postError) throw postError;
    assert.equal(posted!.json.result.isError, true);
    assert.match(posted!.json.result.content[0].text, /shut down/);
  } finally {
    await bridge.close();
  }
});

test("dynamic skill tools are listed and handled in-process", async () => {
  const bridge = new AgyPiBridge();
  bridge.setOnCall(() => {
    throw new Error("skill tools must not be routed into the agy turn");
  });
  bridge.setToolSource(() => TOOL_DEFS);
  bridge.setDynamicTools([
    {
      name: "activate_skill",
      description: "Activate a skill.",
      parameters: { type: "object", properties: {} },
      handler: async (args) => ({ content: `activated:${String(args.name)}`, isError: false }),
    },
  ]);
  await bridge.start();
  try {
    bridge.refreshTools();
    const list = await post(bridge, { jsonrpc: "2.0", id: 8, method: "tools/list" });
    const names = (list.json.result.tools as Array<{ name: string }>).map((tool) => tool.name);
    assert.ok(names.includes(`${BRIDGE_TOOL_PREFIX}activate_skill`));
    // Real pi tools (from the tool source) are still listed alongside.
    assert.ok(names.includes(`${BRIDGE_TOOL_PREFIX}commit`));

    const res = await post(bridge, {
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: `${BRIDGE_TOOL_PREFIX}activate_skill`, arguments: { name: "grilling" } },
    });
    assert.equal(res.json.result.isError, false);
    assert.equal(res.json.result.content[0].text, "activated:grilling");
  } finally {
    await bridge.close();
  }
});

test("dynamic tools replace wholesale and route in-process", async () => {
  const bridge = new AgyPiBridge();
  bridge.setOnCall(() => {
    throw new Error("skill tools must not be routed into the agy turn");
  });
  bridge.setToolSource(() => TOOL_DEFS);
  await bridge.start();
  try {
    bridge.setDynamicTools([
      {
        name: "grilling",
        description: "Interview the user relentlessly.",
        parameters: { type: "object", properties: {} },
        handler: async () => ({ content: "SKILL.md body", isError: false }),
      },
    ]);
    let list = await post(bridge, { jsonrpc: "2.0", id: 10, method: "tools/list" });
    let names = (list.json.result.tools as Array<{ name: string }>).map((tool) => tool.name);
    assert.ok(names.includes(`${BRIDGE_TOOL_PREFIX}grilling`));

    // Wholesale replacement: removed skills disappear.
    bridge.setDynamicTools([]);
    list = await post(bridge, { jsonrpc: "2.0", id: 11, method: "tools/list" });
    names = (list.json.result.tools as Array<{ name: string }>).map((tool) => tool.name);
    assert.ok(!names.includes(`${BRIDGE_TOOL_PREFIX}grilling`));

    // Routing still works while present.
    bridge.setDynamicTools([
      {
        name: "grilling",
        description: "d",
        parameters: { type: "object", properties: {} },
        handler: async () => ({ content: "body", isError: false }),
      },
    ]);
    const res = await post(bridge, {
      jsonrpc: "2.0",
      id: 12,
      method: "tools/call",
      params: { name: `${BRIDGE_TOOL_PREFIX}grilling`, arguments: {} },
    });
    assert.equal(res.json.result.content[0].text, "body");
  } finally {
    await bridge.close();
  }
});

test("dynamic tools replace same-named real tools without duplicate listings", async () => {
  const bridge = new AgyPiBridge();
  bridge.setOnCall(() => {
    throw new Error("shadowed real tool must not be routed");
  });
  bridge.setToolSource(() => TOOL_DEFS);
  bridge.setDynamicTools([
    {
      name: "commit",
      description: "Dynamic replacement.",
      parameters: { type: "object", properties: {} },
      handler: async () => ({ content: "dynamic", isError: false }),
    },
  ]);
  await bridge.start();
  try {
    bridge.refreshTools();
    const list = await post(bridge, { jsonrpc: "2.0", id: 13, method: "tools/list" });
    const names = (list.json.result.tools as Array<{ name: string }>).map((tool) => tool.name);
    assert.equal(names.filter((name) => name === `${BRIDGE_TOOL_PREFIX}commit`).length, 1);
    const res = await post(bridge, {
      jsonrpc: "2.0",
      id: 14,
      method: "tools/call",
      params: { name: `${BRIDGE_TOOL_PREFIX}commit`, arguments: {} },
    });
    assert.equal(res.json.result.content[0].text, "dynamic");
  } finally {
    await bridge.close();
  }
});

test("resolveBridgeResultsFromContext resolves matching toolResult messages", async () => {
  const bridge = await startedBridge((call) => {
    setTimeout(() => {
      resolveBridgeResultsFromContext(bridge, [
        { role: "user", content: [{ type: "text", text: "go" }] },
        {
          role: "toolResult",
          toolCallId: call.id,
          toolName: "commit",
          isError: false,
          content: [{ type: "text", text: "done" }],
        },
      ]);
    }, 5);
    return true;
  });
  try {
    bridge.refreshTools();
    const res = await post(bridge, {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: `${BRIDGE_TOOL_PREFIX}commit`, arguments: {} },
    });
    assert.equal(res.json.result.isError, false);
    assert.equal(res.json.result.content[0].text, "done");
  } finally {
    await bridge.close();
  }
});

test("concurrent bridges expose stable names and enforce independent credentials", async () => {
  const a = new AgyPiBridge("pi-session-a");
  const b = new AgyPiBridge("pi-session-b");
  a.requireToken("token-a");
  b.requireToken("token-b");
  a.setDynamicTools([
    {
      name: "commit",
      description: "a",
      parameters: { type: "object" },
      handler: async () => ({ content: "from-a", isError: false }),
    },
  ]);
  b.setDynamicTools([
    {
      name: "commit",
      description: "b",
      parameters: { type: "object" },
      handler: async () => ({ content: "from-b", isError: false }),
    },
  ]);
  await a.start();
  await b.start();
  const request = (bridge: AgyPiBridge, token: string, method: string) =>
    fetch(bridge.url!, {
      method: "POST",
      headers: { "content-type": "application/json", "x-pi-bridge-token": token },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params: { name: "pi__commit", arguments: {} },
      }),
    });
  try {
    for (const [bridge, token, expected] of [
      [a, "token-a", "from-a"],
      [b, "token-b", "from-b"],
    ] as const) {
      const list = (await (await request(bridge, token, "tools/list")).json()) as any;
      assert.deepEqual(
        list.result.tools.map((tool: { name: string }) => tool.name),
        ["pi__commit"],
      );
      const call = (await (await request(bridge, token, "tools/call")).json()) as any;
      assert.equal(call.result.content[0].text, expected);
    }
    assert.equal((await request(b, "token-a", "tools/call")).status, 403);
    assert.equal((await request(a, "token-b", "tools/call")).status, 403);
  } finally {
    await a.close();
    await b.close();
  }
});

test("bridge enforces the shared token when configured", async () => {
  const bridge = new AgyPiBridge("pi-bridge-test");
  bridge.requireToken("secret-token");
  bridge.setOnCall(() => true);
  bridge.setToolSource(() => TOOL_DEFS);
  await bridge.start();
  try {
    const denied = await fetch(bridge.url!, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(denied.status, 403);

    const ok = await fetch(bridge.url!, {
      method: "POST",
      headers: { "content-type": "application/json", "x-pi-bridge-token": "secret-token" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    assert.equal(ok.status, 200);
  } finally {
    await bridge.close();
  }
});

test("selectBridgedTools bridges only built-in MCP tools", () => {
  const tools = [
    { name: "read", sourceInfo: { source: "builtin", path: "builtin:read" } },
    { name: "codemode", sourceInfo: { source: "builtin", path: "builtin:codemode" } },
    { name: "ask_user", sourceInfo: { source: "npm:@tian.zuo/pi-ask-user" } },
    { name: "mcp__github__search_issues", sourceInfo: { source: "builtin", path: "builtin:mcp" } },
    { name: "read_mcp_resource", sourceInfo: { source: "builtin", path: "builtin:mcp" } },
    // Registered by the built-in MCP extension but codemode-exposed, hence not
    // active: the bridge executes tools as model tool calls, which pi resolves
    // against the active tool set, so non-direct tools cannot be bridged.
    { name: "mcp__docs__deferred_tool", sourceInfo: { source: "builtin", path: "builtin:mcp" } },
    { name: "mcp", sourceInfo: { source: "npm:pi-mcp-adapter" } },
    { name: "orphan", sourceInfo: {} },
    // Hypothetical collision: even a builtin:mcp-registered tool with the
    // replay wrapper's name stays out (defense-in-depth guard).
    { name: "antigravity", sourceInfo: { source: "builtin", path: "builtin:mcp" } },
  ].map((tool) => ({
    ...tool,
    description: `${tool.name} description`,
    parameters: { type: "object", properties: {} },
  }));
  const active = [
    "read",
    "codemode",
    "ask_user",
    "mcp__github__search_issues",
    "read_mcp_resource",
    "mcp",
    "antigravity",
  ];
  const bridged = selectBridgedTools(tools, active).map((tool) => tool.name);
  // Built-in MCP tools that are active — no other builtins, no pi-session
  // extension tools, no replay wrapper, no inactive tools, no adapter tools.
  assert.deepEqual(bridged, ["mcp__github__search_issues", "read_mcp_resource"]);
});

test("Pi tool mode bridges active builtins, extensions and MCP while excluding hidden tools and replay", () => {
  const tools = [
    { name: "read", sourceInfo: { path: "builtin:read" } },
    { name: "bash", sourceInfo: { path: "builtin:bash" } },
    {
      name: "ask_user",
      sourceInfo: { source: "npm:@tian.zuo/pi-ask-user" },
      exposure: "model-only",
    },
    { name: "codemode", sourceInfo: { path: "builtin:codemode" } },
    { name: "mcp__docs__search", sourceInfo: { path: "builtin:mcp" } },
    { name: "inactive" },
    { name: "hidden", exposure: "hidden" },
    { name: "antigravity" },
  ];
  const active = tools.filter((tool) => tool.name !== "inactive").map((tool) => tool.name);
  assert.deepEqual(
    selectBridgedTools(tools, active, "pi").map((tool) => tool.name),
    ["read", "bash", "ask_user", "codemode", "mcp__docs__search"],
  );
  assert.deepEqual(
    selectBridgedTools(tools, active, "native").map((tool) => tool.name),
    ["mcp__docs__search"],
  );
});

test("adapter migration warning detects package and local sources without matching tool names", () => {
  const cases = [
    { source: "npm:pi-mcp-adapter", expected: true },
    { source: "npm:pi-mcp-adapter@2", expected: true },
    { source: "git:github.com/nicobailon/pi-mcp-adapter", expected: true },
    { source: "local", path: "/extensions/pi-mcp-adapter/index.ts", expected: true },
    { source: "local", path: "C:\\extensions\\pi-mcp-adapter\\index.ts", expected: true },
    { source: "local", path: "/extensions/pi-mcp-adapter.ts", expected: true },
    { source: "builtin", path: "builtin:mcp", expected: false },
    { source: "npm:pi-mcp-adapter-helper", expected: false },
    { source: "npm:other-pi-mcp-adapter", expected: false },
    { expected: false },
  ];
  for (const { expected, ...sourceInfo } of cases) {
    const warnings: string[] = [];
    const manager = createBridgeLifecycleManager({
      bridge: new AgyPiBridge(),
      bridgeToken: "test-token",
      writeMcpConfig: async () => {},
      removeMcpConfig: async () => {},
      evictMcpCache: async () => {},
      notifyWarning: (message) => warnings.push(message),
    });
    // An empty snapshot does not consume the one-time warning.
    manager.warnMcpAdapterUnsupported([]);
    const resources = [{ name: "mcp", sourceInfo }];
    manager.warnMcpAdapterUnsupported(resources);
    manager.warnMcpAdapterUnsupported(resources);
    assert.equal(warnings.length, expected ? 1 : 0, JSON.stringify(sourceInfo));
    if (expected) {
      assert.match(warnings[0], /not bridged to agy/);
      assert.match(warnings[0], /Remove or disable pi-mcp-adapter/);
      assert.match(warnings[0], /mcp\.json/);
      assert.match(warnings[0], /"exposure": "direct"/);
      assert.match(warnings[0], /\/reload/);
    }
  }
});

test("adapter migration warning waits for a notification sink", () => {
  const manager = createBridgeLifecycleManager({
    bridge: new AgyPiBridge(),
    bridgeToken: "test-token",
    writeMcpConfig: async () => {},
    removeMcpConfig: async () => {},
    evictMcpCache: async () => {},
  });
  const resources = [{ sourceInfo: { source: "npm:pi-mcp-adapter" } }];
  manager.warnMcpAdapterUnsupported(resources);
  const warnings: string[] = [];
  manager.warnMcpAdapterUnsupported(resources, (message) => warnings.push(message));
  manager.warnMcpAdapterUnsupported(resources, (message) => warnings.push(message));
  assert.equal(warnings.length, 1);
});

test("createBridgeLifecycleManager handles partial-write failure, retry, teardown, and fallback", async () => {
  const bridge = new AgyPiBridge("pi-bridge-lifecycle");
  let mcpWriteShouldFail = true;
  let addCalls = 0;
  let removeCalls = 0;
  let evictCalls = 0;

  const warnings: string[] = [];

  const skills: SkillLite[] = [
    {
      name: "herdr",
      description: "Herdr subagents",
      filePath: "/skills/herdr/SKILL.md",
      baseDir: "/skills/herdr",
    },
  ];

  const manager = createBridgeLifecycleManager({
    bridge,
    bridgeToken: "test-token",
    enabled: true,
    writeMcpConfig: async (_name, _url, _token) => {
      addCalls++;
      if (mcpWriteShouldFail) {
        throw new Error("private MCP config write failed");
      }
    },
    removeMcpConfig: async (_name) => {
      removeCalls++;
    },
    evictMcpCache: async (_name) => {
      evictCalls++;
    },
    notifyWarning: (msg) => warnings.push(msg),
  });

  try {
    // 1. Initial attempt: bridge starts listening, but writeMcpConfig fails
    const firstResult = await manager.ensureRegistered();
    assert.equal(firstResult, false, "ensureRegistered reports failure");
    assert.equal(manager.isRunning(), false, "failed preparation closes the listener");
    assert.equal(manager.isRegistered(), false, "not marked as registered");
    assert.equal(addCalls, 1);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /pi-tool bridge unavailable/);

    // Registration failed: no prompt catalog is ever injected — the user is
    // warned once that pi-private skills are unavailable.
    manager.warnSkillsUnavailable(skills);
    manager.warnSkillsUnavailable(skills);
    assert.equal(warnings.length, 2);
    assert.match(warnings[1], /pi-private skills are unavailable/);

    // 2. Retry attempt: writeMcpConfig succeeds
    mcpWriteShouldFail = false;
    const secondResult = await manager.ensureRegistered();
    assert.equal(secondResult, true, "ensureRegistered reports success on retry");
    assert.equal(manager.isRunning(), true);
    assert.equal(manager.isRegistered(), true, "marked as registered");
    assert.equal(addCalls, 2);

    // When registered there is nothing to warn about.
    manager.warnSkillsUnavailable(skills);
    assert.equal(warnings.length, 2);

    // Idempotent: calling ensureRegistered again when already registered is a no-op
    const thirdResult = await manager.ensureRegistered();
    assert.equal(thirdResult, true);
    assert.equal(addCalls, 2, "did not call writeMcpConfig again");

    // 3. Teardown
    await manager.teardown();
    assert.equal(manager.isRunning(), false, "bridge closed");
    assert.equal(manager.isRegistered(), false, "marked as unregistered");
    assert.equal(removeCalls, 2, "failed preparation and teardown remove their config");
    assert.equal(evictCalls, 2, "failed preparation and teardown evict their owned cache");
  } finally {
    await manager.teardown();
  }
});

test("createBridgeLifecycleManager respects disabled setting", async () => {
  const bridge = new AgyPiBridge("pi-bridge-disabled");
  let addCalled = false;
  const warnings: string[] = [];
  const manager = createBridgeLifecycleManager({
    bridge,
    bridgeToken: "test-token",
    enabled: false,
    writeMcpConfig: async () => {
      addCalled = true;
    },
    removeMcpConfig: async () => {},
    evictMcpCache: async () => {},
    notifyWarning: (msg) => warnings.push(msg),
  });

  const skills: SkillLite[] = [
    {
      name: "herdr",
      description: "Herdr subagents",
      filePath: "/skills/herdr/SKILL.md",
      baseDir: "/skills/herdr",
    },
  ];

  const result = await manager.ensureRegistered();
  assert.equal(result, false);
  assert.equal(addCalled, false, "did not attempt MCP registration");
  assert.equal(manager.isRunning(), false);
  assert.equal(manager.isRegistered(), false);
  manager.warnMcpAdapterUnsupported([{ sourceInfo: { source: "npm:pi-mcp-adapter" } }]);
  assert.equal(warnings.length, 0, "disabled bridges do not suggest migrating MCP servers");
  // Bridge disabled: the user hears about unreachable pi-private skills once.
  manager.warnSkillsUnavailable(skills);
  manager.warnSkillsUnavailable(skills);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /disabled.*pi-private skills/);
  // An empty catalog never warns at all.
  const fresh = createBridgeLifecycleManager({
    bridge,
    bridgeToken: "t",
    enabled: false,
    writeMcpConfig: async () => {},
    removeMcpConfig: async () => {},
    evictMcpCache: async () => {},
    notifyWarning: (msg) => warnings.push(msg),
  });
  fresh.warnSkillsUnavailable([]);
  assert.equal(warnings.length, 1);
});
