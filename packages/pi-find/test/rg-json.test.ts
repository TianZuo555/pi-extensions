import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeRgEvent } from "../lib/rg-json.ts";

function matchEvent(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "match",
    data: {
      path: { text: "src/a.ts" },
      lines: { text: "const x = 1;\n" },
      line_number: 7,
      submatches: [{ match: { text: "x" }, start: 6, end: 7 }],
      ...overrides,
    },
  });
}

test("decodes a match event", () => {
  const event = decodeRgEvent(matchEvent());
  assert.equal(event?.path, "src/a.ts");
  assert.equal(event?.lineNumber, 7);
  // The trailing newline rg includes must not reach the rendered line.
  assert.equal(event?.text, "const x = 1;");
});

test("ignores context events", () => {
  const line = JSON.stringify({
    type: "context",
    data: {
      path: { text: "src/a.ts" },
      lines: { text: "// before\n" },
      line_number: 6,
    },
  });
  assert.equal(decodeRgEvent(line), undefined);
});

test("ignores begin, end, and summary events", () => {
  for (const type of ["begin", "end", "summary"]) {
    const line = JSON.stringify({ type, data: { path: { text: "a.ts" } } });
    assert.equal(decodeRgEvent(line), undefined);
  }
});

test("ignores blank and malformed lines", () => {
  // One bad record must not abort an otherwise good search.
  assert.equal(decodeRgEvent(""), undefined);
  assert.equal(decodeRgEvent("   "), undefined);
  assert.equal(decodeRgEvent("not json"), undefined);
  assert.equal(decodeRgEvent("{"), undefined);
});

test("ignores events missing a line number or path", () => {
  assert.equal(decodeRgEvent(matchEvent({ line_number: undefined })), undefined);
  assert.equal(decodeRgEvent(matchEvent({ path: { text: "" } })), undefined);
});

test("decodes base64 bytes for invalid UTF-8 payloads", () => {
  const line = JSON.stringify({
    type: "match",
    data: {
      path: { bytes: Buffer.from("src/b.ts").toString("base64") },
      lines: { bytes: Buffer.from("let y = 2;\n").toString("base64") },
      line_number: 3,
    },
  });
  const event = decodeRgEvent(line);
  assert.equal(event?.path, "src/b.ts");
  assert.equal(event?.text, "let y = 2;");
});

test("strips carriage returns from CRLF files", () => {
  const event = decodeRgEvent(matchEvent({ lines: { text: "const x = 1;\r\n" } }));
  assert.equal(event?.text, "const x = 1;");
});
