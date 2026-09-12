import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { formatDevinCall, sanitizeDevinText, summarizeDevinResult } from "../lib/render.ts";

/** Identity theme: keeps assertions focused on the text pipeline. */
const theme = { fg: (_color: string, text: string) => text } as unknown as Theme;
const ESC = "\u001b";

test("sanitizeDevinText strips terminal escapes and control characters", () => {
  assert.equal(sanitizeDevinText(`${ESC}[31mRED${ESC}[0m`), "RED");
  assert.equal(sanitizeDevinText("a\u0000b\u0007c\u007fd"), "abcd");
  assert.equal(sanitizeDevinText("keep\nnewlines\tand tabs"), "keep\nnewlines\tand tabs");
});

test("tool card text never carries terminal escapes", () => {
  // Live devin tool output contains raw ANSI (captured terminal output).
  const output = `${ESC}[0m[... 26450 lines omitted ...]\n${ESC}[32mdone${ESC}[0m`;
  assert.ok(!sanitizeDevinText(output).includes(ESC));
  const call = formatDevinCall({ title: `Ran ${ESC}[1mseq${ESC}[0m` }, theme);
  assert.ok(!call.includes(ESC), call);
  const result = summarizeDevinResult({ title: `Read ${ESC}[1mshell${ESC}[0m` });
  assert.ok(!result.headline.includes(ESC));
});
