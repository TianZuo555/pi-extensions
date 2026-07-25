import assert from "node:assert/strict";
import test from "node:test";
import { OutputBuffer } from "./src/output.ts";

test("push/view roundtrip preserves complete text and counts bytes", () => {
  const buf = new OutputBuffer(1024);
  buf.push("hello ");
  buf.push("world\n");
  const view = buf.view();
  assert.equal(view.text, "hello world\n");
  assert.equal(view.head, "hello world\n");
  assert.equal(view.tail, "");
  assert.equal(view.totalBytes, Buffer.byteLength("hello world\n"));
  assert.equal(view.truncatedBytes, 0);
});

test("retention preserves a stable head and rolling tail", () => {
  const buf = new OutputBuffer(10, undefined, 4);
  buf.push("aaaa");
  buf.push("bbbb");
  buf.push("cccc");

  const view = buf.view();
  assert.equal(view.head, "aaaa");
  assert.equal(view.tail, "bbcccc");
  assert.equal(view.text, "aaaa\n... 2 bytes omitted ...\nbbcccc");
  assert.equal(view.totalBytes, 12);
  assert.equal(view.truncatedBytes, 2);
});

test("later output never replaces the stable head", () => {
  const buf = new OutputBuffer(8, undefined, 2);
  buf.push("ab");
  buf.push("0123");
  buf.push("456789");

  const view = buf.view();
  assert.equal(view.head, "ab");
  assert.equal(view.tail, "456789");
  assert.equal(view.truncatedBytes, 4);
});

test("a single oversized chunk is split into head and tail within the cap", () => {
  const buf = new OutputBuffer(8, undefined, 2);
  buf.push("0123456789");

  const view = buf.view();
  assert.equal(view.head, "01");
  assert.equal(view.tail, "456789");
  assert.equal(view.totalBytes, 10);
  assert.equal(view.truncatedBytes, 2);
  assert.equal(view.text, "01\n... 2 bytes omitted ...\n456789");
});

test("UTF-8 boundaries are respected in both head and tail", () => {
  const buf = new OutputBuffer(9, undefined, 5);
  buf.push("ééééé"); // 10 bytes; neither 5-byte budget can hold half an é

  const view = buf.view();
  assert.equal(view.head, "éé");
  assert.equal(view.tail, "éé");
  assert.equal(view.totalBytes, 10);
  assert.equal(view.truncatedBytes, 2);
  assert.ok(!view.text.includes("�"));
});

test("rolling tail eviction lands on a UTF-8 boundary", () => {
  const buf = new OutputBuffer(8, undefined, 2);
  buf.push("ab");
  buf.push("ééé");
  buf.push("x");

  const view = buf.view();
  assert.equal(view.head, "ab");
  assert.equal(view.tail, "ééx");
  assert.equal(view.truncatedBytes, 2);
  assert.ok(!view.text.includes("�"));
});

test("spill receives the complete oversized chunk before retention", () => {
  const spilled: string[] = [];
  const buf = new OutputBuffer(4, (chunk) => spilled.push(chunk), 1);
  buf.push("0123456789");
  assert.deepEqual(spilled, ["0123456789"]);
  assert.equal(buf.view().totalBytes, 10);
  assert.equal(
    Buffer.byteLength(buf.view().head) + Buffer.byteLength(buf.view().tail),
    4,
  );
});

test("push reports spill backpressure while retaining the chunk", () => {
  const buf = new OutputBuffer(1024, () => false);
  assert.equal(buf.push("queued"), false);
  assert.equal(buf.view().text, "queued");
});

test("byte accounting uses UTF-8 byte length, not string length", () => {
  const buf = new OutputBuffer(1024);
  buf.push("héllo"); // é is 2 bytes
  assert.equal(buf.view().totalBytes, 6);
});

test("spill callback receives every chunk in order after middle omission", () => {
  const spilled: string[] = [];
  const buf = new OutputBuffer(6, (chunk) => spilled.push(chunk), 2);
  buf.push("aa");
  buf.push("bbbb");
  buf.push("cccc");
  assert.deepEqual(spilled, ["aa", "bbbb", "cccc"]);
  assert.equal(buf.view().head, "aa");
  assert.equal(buf.view().tail, "cccc");
});

test("view is cached between pushes and version increments per push", () => {
  const buf = new OutputBuffer(1024);
  buf.push("a");
  const first = buf.view();
  const second = buf.view();
  assert.equal(first, second);
  const versionBefore = buf.version;
  buf.push("b");
  assert.equal(buf.version, versionBefore + 1);
  assert.notEqual(buf.view(), first);
  assert.equal(buf.view().text, "ab");
});

test("changing the spill path invalidates the cached view", () => {
  const buf = new OutputBuffer(1024);
  buf.push("a");
  const before = buf.view();
  buf.spillPath = "/tmp/a.log";
  const after = buf.view();
  assert.notEqual(after, before);
  assert.equal(after.text, before.text);
  assert.equal(after.spillPath, "/tmp/a.log");
});

test("zero retention omits all bytes without growing memory", () => {
  const buf = new OutputBuffer(0);
  buf.push("abc");
  assert.deepEqual(buf.view(), {
    text: "... 3 bytes omitted ...",
    head: "",
    tail: "",
    totalBytes: 3,
    truncatedBytes: 3,
    spillPath: undefined,
  });
});
