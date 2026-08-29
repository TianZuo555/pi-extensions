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

test("per-session tool prefixes isolate concurrent bridges", async () => {
  // Two live bridges, as with two concurrent pi sessions. agy's global MCP
  // config merges both into every turn's tools/list; the per-session prefix
  // must make routing unambiguous.
  const a = new AgyPiBridge("pi-bridge-111");
  const b = new AgyPiBridge("pi-bridge-222");
  a.setToolPrefix("pi__p111__");
  b.setToolPrefix("pi__p222__");
  let routedTo: string | undefined;
  a.setOnCall((call) => {
    routedTo = `a:${call.tool}`;
    setTimeout(() => a.resolveCall(call.id, { content: "from-a", isError: false }), 5);
    return true;
  });
  b.setOnCall((call) => {
    routedTo = `b:${call.tool}`;
    setTimeout(() => b.resolveCall(call.id, { content: "from-b", isError: false }), 5);
    return true;
  });
  a.setToolSource(() => TOOL_DEFS);
  b.setToolSource(() => TOOL_DEFS);
  await a.start();
  await b.start();
  try {
    a.refreshTools();
    b.refreshTools();

    const listA = await post(a, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const namesA = (listA.json.result.tools as Array<{ name: string }>).map((t) => t.name);
    assert.deepEqual(namesA, ["pi__p111__commit"]);

    // A's prefixed name routes to A only — even though B serves the same
    // underlying tool and both have active turns.
    const res = await post(a, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "pi__p111__commit", arguments: {} },
    });
    assert.equal(res.json.result.content[0].text, "from-a");
    assert.equal(routedTo, "a:commit");

    // A's name is NOT valid on B's bridge: the other session cannot be
    // reached through it.
    const wrong = await post(b, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "pi__p111__commit", arguments: {} },
    });
    assert.equal(wrong.json.result.isError, true);
    assert.match(wrong.json.result.content[0].text, /unknown tool/);
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

test("selectBridgedTools bridges only MCP adapter tools", () => {
  const tools = [
    { name: "read", sourceInfo: { source: "builtin" } },
    { name: "ask_user", sourceInfo: { source: "npm:@tian.zuo/pi-ask-user" } },
    { name: "web_search", sourceInfo: { source: "npm:@tian.zuo/pi-web-search" } },
    { name: "todo", sourceInfo: { source: "npm:@tian.zuo/pi-todo" } },
    { name: "mcp", sourceInfo: { source: "npm:pi-mcp-adapter" } },
    { name: "mcpScript", sourceInfo: { source: "npm:pi-mcp-adapter@2" } },
    { name: "github_search_issues", sourceInfo: { source: "npm:pi-mcp-adapter" } },
    { name: "antigravity", sourceInfo: { source: "npm:pi-mcp-adapter" } },
    { name: "orphan", sourceInfo: {} },
  ].map((tool) => ({
    ...tool,
    description: `${tool.name} description`,
    parameters: { type: "object", properties: {} },
  }));
  const active = [
    "read",
    "ask_user",
    "web_search",
    "todo",
    "mcp",
    "mcpScript",
    "github_search_issues",
    "antigravity",
  ];
  const bridged = selectBridgedTools(tools, active).map((tool) => tool.name);
  // MCP adapter tools only — no builtins, no pi-session extension tools,
  // no replay wrapper, no inactive tools, no unknown sources.
  assert.deepEqual(bridged, ["mcp", "mcpScript", "github_search_issues"]);
});

test("createBridgeLifecycleManager handles start-success/add-failure, retry, teardown, and fallback", async () => {
  const bridge = new AgyPiBridge("pi-bridge-lifecycle");
  let mcpAddShouldFail = true;
  let addCalls = 0;
  let removeCalls = 0;
  let evictCalls = 0;
  let pruneCalls = 0;
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
    pruneStaleRegistrations: async () => {
      pruneCalls++;
    },
    addMcpServer: async (_name, _url, _token) => {
      addCalls++;
      if (mcpAddShouldFail) {
        throw new Error("agy mcp add connection refused");
      }
    },
    removeMcpServer: async (_name) => {
      removeCalls++;
    },
    evictMcpCache: async (_name) => {
      evictCalls++;
    },
    notifyWarning: (msg) => warnings.push(msg),
  });

  try {
    // 1. Initial attempt: bridge starts listening, but addMcpServer fails
    const firstResult = await manager.ensureRegistered();
    assert.equal(firstResult, false, "ensureRegistered reports failure");
    assert.equal(manager.isRunning(), true, "HTTP listener started successfully");
    assert.equal(manager.isRegistered(), false, "not marked as registered");
    assert.equal(pruneCalls, 1);
    assert.equal(addCalls, 1);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /pi-tool bridge unavailable/);

    // Fallback: direct skill catalog is provided because registration failed
    const fallbackSuffix = manager.getBootstrapSuffix(skills);
    assert.ok(fallbackSuffix);
    assert.match(fallbackSuffix, /## pi Agent Skills/);
    assert.match(fallbackSuffix, /herdr/);

    // 2. Retry attempt: addMcpServer succeeds
    mcpAddShouldFail = false;
    const secondResult = await manager.ensureRegistered();
    assert.equal(secondResult, true, "ensureRegistered reports success on retry");
    assert.equal(manager.isRunning(), true);
    assert.equal(manager.isRegistered(), true, "marked as registered");
    assert.equal(addCalls, 2);

    // When registered: bootstrap suffix is suppressed (empty/undefined)
    assert.equal(manager.getBootstrapSuffix(skills), undefined);

    // Idempotent: calling ensureRegistered again when already registered is a no-op
    const thirdResult = await manager.ensureRegistered();
    assert.equal(thirdResult, true);
    assert.equal(addCalls, 2, "did not call addMcpServer again");

    // 3. Teardown
    await manager.teardown();
    assert.equal(manager.isRunning(), false, "bridge closed");
    assert.equal(manager.isRegistered(), false, "marked as unregistered");
    assert.equal(removeCalls, 1, "removeMcpServer called");
    assert.equal(evictCalls, 1, "evictMcpCache called");

    // Post-teardown: fallback catalog is provided again
    assert.ok(manager.getBootstrapSuffix(skills));
  } finally {
    await manager.teardown();
  }
});

test("createBridgeLifecycleManager respects disabled setting", async () => {
  const bridge = new AgyPiBridge("pi-bridge-disabled");
  let addCalled = false;
  const manager = createBridgeLifecycleManager({
    bridge,
    bridgeToken: "test-token",
    enabled: false,
    addMcpServer: async () => {
      addCalled = true;
    },
    removeMcpServer: async () => {},
    evictMcpCache: async () => {},
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
  assert.ok(manager.getBootstrapSuffix(skills));
});
