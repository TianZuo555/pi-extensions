import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { TerminalManager } from "./src/manager.ts";
import { SpawnError } from "./src/domain.ts";
import { createTerminalRuntime, runTool } from "./src/runtime.ts";

function command(script: string) {
  return `node -e "eval(Buffer.from('${Buffer.from(script).toString("base64")}','base64').toString())"`;
}

function running(pid: number) {
  const result = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
  return result.status === 0 && !result.stdout.trim().startsWith("Z");
}

for (const shutdown of [false, true]) {
  test(`redirected SIGTERM-resistant descendants are reaped on ${shutdown ? "disposal" : "natural exit"}`, {
    skip: process.platform === "win32",
    timeout: 20_000,
  }, async () => {
    const runtime = createTerminalRuntime();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bt-lifecycle-"));
    const ready = path.join(dir, "ready");
    let pid: number | undefined;
    try {
      const manager = await runtime.runPromise(TerminalManager);
      const childScript = `process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(${JSON.stringify(ready)}, String(process.pid)); setInterval(() => {}, 1000);`;
      const script = `
          const fs = require('node:fs');
          const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: 'ignore' });
          child.unref();
          const timer = setInterval(() => {
            if (!fs.existsSync(${JSON.stringify(ready)})) return;
            console.log(child.pid);
            clearInterval(timer);
            ${shutdown ? "setInterval(() => {}, 1000);" : ""}
          }, 10);
        `;
      const snap = await runtime.runPromise(
        manager.start({ command: command(script), cwd: dir, title: "redirected tree" }),
      );
      const deadline = Date.now() + 5_000;
      while (!fs.existsSync(ready) && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 10));
      pid = Number(fs.readFileSync(ready, "utf8"));
      assert.ok(Number.isSafeInteger(pid) && pid > 0);
      if (shutdown) {
        await runtime.dispose();
      } else {
        const result = await runtime.runPromise(manager.waitForSettlement(snap.id, 10_000));
        assert.equal(result.settled, true);
        assert.equal(result.snapshot.status, "done");
      }
      assert.equal(running(pid), false, `descendant ${pid} survived cleanup`);
    } finally {
      if (pid && running(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
      await runtime.dispose();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("archive identities never alias after runtime recreation", async () => {
  let oldId = "";
  for (const text of ["old", "new"]) {
    const runtime = createTerminalRuntime();
    try {
      const manager = await runtime.runPromise(TerminalManager);
      const snap = await runtime.runPromise(
        manager.start({ command: `printf ${text}`, cwd: process.cwd(), title: text }),
      );
      await runtime.runPromise(manager.waitForSettlement(snap.id, 5_000));
      if (oldId) {
        assert.notEqual(snap.id, oldId);
        await assert.rejects(
          runTool(runtime, manager.readLog({ id: oldId, stream: "stdout", offset: 0, limit: 64 })),
          /Unknown terminal id/,
        );
      }
      const page = await runtime.runPromise(
        manager.readLog({ id: snap.id, stream: "stdout", offset: 0, limit: 64 }),
      );
      assert.equal(page.text, text);
      oldId = snap.id;
    } finally {
      await runtime.dispose();
    }
  }
});

test("manager checks cancellation at the spawn boundary", async () => {
  const runtime = createTerminalRuntime();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bt-cancel-"));
  try {
    const manager = await runtime.runPromise(TerminalManager);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      runTool(
        runtime,
        manager.start({
          command: "echo forbidden > marker",
          cwd: dir,
          title: "cancelled",
          signal: controller.signal,
        }),
      ),
      (error: unknown) => {
        assert.ok(error instanceof SpawnError);
        assert.match(error.message, /aborted/i);
        assert.equal(error.fallbackSafe, false, "an abort must never authorize fallback");
        return true;
      },
    );
    assert.equal(manager.view.size(), 0);
    assert.equal(fs.existsSync(path.join(dir, "marker")), false);
  } finally {
    await runtime.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
