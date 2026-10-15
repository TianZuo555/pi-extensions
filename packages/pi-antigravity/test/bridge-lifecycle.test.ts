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
    writeMcpConfig: async () => {},
    removeMcpConfig: async () => {},
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

test("concurrent preparation is single-flight and teardown waits for pending writes", async () => {
  const bridge = new AgyPiBridge("pi-preparation");
  let releaseWrite!: () => void;
  const blockedWrite = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  let enteredWrite!: () => void;
  const writing = new Promise<void>((resolve) => {
    enteredWrite = resolve;
  });
  let writes = 0;
  const removed: string[] = [];
  const manager = createBridgeLifecycleManager({
    bridge,
    bridgeToken: "token",
    writeMcpConfig: async () => {
      writes += 1;
      enteredWrite();
      await blockedWrite;
    },
    removeMcpConfig: async (name) => {
      removed.push(name);
    },
    evictMcpCache: async () => {},
  });
  try {
    const first = manager.ensureRegistered();
    const second = manager.ensureRegistered();
    await writing;
    assert.equal(manager.isRegistered(), false);
    const closing = manager.teardown();
    releaseWrite();
    assert.deepEqual(await Promise.all([first, second]), [true, true]);
    await closing;
    assert.equal(writes, 1);
    assert.deepEqual(removed, [bridge.serverName]);
    assert.equal(manager.isRegistered(), false);
    assert.equal(manager.isRunning(), false);
    assert.equal(manager.registrationGeneration(), 2);
    await manager.teardown();
    assert.deepEqual(removed, [bridge.serverName]);
  } finally {
    releaseWrite();
    await manager.teardown();
  }
});
