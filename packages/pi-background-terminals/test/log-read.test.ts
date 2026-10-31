import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { readLogHeadTail, readLogPage } from "../src/log-read.ts";

function withTempFile(content: Buffer | string, run: (filePath: string) => Promise<void> | void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bt-log-read-"));
  const filePath = path.join(dir, "stream.log");
  fs.writeFileSync(filePath, content);
  return Promise.resolve()
    .then(() => run(filePath))
    .finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

test("head_tail splits the budget evenly and marks the omission", async () => {
  const head = "H".repeat(4_000);
  const middle = "M".repeat(100_000);
  const tail = "T".repeat(4_000);
  await withTempFile(head + middle + tail, async (file) => {
    const limit = 10_000;
    const result = readLogHeadTail(file, limit);
    assert.equal(result.mode, "head_tail");
    assert.equal(result.offset, 0);
    assert.equal(result.nextOffset, result.size);
    // Equal halves, unlike auto's one-quarter startup head.
    assert.equal(result.text.split("\n\n[... ")[0], (head + middle).slice(0, 5_000));
    assert.ok(result.text.endsWith(tail.slice(-5_000)), "keeps the last half");
    // 98_000 bytes dropped: the log minus the two 5_000-byte halves.
    assert.equal(result.omittedEnd! - result.omittedStart!, 98_000);
    // The marker names exactly the bytes that were dropped.
    assert.ok(
      result.text.includes(`[... ${result.omittedEnd! - result.omittedStart!} bytes omitted ...]`),
    );
  });
});

test("head_tail returns the whole log when it fits, with no marker", async () => {
  await withTempFile("short\n", async (file) => {
    const result = readLogHeadTail(file, 1_024);
    assert.equal(result.text, "short\n");
    assert.equal(result.omittedStart, undefined);
  });
});

test("head_tail never splits a code point at either cut", async () => {
  const content = "界".repeat(2_000) + "🚀".repeat(500);
  await withTempFile(content, async (file) => {
    const result = readLogHeadTail(file, 1_000);
    assert.equal(result.text.includes("\ufffd"), false);
    assert.ok(result.omittedEnd! > result.omittedStart!);
  });
});

test("page still returns an exact snapped window", async () => {
  const content = "行".repeat(300);
  await withTempFile(content, async (file) => {
    const result = readLogPage(file, 10, 100);
    const fileBytes = fs.readFileSync(file);
    assert.equal(result.mode, "page");
    assert.equal(
      result.text,
      fileBytes.subarray(result.offset, result.nextOffset).toString("utf8"),
    );
    assert.equal(result.text.includes("\ufffd"), false);
  });
});

test("page expands to a whole code point when the limit is smaller", async () => {
  await withTempFile("🚀x", async (file) => {
    const first = readLogPage(file, 0, 1);
    assert.equal(first.text, "🚀");
    assert.equal(first.nextOffset, 4);
    const second = readLogPage(file, 4, 1);
    assert.equal(second.text, "x");
    assert.equal(second.nextOffset, 5);
  });
});

test("tiny-limit pages stitch back to the exact string", async () => {
  const content = "a🚀é中b";
  const total = Buffer.byteLength(content);
  await withTempFile(content, async (file) => {
    for (const limit of [1, 2, 3]) {
      let offset = 0;
      let stitched = "";
      while (offset < total) {
        const page = readLogPage(file, offset, limit);
        stitched += page.text;
        assert.ok(page.nextOffset > offset, `page at ${offset} must advance`);
        assert.equal(page.text.includes("\ufffd"), false);
        offset = page.nextOffset;
      }
      assert.equal(stitched, content, `limit ${limit}`);
    }
  });
});

test("head+tail windows never emit U+FFFD when limit is below one code point", async () => {
  // A small budget is reachable when stdout used most of the Code Mode
  // budget, and a multi-byte first character is then the normal case. A head window that cannot hold one
  // code point must expand to it rather than decode a partial sequence.
  await withTempFile("🚀🚀", async (file) => {
    for (const limit of [1, 2, 3]) {
      const headTail = readLogHeadTail(file, limit);
      assert.equal(headTail.text.includes("\ufffd"), false, `head_tail limit ${limit}`);
      assert.ok(headTail.text.startsWith("🚀"), `head_tail limit ${limit} keeps the first char`);
    }
  });
});

test("head+tail windows never emit U+FFFD at the tail edge", async () => {
  await withTempFile("x".repeat(50) + "🚀".repeat(50), async (file) => {
    for (const limit of [4, 5, 6, 9]) {
      assert.equal(readLogHeadTail(file, limit).text.includes("\ufffd"), false, `limit ${limit}`);
    }
  });
});
