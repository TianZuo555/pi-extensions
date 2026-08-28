import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createFrameSplitter, encodeFrame, PROTOCOL_VERSION } from "../lib/protocol.ts";
import {
  BridgeClient,
  BridgeRejectedError,
  createBridgeClient,
  runBridge,
  type BridgeHello,
} from "../src/runtime.ts";

interface TestServer {
  readonly dir: string;
  readonly socketPath: string;
  readonly workspace: string;
  readonly server: Server;
  readonly close: () => Promise<void>;
}

function makeHello(piCwd: string): BridgeHello {
  return {
    sessionId: "test-session",
    piCwd,
    sessionFile: null,
    name: null,
  };
}

async function startTestServer(workspace: string): Promise<TestServer> {
  const dir = mkdtempSync(join(tmpdir(), "pi-vscode-bridge-"));
  const bridgeDir = join(dir, "vscode-bridge");
  await mkdir(bridgeDir, { recursive: true });
  const socketPath = join(bridgeDir, `${process.pid}.sock`);
  const registryPath = join(bridgeDir, `${process.pid}.json`);

  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });

  writeFileSync(
    registryPath,
    JSON.stringify({
      pid: process.pid,
      socketPath,
      workspaceFolders: [workspace],
      startedAt: Date.now(),
    }),
    "utf8",
  );

  return {
    dir,
    socketPath,
    workspace,
    server,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function withAgentDir<T>(agentDir: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  return fn().finally(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  });
}

test("discover finds related servers and ignores unrelated cwd", async () => {
  const workspace = join(tmpdir(), `bridge-ws-${Date.now()}`);
  const testServer = await startTestServer(workspace);
  try {
    await withAgentDir(testServer.dir, async () => {
      const runtime = createBridgeClient();
      const client = runtime.runSync(BridgeClient);
      const inside = join(workspace, "pkg");
      const found = await runBridge(runtime, client.discover(inside));
      assert.equal(found.length, 1);
      assert.equal(found[0]!.socketPath, testServer.socketPath);

      const unrelated = await runBridge(runtime, client.discover(join(tmpdir(), "nowhere")));
      assert.deepEqual(unrelated, []);

      await runtime.dispose();
    });
  } finally {
    await testServer.close();
    rmSync(testServer.dir, { recursive: true, force: true });
  }
});

test("discover skips registries whose socket is gone", async () => {
  const workspace = join(tmpdir(), `bridge-ws-${Date.now()}`);
  const testServer = await startTestServer(workspace);
  try {
    await testServer.close();
    await withAgentDir(testServer.dir, async () => {
      const runtime = createBridgeClient();
      const client = runtime.runSync(BridgeClient);
      const found = await runBridge(runtime, client.discover(workspace));
      assert.deepEqual(found, []);
      await runtime.dispose();
    });
  } finally {
    rmSync(testServer.dir, { recursive: true, force: true });
  }
});

test("connect resolves on welcome and delivers prefill callbacks", async () => {
  const workspace = join(tmpdir(), `bridge-ws-${Date.now()}`);
  const testServer = await startTestServer(workspace);
  const hello = makeHello(join(workspace, "pkg"));

  let sawHello = false;
  let prefillText = "";
  let serverSocket: Socket | undefined;

  testServer.server.removeAllListeners("connection");
  testServer.server.on("connection", (socket: Socket) => {
    serverSocket = socket;
    socket.setEncoding("utf8");
    const split = createFrameSplitter();
    socket.on("data", (chunk: string) => {
      for (const line of split(chunk)) {
        const message = JSON.parse(line) as { type: string };
        if (message.type === "hello") {
          sawHello = true;
          socket.write(
            encodeFrame({
              type: "welcome",
              protocol: PROTOCOL_VERSION,
              workspaceFolders: [workspace],
            }),
          );
        }
      }
    });
  });

  try {
    await withAgentDir(testServer.dir, async () => {
      const runtime = createBridgeClient();
      const client = runtime.runSync(BridgeClient);
      await runBridge(
        runtime,
        client.connect(
          {
            pid: process.pid,
            socketPath: testServer.socketPath,
            workspaceFolders: [workspace],
            startedAt: Date.now(),
          },
          hello,
          {
            onPrefill: (text) => {
              prefillText = text;
            },
            onDetached: () => {},
            onLost: () => {},
            onReattached: () => {},
          },
        ),
      );

      assert.ok(serverSocket);
      serverSocket!.write(encodeFrame({ type: "prefill", text: "src/foo.ts:12-40 " }));
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(sawHello, true);
      assert.equal(prefillText, "src/foo.ts:12-40 ");

      await runBridge(runtime, client.disconnect("disconnect"));
      await runtime.dispose();
    });
  } finally {
    await testServer.close();
    rmSync(testServer.dir, { recursive: true, force: true });
  }
});

test("reject fails connect with BridgeRejectedError", async () => {
  const workspace = join(tmpdir(), `bridge-ws-${Date.now()}`);
  const testServer = await startTestServer(workspace);
  const hello = makeHello(workspace);

  testServer.server.removeAllListeners("connection");
  testServer.server.on("connection", (socket: Socket) => {
    socket.setEncoding("utf8");
    const split = createFrameSplitter();
    socket.on("data", (chunk: string) => {
      for (const line of split(chunk)) {
        const message = JSON.parse(line) as { type: string };
        if (message.type === "hello") {
          socket.write(encodeFrame({ type: "reject", reason: "nope" }));
        }
      }
    });
  });

  try {
    await withAgentDir(testServer.dir, async () => {
      const runtime = createBridgeClient();
      const client = runtime.runSync(BridgeClient);
      await assert.rejects(
        () =>
          runBridge(
            runtime,
            client.connect(
              {
                pid: process.pid,
                socketPath: testServer.socketPath,
                workspaceFolders: [workspace],
                startedAt: Date.now(),
              },
              hello,
              {
                onPrefill: () => {},
                onDetached: () => {},
                onLost: () => {},
                onReattached: () => {},
              },
            ),
          ),
        (error: unknown) => error instanceof BridgeRejectedError && error.reason === "nope",
      );
      await runtime.dispose();
    });
  } finally {
    await testServer.close();
    rmSync(testServer.dir, { recursive: true, force: true });
  }
});

test("detached suppresses retry", async () => {
  const workspace = join(tmpdir(), `bridge-ws-${Date.now()}`);
  const testServer = await startTestServer(workspace);
  const hello = makeHello(workspace);

  let connectionCount = 0;
  testServer.server.removeAllListeners("connection");
  testServer.server.on("connection", (socket: Socket) => {
    connectionCount += 1;
    socket.setEncoding("utf8");
    const split = createFrameSplitter();
    let welcomed = false;
    socket.on("data", (chunk: string) => {
      for (const line of split(chunk)) {
        const message = JSON.parse(line) as { type: string };
        if (message.type === "hello" && !welcomed) {
          welcomed = true;
          socket.write(
            encodeFrame({
              type: "welcome",
              protocol: PROTOCOL_VERSION,
              workspaceFolders: [workspace],
            }),
          );
          socket.write(encodeFrame({ type: "detached", reason: "superseded" }));
          socket.end();
        }
      }
    });
  });

  let detached = false;
  try {
    await withAgentDir(testServer.dir, async () => {
      const runtime = createBridgeClient({ testControls: { retryDelaysMs: [50, 100, 200] } });
      const client = runtime.runSync(BridgeClient);
      await runBridge(
        runtime,
        client.connect(
          {
            pid: process.pid,
            socketPath: testServer.socketPath,
            workspaceFolders: [workspace],
            startedAt: Date.now(),
          },
          hello,
          {
            onPrefill: () => {},
            onDetached: () => {
              detached = true;
            },
            onLost: () => {
              throw new Error("should not lose connection after detached");
            },
            onReattached: () => {
              throw new Error("should not reattach after detached");
            },
          },
        ),
      );

      await new Promise((resolve) => setTimeout(resolve, 1500));
      assert.equal(detached, true);
      assert.equal(connectionCount, 1);
      await runtime.dispose();
    });
  } finally {
    await testServer.close();
    rmSync(testServer.dir, { recursive: true, force: true });
  }
});

test("disconnect writes bye frame", async () => {
  const workspace = join(tmpdir(), `bridge-ws-${Date.now()}`);
  const testServer = await startTestServer(workspace);
  const hello = makeHello(workspace);

  let byeLine = "";
  testServer.server.removeAllListeners("connection");
  testServer.server.on("connection", (socket: Socket) => {
    socket.setEncoding("utf8");
    const split = createFrameSplitter();
    socket.on("data", (chunk: string) => {
      for (const line of split(chunk)) {
        const message = JSON.parse(line) as { type: string; reason?: string };
        if (message.type === "hello") {
          socket.write(
            encodeFrame({
              type: "welcome",
              protocol: PROTOCOL_VERSION,
              workspaceFolders: [workspace],
            }),
          );
        }
        if (message.type === "bye") {
          byeLine = line;
        }
      }
    });
  });

  try {
    await withAgentDir(testServer.dir, async () => {
      const runtime = createBridgeClient();
      const client = runtime.runSync(BridgeClient);
      await runBridge(
        runtime,
        client.connect(
          {
            pid: process.pid,
            socketPath: testServer.socketPath,
            workspaceFolders: [workspace],
            startedAt: Date.now(),
          },
          hello,
          {
            onPrefill: () => {},
            onDetached: () => {},
            onLost: () => {},
            onReattached: () => {},
          },
        ),
      );
      await runBridge(runtime, client.disconnect("disconnect"));
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.match(byeLine, /"type":"bye"/);
      assert.match(byeLine, /"reason":"disconnect"/);
      await runtime.dispose();
    });
  } finally {
    await testServer.close();
    rmSync(testServer.dir, { recursive: true, force: true });
  }
});

test("reattaches after an unexpected close", async () => {
  const workspace = join(tmpdir(), `bridge-ws-${Date.now()}`);
  const testServer = await startTestServer(workspace);
  const hello = makeHello(workspace);

  let connectionCount = 0;
  let shouldDrop = true;

  testServer.server.removeAllListeners("connection");
  testServer.server.on("connection", (socket: Socket) => {
    connectionCount += 1;
    socket.setEncoding("utf8");
    const split = createFrameSplitter();
    socket.on("data", (chunk: string) => {
      for (const line of split(chunk)) {
        const message = JSON.parse(line) as { type: string };
        if (message.type === "hello") {
          socket.write(
            encodeFrame({
              type: "welcome",
              protocol: PROTOCOL_VERSION,
              workspaceFolders: [workspace],
            }),
          );
          if (shouldDrop) {
            shouldDrop = false;
            socket.destroy();
          }
        }
      }
    });
  });

  let reattached = false;
  try {
    await withAgentDir(testServer.dir, async () => {
      const runtime = createBridgeClient({ testControls: { retryDelaysMs: [25, 50] } });
      const client = runtime.runSync(BridgeClient);
      await runBridge(
        runtime,
        client.connect(
          {
            pid: process.pid,
            socketPath: testServer.socketPath,
            workspaceFolders: [workspace],
            startedAt: Date.now(),
          },
          hello,
          {
            onPrefill: () => {},
            onDetached: () => {},
            onLost: () => {
              throw new Error("should not give up while server is still available");
            },
            onReattached: () => {
              reattached = true;
            },
          },
        ),
      );

      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(reattached, true);
      assert.equal(connectionCount, 2);
      await runBridge(runtime, client.disconnect("disconnect"));
      await runtime.dispose();
    });
  } finally {
    await testServer.close();
    rmSync(testServer.dir, { recursive: true, force: true });
  }
});

test("calls onLost when every retry fails", async () => {
  const workspace = join(tmpdir(), `bridge-ws-${Date.now()}`);
  const testServer = await startTestServer(workspace);
  const registryPath = join(testServer.dir, "vscode-bridge", `${process.pid}.json`);
  const hello = makeHello(workspace);

  testServer.server.removeAllListeners("connection");
  testServer.server.on("connection", (socket: Socket) => {
    socket.setEncoding("utf8");
    const split = createFrameSplitter();
    let welcomed = false;
    socket.on("data", (chunk: string) => {
      for (const line of split(chunk)) {
        const message = JSON.parse(line) as { type: string };
        if (message.type === "hello" && !welcomed) {
          welcomed = true;
          socket.write(
            encodeFrame({
              type: "welcome",
              protocol: PROTOCOL_VERSION,
              workspaceFolders: [workspace],
            }),
          );
          socket.destroy();
        }
      }
    });
  });

  let lostCount = 0;
  try {
    await withAgentDir(testServer.dir, async () => {
      const runtime = createBridgeClient({ testControls: { retryDelaysMs: [10, 10] } });
      const client = runtime.runSync(BridgeClient);
      await runBridge(
        runtime,
        client.connect(
          {
            pid: process.pid,
            socketPath: testServer.socketPath,
            workspaceFolders: [workspace],
            startedAt: Date.now(),
          },
          hello,
          {
            onPrefill: () => {},
            onDetached: () => {},
            onLost: () => {
              lostCount += 1;
            },
            onReattached: () => {},
          },
        ),
      );

      await testServer.close();
      rmSync(registryPath, { force: true });

      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(lostCount, 1);
      await runBridge(runtime, client.disconnect("disconnect"));
      await runtime.dispose();
    });
  } finally {
    rmSync(testServer.dir, { recursive: true, force: true });
  }
});
