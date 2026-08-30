import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { AgyArtifact } from "../lib/artifacts.ts";
import { AgyArtifactsDashboard, readMarkdownPreview } from "../src/artifacts-ui.ts";

async function temporaryFile(
  name: string,
  content: string | Buffer,
): Promise<{ dir: string; file: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "agy-preview-"));
  const file = path.join(dir, name);
  await writeFile(file, content);
  return { dir, file };
}

test("readMarkdownPreview reports exact checklist counts for complete UTF-8", async () => {
  const { dir, file } = await temporaryFile(
    "plan.md",
    "# Plan\n- [x] one\n- [X] two\n- [ ] three\n",
  );
  try {
    const preview = await readMarkdownPreview(file);
    assert.equal(preview.truncated, false);
    assert.equal(preview.completed, 2);
    assert.equal(preview.total, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readMarkdownPreview bounds reads and rejects invalid UTF-8", async () => {
  const large = await temporaryFile("large.md", `- [x] one\n${"x".repeat(100)}`);
  const splitCodePoint = await temporaryFile("unicode.md", "a🙂b");
  const invalid = await temporaryFile("invalid.md", Buffer.from([0xc3, 0x28]));
  try {
    const preview = await readMarkdownPreview(large.file, 16);
    assert.equal(preview.truncated, true);
    assert.equal(preview.completed, 1);
    const unicode = await readMarkdownPreview(splitCodePoint.file, 3);
    assert.equal(unicode.truncated, true);
    assert.equal(unicode.text, "a");
    await assert.rejects(() => readMarkdownPreview(invalid.file), /encoded data|encoding/i);
  } finally {
    await rm(large.dir, { recursive: true, force: true });
    await rm(splitCodePoint.dir, { recursive: true, force: true });
    await rm(invalid.dir, { recursive: true, force: true });
  }
});

test("artifact dashboard list and markdown preview remain width-safe", async () => {
  const { dir, file } = await temporaryFile(
    "long-plan-name-that-needs-truncation.md",
    "# Unicode 計画\n\n- [x] completed item with a very long description\n- [ ] next\n\x1b[31mterminal color\x1b[0m\ttext\n",
  );
  const artifact: AgyArtifact = {
    name: path.basename(file),
    absolutePath: file,
    kind: "conversation",
    mediaType: "markdown",
    bytes: 100,
    modifiedMs: Date.now(),
  };
  let renders = 0;
  const tui = { terminal: { rows: 16 }, requestRender: () => renders++ } as any;
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as any;
  const keybindings = {
    getKeys: (binding: string) => [
      binding.includes("cancel") ? "esc" : binding.includes("confirm") ? "enter" : "↑",
    ],
    matches: (data: string, binding: string) =>
      (data === "enter" && binding === "tui.select.confirm") ||
      (data === "esc" && binding === "tui.select.cancel"),
  } as any;
  const dashboard = new AgyArtifactsDashboard(
    tui,
    theme,
    keybindings,
    { getArtifacts: () => [artifact], refresh: async () => {} },
    { index: 0 },
    () => {},
  );
  try {
    for (const width of [12, 24, 50]) {
      assert.ok(dashboard.render(width).every((line) => visibleWidth(line) <= width));
    }
    dashboard.handleInput("enter");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(renders > 0);
    for (const width of [12, 24, 50]) {
      const lines = dashboard.render(width);
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
      assert.ok(lines.every((line) => !line.includes("\x1b[31m")));
    }
    assert.ok(
      dashboard.render(50).some((line) => line.includes("checklist") || line.includes("preview")),
    );
    dashboard.handleInput("esc");
    assert.ok(dashboard.render(30).some((line) => line.includes("agy artifacts")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
