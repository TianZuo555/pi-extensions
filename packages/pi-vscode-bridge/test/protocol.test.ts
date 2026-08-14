import assert from "node:assert/strict";
import test from "node:test";
import {
  createFrameSplitter,
  encodeFrame,
  formatRef,
  isPathInside,
  joinRefs,
} from "../lib/protocol.ts";

test("createFrameSplitter returns two complete frames from one chunk", () => {
  const split = createFrameSplitter();
  const chunk =
    encodeFrame({ type: "prefill", text: "a" }) + encodeFrame({ type: "prefill", text: "b" });
  const lines = split(chunk);
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0]!), { type: "prefill", text: "a" });
  assert.deepEqual(JSON.parse(lines[1]!), { type: "prefill", text: "b" });
});

test("createFrameSplitter buffers partial frames across chunks", () => {
  const split = createFrameSplitter();
  const frame = encodeFrame({ type: "welcome", protocol: 1, workspaceFolders: [] });
  const part1 = frame.slice(0, 10);
  const part2 = frame.slice(10);
  assert.deepEqual(split(part1), []);
  const lines = split(part2);
  assert.equal(lines.length, 1);
  assert.equal(lines[0], frame.trimEnd());
});

test("createFrameSplitter strips trailing carriage returns", () => {
  const split = createFrameSplitter();
  const lines = split('{"type":"prefill","text":"x"}\r\n');
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]!), { type: "prefill", text: "x" });
});

test("createFrameSplitter preserves U+2028 inside JSON strings", () => {
  const split = createFrameSplitter();
  const payload = { type: "prefill", text: "line\u2028break" };
  const frame = encodeFrame(payload);
  const lines = split(frame);
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]!), payload);
});

test("createFrameSplitter ignores blank lines", () => {
  const split = createFrameSplitter();
  const lines = split("\n\n" + encodeFrame({ type: "bye", reason: "shutdown" }) + "\n");
  assert.equal(lines.length, 1);
});

test("encodeFrame ends with exactly one newline and round-trips", () => {
  const message = { type: "hello", protocol: 1 };
  const frame = encodeFrame(message);
  assert.match(frame, /\n$/);
  assert.equal(frame.split("\n").length - 1, 1);
  assert.deepEqual(JSON.parse(frame.trimEnd()), message);
});

test("formatRef handles no lines, equal lines, and ranges", () => {
  assert.equal(formatRef("a.ts"), "a.ts");
  assert.equal(formatRef("a.ts", 42, 42), "a.ts:42");
  assert.equal(formatRef("a.ts", 12, 40), "a.ts:12-40");
  assert.equal(formatRef("a.ts", 5), "a.ts:5");
});

test("joinRefs joins with spaces and trailing space", () => {
  assert.equal(joinRefs(["a", "b"]), "a b ");
});

test("isPathInside rejects non-string input without throwing", () => {
  assert.equal(isPathInside("/a/b", undefined as unknown as string), false);
  assert.equal(isPathInside(undefined as unknown as string, "/a/b"), false);
  assert.equal(isPathInside(null as unknown as string, "/a/b"), false);
  assert.equal(isPathInside("/a/b", null as unknown as string), false);
});

test("isPathInside compares normalized segments", () => {
  assert.equal(isPathInside("/a", "/a/b"), true);
  assert.equal(isPathInside("/a/b", "/a/b"), true);
  assert.equal(isPathInside("/a/b", "/a/bc"), false);
  assert.equal(isPathInside("/a/b", "/a"), false);
  assert.equal(isPathInside("/a/", "/a/b/"), true);
});
