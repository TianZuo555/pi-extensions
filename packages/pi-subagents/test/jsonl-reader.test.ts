import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { describe, it } from "node:test";
import { attachJsonlReader } from "../lib/jsonl-reader.ts";

async function collectLines(chunks: Array<string | Buffer>): Promise<string[]> {
  const lines: string[] = [];
  const stream = new Readable({ read() {} });
  attachJsonlReader(stream, (line) => lines.push(line));
  await new Promise<void>((resolve) => {
    stream.on("end", () => resolve());
    for (const chunk of chunks) stream.push(chunk);
    stream.push(null);
  });
  return lines;
}

describe("attachJsonlReader", () => {
  it("splits on LF only", async () => {
    const lines = await collectLines(['{"a":1}\n{"b":2}\n']);
    assert.deepEqual(lines, ["{\"a\":1}", "{\"b\":2}"]);
  });

  it("strips trailing CR from CRLF", async () => {
    const lines = await collectLines(['{"a":1}\r\n']);
    assert.deepEqual(lines, ["{\"a\":1}"]);
  });

  it("does not split on U+2028 inside a line", async () => {
    const line = `{"text":"a\u2028b"}`;
    const lines = await collectLines([`${line}\n`]);
    assert.equal(lines.length, 1);
    assert.equal(lines[0], line);
  });

  it("handles split UTF-8 multibyte characters across chunks", async () => {
    const emoji = "😀";
    const payload = `{"text":"${emoji}"}`;
    const bytes = Buffer.from(`${payload}\n`, "utf8");
    const mid = Math.floor(bytes.length / 2);
    const lines = await collectLines([bytes.subarray(0, mid), bytes.subarray(mid)]);
    assert.deepEqual(lines, [payload]);
  });
});
