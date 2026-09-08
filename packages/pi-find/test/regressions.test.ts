import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { resolveBinary } from "../src/binaries.ts";
import { createSearchRuntime, runSearch, SearchRuntime } from "../src/runtime.ts";
import { streamLines } from "../src/stream.ts";
import { displayPath } from "../lib/tools.ts";

const hasBoth = resolveBinary("rg") !== null && resolveBinary("fd") !== null;

async function fixture(
  run: (root: string, runtime: ReturnType<typeof createSearchRuntime>) => Promise<void>,
) {
  const root = mkdtempSync(join(tmpdir(), "pi-find-regression-"));
  const runtime = createSearchRuntime();
  try {
    mkdirSync(join(root, "src", "deep"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "needle\n");
    writeFileSync(join(root, "src", "deep", "b.ts"), "needle\n");
    writeFileSync(join(root, "src", "ignored.ts"), "needle\n");
    writeFileSync(join(root, ".gitignore"), "ignored.ts\n");
    await run(root, runtime);
  } finally {
    await runtime.dispose();
    rmSync(root, { recursive: true, force: true });
  }
}

test("slash globs are root-relative and do not override ignores", { skip: !hasBoth }, async () => {
  await fixture(async (cwd, runtime) => {
    const service = runtime.runSync(SearchRuntime);
    for (const [path, pattern, expected] of [
      [undefined, "src/*.ts", ["src/a.ts"]],
      [undefined, "src/**/*.ts", ["src/a.ts", "src/deep/b.ts"]],
      ["src", "deep/*.ts", ["src/deep/b.ts"]],
      [undefined, "*.ts", ["src/a.ts", "src/deep/b.ts"]],
      [undefined, "*.TS", []],
      [undefined, "{src/a.ts,src/deep/b.ts}", ["src/a.ts", "src/deep/b.ts"]],
    ] as const) {
      const found = await runSearch(runtime, service.find({ cwd, path, pattern }));
      const grepped = await runSearch(
        runtime,
        service.grep({ cwd, path, pattern: "needle", glob: pattern }),
      );
      assert.deepEqual([...found.files].sort(), expected);
      assert.deepEqual(grepped.matches.map((match) => match.path).sort(), expected);
    }
  });
});

test("option-like patterns are data, not fd flags", { skip: !hasBoth }, async () => {
  await fixture(async (cwd, runtime) => {
    writeFileSync(join(cwd, "--version"), "needle\n");
    const service = runtime.runSync(SearchRuntime);
    const found = await runSearch(runtime, service.find({ cwd, pattern: "--version" }));
    assert.deepEqual(found.files, ["--version"]);
  });
});

test("ripgrep ignores user configuration", { skip: !hasBoth }, async () => {
  await fixture(async (cwd, runtime) => {
    const config = join(cwd, "rg.conf");
    writeFileSync(config, "--ignore-case\n--no-ignore\n");
    const previous = process.env.RIPGREP_CONFIG_PATH;
    process.env.RIPGREP_CONFIG_PATH = config;
    try {
      const service = runtime.runSync(SearchRuntime);
      assert.deepEqual(
        (await runSearch(runtime, service.grep({ cwd, pattern: "NEEDLE" }))).matches,
        [],
      );
      const matches = (
        await runSearch(runtime, service.grep({ cwd, pattern: "needle", glob: "src/*.ts" }))
      ).matches;
      assert.deepEqual(
        matches.map((match) => match.path),
        ["src/a.ts"],
      );
    } finally {
      if (previous === undefined) delete process.env.RIPGREP_CONFIG_PATH;
      else process.env.RIPGREP_CONFIG_PATH = previous;
    }
  });
});

test("special filenames survive search and display round trips", {
  skip: !hasBoth || process.platform === "win32",
}, async () => {
  await fixture(async (cwd, runtime) => {
    const names = ["line\nbreak.ts", "literal\\name.ts", "return\r.ts", "引數.ts"];
    mkdirSync(join(cwd, "special"));
    for (const name of names) writeFileSync(join(cwd, "special", name), "needle\n");
    const service = runtime.runSync(SearchRuntime);
    const found = await runSearch(runtime, service.find({ cwd, path: "special", pattern: "*.ts" }));
    const grepped = await runSearch(
      runtime,
      service.grep({ cwd, path: "special", pattern: "needle" }),
    );
    const expected = names.map((name) => `special/${name}`).sort();
    assert.deepEqual([...found.files].sort(), expected);
    assert.deepEqual(grepped.matches.map((match) => match.path).sort(), expected);
    for (const file of found.files) {
      const displayed = displayPath(file);
      assert.equal(displayed.includes("\n"), false);
      assert.equal(displayed.startsWith('"') ? JSON.parse(displayed) : displayed, file);
    }
  });
});

test("normalizes @ and home paths; rejects explicit .git roots and aliases", {
  skip: !hasBoth,
}, async () => {
  await fixture(async (cwd, runtime) => {
    const service = runtime.runSync(SearchRuntime);
    for (const path of ["@src", `~/${relative(homedir(), join(cwd, "src"))}`]) {
      assert.equal(
        (await runSearch(runtime, service.find({ cwd, path, pattern: "a.ts" }))).files.length,
        1,
      );
      assert.equal(
        (await runSearch(runtime, service.grep({ cwd, path, pattern: "needle", glob: "a.ts" })))
          .matches.length,
        1,
      );
    }
    mkdirSync(join(cwd, ".git"));
    writeFileSync(join(cwd, ".git", "config"), "needle\n");
    const paths = [".git"];
    if (process.platform !== "win32") {
      symlinkSync(join(cwd, ".git"), join(cwd, "git-alias"));
      paths.push("git-alias");
    }
    for (const path of paths) {
      await assert.rejects(
        runSearch(runtime, service.find({ cwd, path, pattern: "*" })),
        /inside .git are excluded/,
      );
      await assert.rejects(
        runSearch(runtime, service.grep({ cwd, path, pattern: "needle" })),
        /inside .git are excluded/,
      );
    }
    await assert.rejects(
      runSearch(runtime, service.grep({ cwd, path: ".git/config", pattern: "needle" })),
      /inside .git are excluded/,
    );
    if (process.platform !== "win32") {
      rmSync(join(cwd, ".git"), { recursive: true });
      symlinkSync(join(cwd, "src"), join(cwd, ".git"));
      await assert.rejects(
        runSearch(runtime, service.find({ cwd, path: ".git", pattern: "*" })),
        /inside .git are excluded/,
      );
    }
  });
});

test("unexpected signal termination is an error", {
  skip: !hasBoth || process.platform === "win32",
}, async () => {
  await fixture(async (cwd, runtime) => {
    const pre = join(cwd, "pre");
    writeFileSync(pre, '#!/bin/sh\nkill -KILL "$PPID"\n');
    chmodSync(pre, 0o755);
    await assert.rejects(
      runSearch(
        runtime,
        streamLines({
          binary: "rg",
          cwd,
          args: ["--no-config", "--pre", pre, "needle", "src/a.ts"],
          onLine: () => true,
        }),
      ),
      /terminated by SIGKILL/,
    );
  });
});

test("active search cancellation returns promptly", {
  skip: !hasBoth || process.platform === "win32",
  timeout: 3000,
}, async () => {
  await fixture(async (cwd, runtime) => {
    const fifo = join(cwd, "pipe");
    assert.equal(spawnSync("mkfifo", [fifo]).status, 0);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 100);
    try {
      await assert.rejects(
        runSearch(
          runtime,
          streamLines({
            binary: "rg",
            cwd,
            args: ["--no-config", "needle", fifo],
            onLine: () => true,
            signal: controller.signal,
          }),
          { signal: controller.signal },
        ),
        (error: Error) => error.name === "AbortError",
      );
    } finally {
      clearTimeout(timer);
    }
  });
});
