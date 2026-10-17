import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  readLogAuto,
  readLogHeadTail,
  readLogPage,
  readLogTail,
  searchLogFile,
} from "../src/log-read.ts";

function withTempFile(content: Buffer | string, run: (filePath: string) => Promise<void> | void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bt-log-read-"));
  const filePath = path.join(dir, "stream.log");
  fs.writeFileSync(filePath, content);
  return Promise.resolve()
    .then(() => run(filePath))
    .finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

test("auto returns the whole log as a page when it fits the limit", async () => {
  await withTempFile("hello\nworld\n", async (file) => {
    const result = readLogAuto(file, 8 * 1024);
    assert.equal(result.mode, "page");
    assert.equal(result.text, "hello\nworld\n");
    assert.equal(result.offset, 0);
    assert.equal(result.nextOffset, result.size);
    assert.equal(result.omittedStart, undefined);
  });
});

test("auto on a large log returns head+tail within the limit and the exact omitted range", async () => {
  const head = "H".repeat(400);
  const middle = "M".repeat(5_000);
  const tail = "T".repeat(400);
  await withTempFile(head + middle + tail, async (file) => {
    const limit = 1_000;
    const result = readLogAuto(file, limit);
    assert.equal(result.mode, "head_tail");
    assert.equal(result.nextOffset, result.size);
    assert.equal(result.offset, 0);
    const marker = `\n[… bytes ${result.omittedStart}-${result.omittedEnd! - 1} omitted …]\n`;
    const [headPart, tailPart] = result.text.split(marker);
    assert.ok(headPart !== undefined && tailPart !== undefined, result.text.slice(0, 200));
    // Head is a prefix, tail is a suffix, and together they honor the budget.
    assert.ok((head + middle + tail).startsWith(headPart));
    assert.ok((head + middle + tail).endsWith(tailPart));
    assert.ok(
      Buffer.byteLength(headPart) + Buffer.byteLength(tailPart) <= limit,
      "returned windows fit the limit",
    );
    // The advertised omitted range sits exactly between the two shown windows.
    const fileBytes = fs.readFileSync(file);
    assert.equal(fileBytes.subarray(0, result.omittedStart).toString("utf8"), headPart);
    assert.equal(fileBytes.subarray(result.omittedEnd).toString("utf8"), tailPart);
    assert.equal(result.text.includes("\ufffd"), false);
  });
});

test("auto never emits U+FFFD at multi-byte cut points", async () => {
  const content = "界".repeat(2_000) + "🚀".repeat(500);
  await withTempFile(content, async (file) => {
    const result = readLogAuto(file, 1_000);
    assert.equal(result.mode, "head_tail");
    assert.equal(result.text.includes("\ufffd"), false);
    assert.ok(result.omittedEnd! > result.omittedStart!);
  });
});

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

test("tail returns the newest bytes, snapped, with nextOffset at end", async () => {
  const content = "a".repeat(500) + "界".repeat(500) + "z".repeat(500);
  await withTempFile(content, async (file) => {
    const result = readLogTail(file, 600);
    const fileBytes = fs.readFileSync(file);
    assert.equal(result.mode, "tail");
    assert.equal(result.nextOffset, result.size);
    assert.equal(
      fileBytes.subarray(result.offset).toString("utf8"),
      result.text,
      "returned text is an exact suffix",
    );
    assert.equal(result.text.includes("\ufffd"), false);
    assert.ok(result.bytesRead <= 600);
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

test("search is case-insensitive and match offsets point at line starts", async () => {
  const content = "first line\nSecond MATCH here\nthird\nmatch again\n";
  await withTempFile(content, async (file) => {
    const fileBytes = fs.readFileSync(file);
    const result = await searchLogFile(file, {
      pattern: /match/i,
      offset: 0,
      limit: 8 * 1024,
    });
    assert.equal(result.mode, "search");
    assert.equal(result.matchCount, 2);
    assert.equal(result.matches?.length, 2);
    for (const match of result.matches ?? []) {
      const at = fileBytes.subarray(match.offset, match.offset + 40).toString("utf8");
      assert.ok(at.startsWith(match.text.split(": ", 2)[1]), `offset ${match.offset}: ${at}`);
      // Offsets point at line starts: byte before is a newline or file start.
      assert.ok(match.offset === 0 || fileBytes[match.offset - 1] === 0x0a);
    }
    assert.match(result.text, /^@\d+: Second MATCH here\n@\d+: match again$/);
    assert.equal(result.pattern, "match");
    assert.equal(result.nextOffset, result.size);
  });
});

test("search strips a trailing CR from CRLF line endings", async () => {
  await withTempFile("hit one\r\nmiss\r\nhit two\r\n", async (file) => {
    const result = await searchLogFile(file, { pattern: /hit$/i, offset: 0, limit: 8 * 1024 });
    assert.equal(result.matchCount, 0, "the \\r must be stripped before matching");
    const clean = await searchLogFile(file, { pattern: /hit/i, offset: 0, limit: 8 * 1024 });
    assert.equal(clean.matchCount, 2);
    assert.doesNotMatch(clean.text, /\r/);
  });
});

test("search finds a match spanning a chunk boundary", async () => {
  const chunk = 64;
  const prefix = "x".repeat(chunk - 5);
  const content = `${prefix}\nneedle-spanning-chunk\n${"y".repeat(200)}\n`;
  await withTempFile(content, async (file) => {
    const result = await searchLogFile(file, {
      pattern: /needle/i,
      offset: 0,
      limit: 8 * 1024,
      chunkSizeBytes: chunk,
    });
    assert.equal(result.matchCount, 1);
    assert.match(result.text, /@\d+: needle-spanning-chunk/);
  });
});

test("search caps output at the limit contiguously and nextOffset continues", async () => {
  const content = Array.from({ length: 50 }, (_, i) => `hit-${i}\n`).join("");
  await withTempFile(content, async (file) => {
    const fileBytes = fs.readFileSync(file);
    const result = await searchLogFile(file, {
      pattern: /hit/i,
      offset: 0,
      limit: 40,
    });
    assert.equal(result.matchCount, 50);
    const shown = result.matches!;
    assert.ok(shown.length < 50);
    assert.ok(result.bytesRead <= 40);
    // Shown matches are always the contiguous first N.
    for (const [index, match] of shown.entries()) {
      assert.match(match.text, new RegExp(`: hit-${index}$`));
    }
    // nextOffset is the line start of match N+1; a second search resumes there.
    const resumeLine = `hit-${shown.length}\n`;
    const resumeOffset = fileBytes.indexOf(resumeLine);
    assert.equal(result.nextOffset, resumeOffset);
    const next = await searchLogFile(file, {
      pattern: /hit/i,
      offset: result.nextOffset,
      limit: 8 * 1024,
    });
    assert.match(next.text, new RegExp(`^@${resumeOffset}: hit-${shown.length}\n`));
    assert.equal(next.matchCount, 50 - shown.length);
    assert.equal(next.nextOffset, next.size);
  });
});

test("search honors a non-zero start offset", async () => {
  const content = "early hit\nsecond hit\n";
  await withTempFile(content, async (file) => {
    const start = content.indexOf("second");
    const result = await searchLogFile(file, {
      pattern: /hit/i,
      offset: start,
      limit: 8 * 1024,
    });
    assert.equal(result.matchCount, 1);
    assert.match(result.text, new RegExp(`^@${start}: second hit$`));
  });
});

test("search tests only the head of a runaway line", async () => {
  const longLine = `hit-${"x".repeat(10_000)}-tail-hit`;
  await withTempFile(`${longLine}\nnext hit\n`, async (file) => {
    const result = await searchLogFile(file, {
      pattern: /hit$/i,
      offset: 0,
      limit: 8 * 1024,
      maxLineBytes: 128,
    });
    // The long line ends in "hit" but only its first 128 bytes are tested;
    // the second line still matches on its own.
    assert.equal(result.matchCount, 1);
    assert.match(result.text, /next hit$/);
    const prefix = await searchLogFile(file, {
      pattern: /^hit/i,
      offset: 0,
      limit: 8 * 1024,
      maxLineBytes: 128,
    });
    // Only the capped line's prefix starts with "hit".
    assert.equal(prefix.matchCount, 1);
  });
});

test("search aborts the scan between chunks", async () => {
  const content = "x".repeat(64 * 1024);
  await withTempFile(content, async (file) => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      searchLogFile(file, {
        pattern: /never/i,
        offset: 0,
        limit: 8 * 1024,
        chunkSizeBytes: 1_024,
        signal: controller.signal,
      }),
    );
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

test("tail returns at least the last code point when the limit is smaller", async () => {
  await withTempFile("a🚀", async (file) => {
    const result = readLogTail(file, 1);
    assert.equal(result.text, "🚀");
    assert.equal(result.offset, 1);
    assert.equal(result.nextOffset, 5);
  });
});

test("search always advances when the first match exceeds the limit", async () => {
  const line = `ERROR ${"x".repeat(100)}`;
  const lineLen = Buffer.byteLength(line) + 1;
  await withTempFile(`${line}\n${line}\n${line}\n`, async (file) => {
    const result = await searchLogFile(file, { pattern: /error/i, offset: 0, limit: 10 });
    // Exactly the first match is shown, cut to the limit and ending in ….
    assert.equal(result.matches?.length, 1);
    const shown = result.matches![0];
    assert.equal(shown.offset, 0);
    assert.match(shown.text, /^@0: /);
    assert.ok(shown.text.endsWith("…"));
    assert.ok(Buffer.byteLength(shown.text) <= 10);
    assert.equal(result.matchCount, 3);
    // nextOffset is the SECOND line's start: a continuation resumes there.
    assert.equal(result.nextOffset, lineLen);
    // Continuing visits all three matches at strictly increasing offsets.
    const seen = [0];
    let offset = result.nextOffset;
    while (offset < result.size) {
      const next = await searchLogFile(file, { pattern: /error/i, offset, limit: 10 });
      for (const match of next.matches ?? []) seen.push(match.offset);
      assert.ok(next.nextOffset > offset, "each page must advance");
      offset = next.nextOffset;
    }
    assert.deepEqual(seen, [0, lineLen, lineLen * 2]);
  });
});

test("search still makes progress with a limit smaller than the match prefix", async () => {
  const line = `ERROR ${"x".repeat(50)}`;
  const lineLen = Buffer.byteLength(line) + 1;
  await withTempFile(`${line}\n${line}\n`, async (file) => {
    const result = await searchLogFile(file, { pattern: /error/i, offset: 0, limit: 1 });
    // Even the "@<offset>: " prefix + "…" exceeds the limit — it is emitted
    // anyway so the caller sees something and nextOffset advances.
    assert.equal(result.matches?.length, 1);
    assert.equal(result.matches![0].text, "@0: …");
    assert.equal(result.nextOffset, lineLen);
  });
});
