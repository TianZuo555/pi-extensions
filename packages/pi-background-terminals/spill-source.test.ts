import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { createSpillSource } from "./src/ui/spill-source.ts";

const OPTIONS = { tailBytes: 1024, windowBytes: 4096, chunkBytes: 1024 };

async function spillFile(content: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bt-spill-test-"));
  const file = path.join(dir, "bt-1.stdout.log");
  await fs.writeFile(file, content);
  return file;
}

test("follow loads the tail window and then appends growth within the cap", async () => {
  const file = await spillFile("a".repeat(4096));
  let changes = 0;
  const source = createSpillSource(file, () => changes++, OPTIONS);

  assert.equal(await source.follow(), true);
  assert.equal(changes, 1);
  let state = source.state();
  assert.deepEqual(
    { start: state.start, end: state.end, size: state.size },
    { start: 3072, end: 4096, size: 4096 },
  );
  assert.equal(state.text, "a".repeat(1024));

  // Nothing new: no window change, no wasted re-wrap.
  assert.equal(await source.follow(), false);
  assert.equal(changes, 1);

  await fs.appendFile(file, "b".repeat(512));
  assert.equal(await source.follow(), true);
  state = source.state();
  assert.deepEqual(
    { start: state.start, end: state.end, size: state.size },
    { start: 3584, end: 4608, size: 4608 },
  );
  assert.equal(state.text, `${"a".repeat(512)}${"b".repeat(512)}`);

  // Falling far behind reloads the tail instead of blowing past the cap.
  await fs.appendFile(file, "c".repeat(8192));
  assert.equal(await source.follow(), true);
  state = source.state();
  assert.equal(state.end, 12800);
  assert.equal(state.start, 11776);
  assert.equal(state.text, "c".repeat(1024));

  source.dispose();
});

test("loadEarlier prepends chunks, then re-anchors exactly at the window cap", async () => {
  const file = await spillFile("a".repeat(16384));
  const source = createSpillSource(file, () => {}, OPTIONS);
  await source.follow();

  const loaded = () => {
    const state = source.state();
    return { start: state.start, end: state.end, bytes: state.end - state.start };
  };
  assert.deepEqual(loaded(), { start: 15360, end: 16384, bytes: 1024 });

  for (const expected of [2048, 3072, 4096]) {
    assert.equal(await source.loadEarlier(), "prepended");
    assert.equal(loaded().bytes, expected);
    // Growing backwards never moves the bottom of the window, so the viewer's
    // bottom-anchored scroll offset stays valid.
    assert.equal(loaded().end, 16384);
  }

  const capped = loaded();
  assert.equal(await source.loadEarlier(), "reanchored");
  const reanchored = loaded();
  assert.equal(reanchored.end, capped.start);
  assert.equal(reanchored.start, capped.start - 4096);

  source.dispose();
});

test("loadEarlier stops at byte zero and seekAfter pages forward from the window end", async () => {
  const file = await spillFile("a".repeat(3000));
  const source = createSpillSource(file, () => {}, OPTIONS);
  await source.follow();
  assert.equal(source.state().start, 1976);

  assert.equal(await source.loadEarlier(), "prepended");
  assert.equal(source.state().start, 952);
  assert.equal(await source.loadEarlier(), "prepended");
  assert.equal(source.state().start, 0);
  assert.equal(await source.loadEarlier(), "noop");
  assert.equal(source.state().end, 3000);

  // A window pinned to the beginning of a long file pages forward exactly
  // where it ended, so downward reading loses nothing.
  const long = await spillFile("a".repeat(10000));
  const forward = createSpillSource(long, () => {}, OPTIONS);
  await forward.follow();
  await forward.loadEarlier();
  await forward.loadEarlier();
  await forward.loadEarlier();
  await forward.loadEarlier(); // re-anchors backwards
  const before = forward.state();
  assert.ok(before.end < before.size);

  assert.equal(await forward.seekAfter(), true);
  const after = forward.state();
  assert.equal(after.start, before.end);
  assert.equal(after.end, Math.min(before.end + 4096, after.size));

  source.dispose();
  forward.dispose();
});

test("window boundaries never split a multi-byte code point", async () => {
  // 2-byte code points: every 1024-byte window boundary lands mid-character
  // unless it is snapped forward.
  const file = await spillFile("é".repeat(4000));
  const source = createSpillSource(file, () => {}, OPTIONS);

  await source.follow();
  let state = source.state();
  assert.ok(!state.text.includes("\uFFFD"));
  assert.equal(state.text, "é".repeat(state.text.length));
  assert.equal(state.start % 2, 0);

  await source.loadEarlier();
  state = source.state();
  assert.ok(!state.text.includes("\uFFFD"));
  assert.equal(state.text, "é".repeat(state.text.length));

  source.dispose();
});

test("an unreadable spill reports an error instead of throwing", async () => {
  const file = await spillFile("output");
  await fs.rm(file);
  let changes = 0;
  const source = createSpillSource(file, () => changes++, OPTIONS);

  assert.equal(await source.follow(), false);
  const state = source.state();
  assert.equal(state.text, "");
  assert.match(state.error ?? "", /ENOENT/);
  assert.equal(changes, 1);

  // A repeated failure is not a new window change.
  assert.equal(await source.follow(), false);
  assert.equal(changes, 1);

  source.dispose();
});

test("a disposed source stops reporting changes", async () => {
  const file = await spillFile("a".repeat(2048));
  let changes = 0;
  const source = createSpillSource(file, () => changes++, OPTIONS);
  source.dispose();

  assert.equal(await source.follow(), false);
  assert.equal(changes, 0);
  assert.equal(source.state().text, "");
});
