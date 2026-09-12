import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, before, test } from "node:test";
import { spawnSync } from "node:child_process";
import { Effect } from "effect";
import { resolveBinary } from "../src/binaries.ts";
import { streamLines } from "../src/stream.ts";
import { FIND_RESULT_LIMIT, GREP_RESULT_LIMIT } from "../lib/prompt.ts";
import {
  buildFdArgs,
  buildRgArgs,
  createSearchRuntime,
  MAX_LINE_LENGTH,
  runSearch,
  SearchRuntime,
  type FindRequest,
  type GrepRequest,
  type SearchRuntimeInstance,
} from "../src/runtime.ts";

const hasRg = resolveBinary("rg") !== null;
const hasFd = resolveBinary("fd") !== null;

let root: string;
let runtime: SearchRuntimeInstance;

before(() => {
  root = mkdtempSync(path.join(tmpdir(), "pi-find-simple-"));
  mkdirSync(path.join(root, "src", "deep"), { recursive: true });
  mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
  writeFileSync(path.join(root, ".gitignore"), "ignored.ts\n.env\n");
  writeFileSync(path.join(root, "src", "main.ts"), "needle\nNeedle\nconst value = 1;\n");
  writeFileSync(path.join(root, "src", "other.js"), "needle from js\n");
  writeFileSync(path.join(root, "src", "deep", "test.ts"), "deep needle\n");
  writeFileSync(path.join(root, "ignored.ts"), "ignored needle\n");
  writeFileSync(path.join(root, ".env"), "API_KEY=secret-needle\n");
  writeFileSync(path.join(root, ".secret.ts"), "hidden needle\n");
  writeFileSync(path.join(root, ".github", "workflows", "publish.yml"), "name: hidden-needle\n");
  writeFileSync(path.join(root, "long.txt"), `needle ${"x".repeat(900)}\n`);
  runtime = createSearchRuntime();
});

after(async () => {
  await runtime.dispose();
  rmSync(root, { recursive: true, force: true });
});

async function grep(
  request: Pick<GrepRequest, "pattern"> &
    Partial<Omit<GrepRequest, "pattern" | "cwd">> & {
      cwd?: string;
    },
) {
  const service = runtime.runSync(SearchRuntime);
  return runSearch(runtime, service.grep({ ...request, cwd: request.cwd ?? root }), {
    signal: request.signal,
  });
}

async function find(
  request: Pick<FindRequest, "pattern"> &
    Partial<Omit<FindRequest, "pattern" | "cwd">> & {
      cwd?: string;
    },
) {
  const service = runtime.runSync(SearchRuntime);
  return runSearch(runtime, service.find({ ...request, cwd: request.cwd ?? root }), {
    signal: request.signal,
  });
}

test("grep uses a case-sensitive regex", { skip: !hasRg }, async () => {
  const exact = await grep({ pattern: "^needle$", path: "src/main.ts" });
  assert.equal(exact.matches.length, 1);
  assert.equal(exact.matches[0]?.lineNumber, 1);

  const alternation = await grep({ pattern: "^(needle|Needle)$", path: "src/main.ts" });
  assert.equal(alternation.matches.length, 2);
});

test("grep treats invalid regex as an error instead of guessing literal intent", {
  skip: !hasRg,
}, async () => {
  await assert.rejects(() => grep({ pattern: "(" }), /regex parse error/i);
});

test("grep path is one file or directory and glob filters file names", {
  skip: !hasRg,
}, async () => {
  const file = await grep({ pattern: "needle", path: "src/main.ts" });
  assert.deepEqual(new Set(file.matches.map((match) => match.path)), new Set(["src/main.ts"]));

  const typescript = await grep({ pattern: "needle", path: "src", glob: "*.ts" });
  assert.ok(typescript.matches.every((match) => match.path.endsWith(".ts")));
  assert.ok(typescript.matches.some((match) => match.path === "src/deep/test.ts"));

  const ignored = await grep({ pattern: "needle", glob: "*.ts" });
  assert.equal(
    ignored.matches.some((match) => match.path === "ignored.ts"),
    false,
  );
  assert.equal(
    ignored.matches.some((match) => match.path === ".secret.ts"),
    false,
  );
});

test("a slash glob matches from the search root or the cwd", { skip: !hasRg }, async () => {
  // `path` scopes the search; the glob may still be written from the cwd.
  const scoped = await grep({ pattern: "needle", path: "src", glob: "src/*.ts" });
  assert.deepEqual(
    scoped.matches.map((match) => match.path),
    ["src/main.ts"],
  );

  const nested = await grep({ pattern: "needle", path: "src", glob: "deep/*.ts" });
  assert.deepEqual(
    nested.matches.map((match) => match.path),
    ["src/deep/test.ts"],
  );
});

test("a leading ! excludes like ripgrep's own globs", { skip: !hasRg }, async () => {
  const excluded = await grep({ pattern: "needle", glob: "!*.js" });
  assert.equal(
    excluded.matches.some((match) => match.path.endsWith(".js")),
    false,
  );
  assert.ok(excluded.matches.some((match) => match.path === "src/main.ts"));

  const excludedFromCwd = await grep({ pattern: "needle", path: "src", glob: "!src/*.ts" });
  assert.equal(
    excludedFromCwd.matches.some((match) => match.path === "src/main.ts"),
    false,
  );
  assert.ok(excludedFromCwd.matches.some((match) => match.path === "src/other.js"));

  await assert.rejects(() => grep({ pattern: "needle", glob: "!" }), /cannot be empty/);
});

test("grep skips hidden and ignored files by default", { skip: !hasRg }, async () => {
  const outcome = await grep({ pattern: "needle" });
  const paths = new Set(outcome.matches.map((match) => match.path));
  assert.equal(paths.has(".env"), false);
  assert.equal(paths.has(".github/workflows/publish.yml"), false);
  assert.equal(paths.has("ignored.ts"), false);
});

test("grep searches an explicitly named hidden path", { skip: !hasRg }, async () => {
  const directory = await grep({
    pattern: "hidden-needle",
    path: ".github",
    glob: "*.yml",
  });
  assert.deepEqual(
    directory.matches.map((match) => match.path),
    [".github/workflows/publish.yml"],
  );

  const file = await grep({ pattern: "secret-needle", path: ".env" });
  assert.deepEqual(
    file.matches.map((match) => match.path),
    [".env"],
  );
});

test("grep clips long lines", { skip: !hasRg }, async () => {
  const outcome = await grep({ pattern: "needle", path: "long.txt" });
  assert.equal(outcome.matches.length, 1);
  assert.ok(outcome.matches[0]!.text.length < 500);
  assert.match(outcome.matches[0]!.text, new RegExp(`^.{${MAX_LINE_LENGTH}}… \\(907 chars\\)$`));
});

test("grep stops after the fixed result limit and reports truncation", {
  skip: !hasRg,
}, async () => {
  writeFileSync(
    path.join(root, "many.txt"),
    Array.from({ length: GREP_RESULT_LIMIT + 1 }, (_, index) => `hit ${index}`).join("\n"),
  );
  const outcome = await grep({ pattern: "hit", path: "many.txt" });
  assert.equal(outcome.matches.length, GREP_RESULT_LIMIT);
  assert.equal(outcome.truncated, true);
  assert.equal(outcome.timedOut, false);
});

test("grep skips oversized files during directory traversal", { skip: !hasRg }, async () => {
  const bigDir = path.join(root, "big-dir");
  mkdirSync(bigDir);
  writeFileSync(path.join(bigDir, "oversized.txt"), `needle\n${"x".repeat(5 * 1024 * 1024)}\n`);
  writeFileSync(path.join(bigDir, "small.txt"), "needle\n");
  const outcome = await grep({ pattern: "needle", path: "big-dir" });
  assert.deepEqual(
    outcome.matches.map((match) => match.path),
    ["big-dir/small.txt"],
  );
  assert.equal(outcome.timedOut, false);
});

test("a wedged search is killed at the wall-clock budget and stays partial", {
  skip: !hasRg || process.platform === "win32",
}, async () => {
  const fifo = path.join(root, "stuck-pipe");
  spawnSync("mkfifo", [fifo]);
  const result = await Effect.runPromise(
    streamLines({
      binary: "rg",
      args: ["--regexp", "needle", "--", fifo],
      cwd: root,
      timeoutMs: 150,
      onLine: () => true,
    }),
  );
  assert.equal(result.timedOut, true);
  assert.equal(result.stoppedEarly, false);
});

test("an over-long record is cut instead of buffered whole", { skip: !hasRg }, async () => {
  writeFileSync(path.join(root, "wide.txt"), `needle ${"x".repeat(4000)}\n`);
  const records: Array<{ line: string; clipped: boolean }> = [];
  await Effect.runPromise(
    streamLines({
      binary: "rg",
      args: ["--no-config", "--json", "--regexp", "needle", "--", "wide.txt"],
      cwd: root,
      maxRecordBytes: 64,
      onLine: (line, clipped) => {
        records.push({ line, clipped });
        return true;
      },
    }),
  );

  const cut = records.filter((record) => record.clipped);
  const match = cut.find((record) => record.line.startsWith('{"type":"match"'));
  assert.ok(match !== undefined, "the match record must arrive cut");
  assert.equal(match.line.length, 64);
  for (const record of records) assert.ok(record.line.length <= 64);
});

test("grep drops an over-long record and says so", { skip: !hasRg }, async () => {
  // Explicit files bypass --max-filesize, so the record cap is the only bound.
  writeFileSync(path.join(root, "huge.txt"), `needle ${"x".repeat(9 * 1024 * 1024)}\n`);
  const outcome = await grep({ pattern: "needle", path: "huge.txt" });
  assert.deepEqual(outcome.matches, []);
  assert.equal(outcome.skippedRecords, 1);
  assert.equal(outcome.timedOut, false);
  rmSync(path.join(root, "huge.txt"));
});

test("find uses one glob under one directory", { skip: !hasFd }, async () => {
  const outcome = await find({ pattern: "*.ts", path: "src" });
  assert.deepEqual([...outcome.files].sort(), ["src/deep/test.ts", "src/main.ts"]);

  const fromCwd = await find({ pattern: "src/*.ts", path: "src" });
  assert.deepEqual(fromCwd.files, ["src/main.ts"]);

  const excluded = await find({ pattern: "!*.ts" });
  assert.equal(
    excluded.files.some((file) => file.endsWith(".ts")),
    false,
  );
  assert.ok(excluded.files.includes("src/other.js"));

  await assert.rejects(() => find({ pattern: "!" }), /cannot be empty/);
});

test("find skips hidden and ignored files unless a hidden directory is explicit", {
  skip: !hasFd,
}, async () => {
  const defaultSearch = await find({ pattern: "*.yml" });
  assert.deepEqual(defaultSearch.files, []);

  const explicit = await find({ pattern: "*.yml", path: ".github" });
  assert.deepEqual(explicit.files, [".github/workflows/publish.yml"]);

  const ignored = await find({ pattern: "ignored.ts" });
  assert.deepEqual(ignored.files, []);

  const hiddenTypeScript = await find({ pattern: "*.ts" });
  assert.equal(hiddenTypeScript.files.includes(".secret.ts"), false);
});

test("find stops after the fixed result limit and reports truncation", {
  skip: !hasFd,
}, async () => {
  const many = path.join(root, "many-files");
  mkdirSync(many);
  for (let index = 0; index < FIND_RESULT_LIMIT + 1; index++) {
    writeFileSync(path.join(many, `file-${String(index).padStart(3, "0")}.txt`), "");
  }
  const outcome = await find({ pattern: "*.txt", path: "many-files" });
  assert.equal(outcome.files.length, FIND_RESULT_LIMIT);
  assert.equal(outcome.truncated, true);
});

test("missing paths fail clearly and find requires a directory", async () => {
  if (hasRg) {
    await assert.rejects(
      () => grep({ pattern: "needle", path: "missing" }),
      /Search path does not exist: missing/,
    );
  }
  if (hasFd) {
    await assert.rejects(
      () => find({ pattern: "*.ts", path: "src/main.ts" }),
      /Find path is not a directory/,
    );
  }
});

test("searches are abortable", { skip: !hasRg }, async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => grep({ pattern: "needle", signal: controller.signal }),
    (error: Error) => error.name === "AbortError",
  );
});

test("engine arguments contain only the fixed simple behavior", () => {
  const rg = buildRgArgs({ pattern: "needle", path: "src", glob: "*.ts", cwd: root }, root);
  assert.ok(rg.includes("--json"));
  assert.ok(rg.includes("--regexp"));
  // Simple basename prefilters avoid scanning unrelated file contents.
  assert.ok(rg.includes("--type-add"));
  assert.ok(rg.includes("pifind:*.ts"));
  assert.ok(rg.includes("--max-filesize"));
  assert.ok(rg.includes("4M"));
  assert.ok(!rg.includes("--hidden"));
  assert.ok(!rg.includes("--smart-case"));
  assert.ok(!rg.includes("--fixed-strings"));
  assert.ok(!rg.includes("--context"));
  assert.ok(rg.includes("!.*"));

  const fd = buildFdArgs({ pattern: "*.ts", path: "src", cwd: root }, root);
  assert.ok(fd.includes("--glob"));
  assert.ok(fd.includes("*.ts"));
  assert.ok(fd.includes("--print0"));
  assert.ok(rg.includes("--no-config"));
  assert.ok(rg.includes("--case-sensitive"));
  assert.ok(!fd.includes("--hidden"));
});
