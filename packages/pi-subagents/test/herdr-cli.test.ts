import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, beforeEach, afterEach } from "node:test";
import { Effect } from "effect";
import {
  HerdrApiError,
  HerdrCommandError,
  herdrJson,
  herdrText,
  stripAnsi,
} from "../lib/herdr/cli.ts";
import {
  isHerdrAvailable,
  resetHerdrCapabilityCache,
  setHerdrBinaryPathForTests,
} from "../lib/herdr/capability.ts";
import { currentLayout, pickSplitDirection, readAgent, waitForShell } from "../lib/herdr/workspace.ts";

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "fake-herdr.mjs",
);

function fakeCliOptions(): { command: string; argsPrefix: string[] } {
  return { command: process.execPath, argsPrefix: [FIXTURE] };
}

function withEnv(
  overrides: Record<string, string | undefined>,
  fn: () => Promise<void>,
): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) {
    saved[key] = process.env[key];
    const value = overrides[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return fn().finally(() => {
    for (const key of Object.keys(overrides)) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

describe("herdr cli", () => {
  it("herdrJson unwraps the JSON result envelope", async () => {
    const result = await Effect.runPromise(
      herdrJson(["pane", "layout", "--current"], fakeCliOptions()),
    );
    assert.deepEqual((result as { layout?: { area?: { width?: number } } }).layout?.area, {
      width: 200,
      height: 40,
      x: 0,
      y: 0,
    });
  });

  it("maps failure envelope to HerdrApiError with code preserved", async () => {
    await withEnv({ FAKE_HERDR_API_ERROR: "agent_pane_not_found" }, async () => {
      await assert.rejects(
        () =>
          Effect.runPromise(
            herdrJson(["agent", "start", "sa-test"], fakeCliOptions()),
          ),
        (error: unknown) => {
          assert.ok(error instanceof HerdrApiError);
          assert.equal(error.code, "agent_pane_not_found");
          return true;
        },
      );
    });
  });

  it("maps non-JSON stdout to HerdrCommandError with raw text", async () => {
    await withEnv(
      { FAKE_HERDR_PLAIN_ERROR: "unsupported interactive agent kind: notarealkind" },
      async () => {
        await assert.rejects(
          () => Effect.runPromise(herdrJson(["agent", "start", "sa-test"], fakeCliOptions())),
          (error: unknown) => {
            assert.ok(error instanceof HerdrCommandError);
            assert.equal(
              error.message,
              "unsupported interactive agent kind: notarealkind",
            );
            return true;
          },
        );
      },
    );
  });

  it("herdrText returns raw stdout verbatim and never JSON-parses it", async () => {
    const raw = await Effect.runPromise(
      herdrText(["agent", "read", "sa-test", "--source", "recent-unwrapped", "--lines", "80"], fakeCliOptions()),
    );
    assert.match(raw, /\u001b\[31m/);
    assert.match(raw, /raw agent text/);
    assert.equal(raw.includes("{"), false);
  });

  it("stripAnsi removes escape sequences", () => {
    const cleaned = stripAnsi("\u001b[31m\u250c box \u001b[0mhello");
    assert.equal(cleaned, "\u250c box hello");
  });
});

describe("herdr capability", () => {
  const savedHerdrEnv = process.env.HERDR_ENV;

  beforeEach(() => {
    resetHerdrCapabilityCache();
    setHerdrBinaryPathForTests(undefined);
  });

  afterEach(() => {
    resetHerdrCapabilityCache();
    setHerdrBinaryPathForTests(undefined);
    if (savedHerdrEnv === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = savedHerdrEnv;
  });

  it("is false when HERDR_ENV is unset", () => {
    delete process.env.HERDR_ENV;
    setHerdrBinaryPathForTests(FIXTURE);
    assert.equal(isHerdrAvailable(), false);
  });

  it("is false when the binary is missing on PATH", () => {
    process.env.HERDR_ENV = "1";
    setHerdrBinaryPathForTests(null);
    assert.equal(isHerdrAvailable(), false);
  });

  it("is true when HERDR_ENV is set and binary resolves", () => {
    process.env.HERDR_ENV = "1";
    setHerdrBinaryPathForTests(FIXTURE);
    assert.equal(isHerdrAvailable(), true);
  });
});

describe("herdr workspace", () => {
  it("pickSplitDirection chooses right for wide layouts and down for narrow", () => {
    assert.equal(pickSplitDirection(120), "right");
    assert.equal(pickSplitDirection(200), "right");
    assert.equal(pickSplitDirection(119), "down");
    assert.equal(pickSplitDirection(80), "down");
  });

  it("currentLayout picks split direction from layout width", async () => {
    await withEnv({ FAKE_HERDR_WIDTH: "80" }, async () => {
      const layout = await Effect.runPromise(currentLayout(fakeCliOptions()));
      assert.equal(layout.direction, "down");
      assert.equal(layout.area.width, 80);
    });

    await withEnv({ FAKE_HERDR_WIDTH: "200" }, async () => {
      const layout = await Effect.runPromise(currentLayout(fakeCliOptions()));
      assert.equal(layout.direction, "right");
      assert.equal(layout.area.width, 200);
    });
  });

  it("readAgent uses herdrText and strips ANSI", async () => {
    await withEnv({ FAKE_HERDR_TRANSCRIPT: undefined }, async () => {
      const text = await Effect.runPromise(readAgent("sa-test", 80, fakeCliOptions()));
      assert.equal(text, "\u250c box raw agent text\n");
      assert.equal(text.includes("\u001b"), false);
    });
  });

  it("waitForShell resolves when fg_pgid equals shell_pid on the first poll", async () => {
    await withEnv({ FAKE_HERDR_PROCESS_STATE: "ready" }, async () => {
      await Effect.runPromise(waitForShell("pane-1", fakeCliOptions()));
    });
  });

  it("waitForShell retries until fg_pgid equals shell_pid", async () => {
    const busyFile = path.join(os.tmpdir(), `fake-herdr-busy-${process.pid}-${Date.now()}`);
    fs.writeFileSync(busyFile, "2", "utf8");
    try {
      await withEnv(
        {
          FAKE_HERDR_BUSY_FILE: busyFile,
          FAKE_HERDR_PROCESS_STATE: undefined,
        },
        async () => {
          await Effect.runPromise(
            waitForShell("pane-1", { ...fakeCliOptions(), deadlineMs: 2_000, pollMs: 50 }),
          );
        },
      );
      assert.equal(fs.readFileSync(busyFile, "utf8"), "0");
    } finally {
      fs.rmSync(busyFile, { force: true });
    }
  });

  it("waitForShell fails with a clear error when the shell stays busy", async () => {
    await withEnv({ FAKE_HERDR_PROCESS_STATE: "busy" }, async () => {
      await assert.rejects(
        () =>
          Effect.runPromise(
            waitForShell("pane-1", {
              ...fakeCliOptions(),
              deadlineMs: 200,
              pollMs: 50,
            }),
          ),
        (error: unknown) => {
          assert.ok(error instanceof HerdrCommandError);
          assert.match(error.message, /shell did not become ready within 200ms/);
          assert.match(error.message, /pane-1/);
          return true;
        },
      );
    });
  });

  it("waitForShell treats malformed process_info as not-ready until timeout", async () => {
    await withEnv({ FAKE_HERDR_PROCESS_INFO_SHAPE: "malformed" }, async () => {
      await assert.rejects(
        () =>
          Effect.runPromise(
            waitForShell("pane-1", {
              ...fakeCliOptions(),
              deadlineMs: 200,
              pollMs: 50,
            }),
          ),
        (error: unknown) => {
          assert.ok(error instanceof HerdrCommandError);
          return true;
        },
      );
    });
  });

  it("waitForShell treats missing process_info as not-ready until timeout", async () => {
    await withEnv({ FAKE_HERDR_PROCESS_INFO_SHAPE: "missing" }, async () => {
      await assert.rejects(
        () =>
          Effect.runPromise(
            waitForShell("pane-1", {
              ...fakeCliOptions(),
              deadlineMs: 200,
              pollMs: 50,
            }),
          ),
        (error: unknown) => {
          assert.ok(error instanceof HerdrCommandError);
          return true;
        },
      );
    });
  });
});
