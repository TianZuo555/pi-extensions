import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GREP_FILE_LIMIT, GREP_RESULT_LIMIT } from "../lib/prompt.ts";
import { decodeRgEvent } from "../lib/rg-json.ts";
import { resolveBinary } from "../src/binaries.ts";
import {
  buildRgArgs,
  clipLine,
  createSearchRuntime,
  finalizeGrep,
  runSearch,
  SearchRuntime,
  type GrepOutcome,
  type GrepRequest,
  type SearchRuntimeShape,
} from "../src/runtime.ts";

const hasRg = resolveBinary("rg") !== null;
const hasFd = resolveBinary("fd") !== null;

async function fixture(run: (cwd: string, search: SearchRuntimeShape) => Promise<void>) {
  const cwd = mkdtempSync(join(tmpdir(), "pi-find-output-"));
  const runtime = createSearchRuntime();
  const service = runtime.runSync(SearchRuntime);
  try {
    await run(cwd, service);
  } finally {
    await runtime.dispose();
    rmSync(cwd, { recursive: true, force: true });
  }
}

// Use the same Effect exit-to-error conversion as the registered tools.
async function grep(cwd: string, request: Omit<GrepRequest, "cwd">) {
  const runtime = createSearchRuntime();
  try {
    return await runSearch(runtime, runtime.runSync(SearchRuntime).grep({ cwd, ...request }));
  } finally {
    await runtime.dispose();
  }
}

test("auto context keeps ±5 lines for 1–3 matches and disappears for four", {
  skip: !hasRg,
}, async () => {
  await fixture(async (cwd) => {
    for (const count of [1, 2, 3, 4]) {
      const hitLines = Array.from({ length: count }, (_, i) => i * 20 + 11);
      writeFileSync(
        join(cwd, "a.txt"),
        Array.from({ length: 80 }, (_, i) =>
          hitLines.includes(i + 1) ? "needle" : `line ${i + 1}`,
        ).join("\n"),
      );
      const outcome = await grep(cwd, { pattern: "needle" });
      assert.equal(outcome.matches.length, count);
      assert.equal(outcome.context.length, count <= 3 ? count * 10 : 0);
      if (count <= 3)
        assert.deepEqual(
          outcome.context.slice(0, 10).map((row) => row.lineNumber),
          [6, 7, 8, 9, 10, 12, 13, 14, 15, 16],
        );
    }
  });
});

test("auto context never enriches incomplete searches and excludes orphan windows", () => {
  const base: GrepOutcome = {
    output: "content",
    files: ["a"],
    matches: [{ path: "a", lineNumber: 10, text: "needle" }],
    context: [
      { path: "a", lineNumber: 9, text: "before" },
      { path: "a", lineNumber: 100, text: "orphan window" },
      { path: "b", lineNumber: 9, text: "orphan file" },
    ],
    truncated: false,
    timedOut: false,
    skippedRecords: 0,
  };
  assert.deepEqual(finalizeGrep(base).context, [base.context[0]]);
  for (const flags of [
    { truncated: true },
    { timedOut: true },
    { skippedRecords: 1 },
    { matches: [] },
    { output: "files" as const },
  ]) {
    assert.deepEqual(finalizeGrep({ ...base, ...flags }).context, []);
  }
});

test("files mode uses NUL-delimited rg -l and bypasses the line limit", {
  skip: !hasRg,
}, async () => {
  await fixture(async (cwd) => {
    writeFileSync(join(cwd, "a.txt"), "needle\n".repeat(500));
    writeFileSync(join(cwd, "b.txt"), "needle\n");
    const args = buildRgArgs({ cwd, pattern: "needle", output: "files", literal: true }, cwd);
    assert.ok(args.includes("--files-with-matches"));
    assert.ok(args.includes("--null"));
    assert.ok(args.includes("--fixed-strings"));
    assert.ok(!args.includes("--json"));
    assert.ok(!args.includes("--context"));
    const outcome = await grep(cwd, { pattern: "needle", output: "files" });
    assert.deepEqual(outcome.files, ["a.txt", "b.txt"]);
    assert.deepEqual(outcome.matches, []);
    assert.deepEqual(outcome.context, []);
    assert.equal(outcome.truncated, false);
  });
});

test("files mode preserves unusual paths and never overrides ignores with a glob", {
  skip: !hasRg,
}, async () => {
  await fixture(async (cwd) => {
    const filename = process.platform === "win32" ? "space name.txt" : "line\nbreak.txt";
    writeFileSync(join(cwd, filename), "needle\n");
    writeFileSync(join(cwd, ".gitignore"), "ignored.txt\n");
    writeFileSync(join(cwd, "ignored.txt"), "needle\n");
    writeFileSync(join(cwd, ".hidden.txt"), "needle\n");
    const result = await grep(cwd, { pattern: "needle", glob: "*.txt", output: "files" });
    assert.deepEqual(result.files, [filename]);
  });
});

test("exact limits are complete; one extra record marks the appropriate mode partial", {
  skip: !hasRg,
}, async () => {
  await fixture(async (cwd) => {
    writeFileSync(join(cwd, "lines.txt"), "needle\n".repeat(GREP_RESULT_LIMIT));
    let result = await grep(cwd, { pattern: "needle", path: "lines.txt" });
    assert.equal(result.truncated, false);
    writeFileSync(join(cwd, "lines.txt"), "needle\n".repeat(GREP_RESULT_LIMIT + 1));
    result = await grep(cwd, { pattern: "needle", path: "lines.txt" });
    assert.equal(result.matches.length, GREP_RESULT_LIMIT);
    assert.equal(result.truncated, true);
    assert.deepEqual(result.context, []);
    mkdirSync(join(cwd, "files"));
    for (let i = 0; i <= GREP_FILE_LIMIT; i++) {
      if (i === GREP_FILE_LIMIT) {
        assert.equal(
          (await grep(cwd, { pattern: "needle", path: "files", output: "files" })).truncated,
          false,
        );
      }
      writeFileSync(join(cwd, "files", `${i}.txt`), "needle\n");
    }
    const files = await grep(cwd, { pattern: "needle", path: "files", output: "files" });
    assert.equal(files.files.length, GREP_FILE_LIMIT);
    assert.equal(files.truncated, true);
  });
});

test("literal search treats metacharacters, spaces, and option-like patterns as data", {
  skip: !hasRg,
}, async () => {
  await fixture(async (cwd) => {
    writeFileSync(join(cwd, "a.txt"), "call(\n--version\n x.y \nXay\n");
    for (const pattern of ["call(", "--version", " x.y "]) {
      const result = await grep(cwd, { pattern, literal: true });
      assert.equal(result.matches.length, 1);
      assert.equal(result.matches[0]?.text, pattern);
    }
    assert.equal((await grep(cwd, { pattern: "CALL(", literal: true })).matches.length, 0);
    await assert.rejects(() => grep(cwd, { pattern: "call(" }), /regex parse error/);
  });
});

test("long-line previews keep late matches visible with Unicode byte offsets", {
  skip: !hasRg,
}, async () => {
  await fixture(async (cwd) => {
    for (const prefix of ["x".repeat(600), "中文😀".repeat(200)]) {
      writeFileSync(join(cwd, "a.txt"), `${prefix}TARGET${"tail".repeat(200)}\n`);
      const result = await grep(cwd, { pattern: "TARGET" });
      assert.match(result.matches[0]!.text, /TARGET/);
      assert.ok(result.matches[0]!.text.startsWith("… "));
      assert.equal(Buffer.from(result.matches[0]!.text).toString("utf8"), result.matches[0]!.text);
      assert.ok(result.matches[0]!.text.length < 450);
    }
  });
});

test("decoder converts byte offsets after invalid UTF-8 and stripped CRs", () => {
  const prefix = Buffer.concat([Buffer.from("中😀\r"), Buffer.from([0xff])]);
  const bytes = Buffer.concat([prefix, Buffer.from("TARGET\n")]);
  const event = decodeRgEvent(
    JSON.stringify({
      type: "match",
      data: {
        path: { text: "a" },
        line_number: 1,
        lines: { bytes: bytes.toString("base64") },
        submatches: [{ start: prefix.length, end: prefix.length + 6 }],
      },
    }),
  )!;
  assert.equal(event.text.slice(event.matchStart, event.matchEnd), "TARGET");
  const text = `${"😀".repeat(401)}TARGET`;
  assert.equal(Buffer.from(clipLine(text, 802, 808)).toString("utf8"), clipLine(text, 802, 808));
  assert.match(clipLine(text, 802, 808), /TARGET/);
});

test("slash globs have exactly one root, including negation and explicit grep files", {
  skip: !hasRg || !hasFd,
}, async () => {
  await fixture(async (cwd, service) => {
    mkdirSync(join(cwd, "src", "src"), { recursive: true });
    writeFileSync(join(cwd, "src", "a.ts"), "needle\n");
    writeFileSync(join(cwd, "src", "src", "b.ts"), "needle\n");
    const runtime = createSearchRuntime();
    try {
      for (const pattern of ["src/*.ts", "!src/*.ts"]) {
        const expected = pattern.startsWith("!") ? ["src/a.ts"] : ["src/src/b.ts"];
        assert.deepEqual(
          (await runSearch(runtime, service.find({ cwd, pattern, path: "src" }))).files,
          expected,
        );
        for (const output of ["content", "files"] as const) {
          assert.deepEqual(
            (await grep(cwd, { pattern: "needle", glob: pattern, path: "src", output })).files,
            expected,
          );
        }
      }
      assert.equal(
        (await grep(cwd, { pattern: "needle", path: "src/a.ts", glob: "src/*.ts" })).matches.length,
        0,
      );
      assert.equal(
        (await grep(cwd, { pattern: "needle", path: "src/a.ts", glob: "*.ts" })).matches.length,
        1,
      );
    } finally {
      await runtime.dispose();
    }
  });
});
