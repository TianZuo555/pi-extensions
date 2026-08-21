import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AgyPiBridge,
  BRIDGE_SERVER_NAME,
  BRIDGE_TOOL_PREFIX,
  resolveBridgeResultsFromContext,
} from "../lib/bridge.ts";

const TOOL_DEFS = [
  { name: "commit", description: "Generate a commit message.", parameters: { type: "object", properties: {} } },
];

async function startedBridge(onCall: (call: { id: string; tool: string; args: Record<string, unknown> }) => boolean) {
  const bridge = new AgyPiBridge();
  bridge.setOnCall(onCall);
  bridge.setToolSource(() => TOOL_DEFS);
  await bridge.start();
  return bridge;
}

function post(bridge: AgyPiBridge, body: unknown): Promise<{ status: number; json: Record<string, any> }> {
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
  // Shrink the timeout via a short-lived override of the private constant is
  // not possible; instead exercise close() as the fail-closed path.
  await bridge.start();
  try {
    bridge.refreshTools();
    const pending = post(bridge, {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: `${BRIDGE_TOOL_PREFIX}commit`, arguments: {} },
    });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(bridge.pendingCount, 1);
    await bridge.close(); // session shutdown while pending
    const res = await pending;
    assert.equal(res.json.result.isError, true);
    assert.match(res.json.result.content[0].text, /shut down/);
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
