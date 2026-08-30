import assert from "node:assert/strict";
import { test } from "node:test";
import { AgyPiBridge } from "../lib/bridge.ts";
import { createBridgeLifecycleManager } from "../lib/bridge-lifecycle.ts";

test("bridge lifecycle process revision combines registration generation and catalog revision", async () => {
  const bridge = new AgyPiBridge("pi-bridge-generation");
  bridge.setToolSource(() => [
    { name: "mcp", description: "gateway", parameters: { type: "object" } },
  ]);
  const manager = createBridgeLifecycleManager({
    bridge,
    bridgeToken: "token",
    addMcpServer: async () => {},
    removeMcpServer: async () => {},
    evictMcpCache: async () => {},
  });
  try {
    assert.equal(manager.processRevision(), "0:0");
    assert.equal(await manager.ensureRegistered(), true);
    assert.equal(manager.registrationGeneration(), 1);
    assert.equal(manager.processRevision(), `1:${bridge.catalogRevision}`);
    const registeredRevision = manager.processRevision();

    assert.equal(await manager.ensureRegistered(), true);
    assert.equal(manager.processRevision(), registeredRevision);

    bridge.setDynamicTools([
      {
        name: "activate_skill",
        description: "activate",
        parameters: { type: "object", properties: { name: { enum: ["x"] } } },
        handler: async () => ({ content: "ok", isError: false }),
      },
    ]);
    assert.notEqual(manager.processRevision(), registeredRevision);

    await manager.teardown();
    assert.equal(manager.registrationGeneration(), 2);
    assert.match(manager.processRevision(), /^2:/);
  } finally {
    await manager.teardown();
  }
});
