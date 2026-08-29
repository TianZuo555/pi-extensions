import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { TokensPanel } from "../lib/tokens-panel.ts";
import { scanLocalUsage, sessionFileStartMs, type ScanResult } from "../src/local-scan.ts";

const HOUR = 60 * 60 * 1000;

function sessionLine(id: string, tsMs: number, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "message",
    id,
    timestamp: new Date(tsMs).toISOString(),
    message: {
      role: "assistant",
      timestamp: tsMs,
      provider: "openai-codex",
      model: "gpt-5.6",
      usage: {
        input: 1000,
        output: 100,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 1100,
        cost: { total: 0.01 },
      },
      ...overrides,
    },
  });
}

function fixtureDir(files: Record<string, string[]>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tokens-test-"));
  for (const [dir, lines] of Object.entries(files)) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    fs.writeFileSync(path.join(root, dir, "session.jsonl"), `${lines.join("\n")}\n`);
  }
  return root;
}

test("scanLocalUsage aggregates, filters by sinceMs, and dedups by message id", async () => {
  const now = Date.now();
  const yesterday = now - 24 * HOUR;
  const root = fixtureDir({
    "--project-a--": [
      sessionLine("dup", yesterday),
      sessionLine("old", now - 40 * 24 * HOUR), // outside window
    ],
    "--project-b--": [
      sessionLine("dup", yesterday), // replayed copy — must be counted once
      sessionLine("unique", now - HOUR),
      '{"type":"message","id":"nouser","message":{"role":"user","content":[]}}', // no usage
      '{"type":"model_change","id":"mc","modelId":"x"}', // not a message
      '{"type":"message","id":"broken","timestamp":"2026-","message":{"usage":', // truncated mid-line — counted as parse error
    ],
  });

  const { Effect } = await import("effect");
  const scan = await Effect.runPromise(
    scanLocalUsage({ sessionsDir: root, sinceMs: now - 30 * 24 * HOUR }),
  );

  assert.equal(scan.records.length, 2); // dup (once) + unique
  assert.equal(scan.filesScanned, 2);
  assert.ok(scan.parseErrors >= 1, "broken json line is counted, not fatal");
  const ids = scan.records.map((record) => record.id).sort();
  assert.deepEqual(ids, ["dup", "unique"]);

  fs.rmSync(root, { recursive: true, force: true });
});

test("scanLocalUsage skips files started long before the window but keeps nonstandard names", async () => {
  const now = Date.now();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tokens-test-"));
  fs.mkdirSync(path.join(root, "--old--"), { recursive: true });
  fs.mkdirSync(path.join(root, "--repro--"), { recursive: true });
  const oldName = `2026-01-01T00-00-00-000Z_00000000-0000-0000-0000-000000000000.jsonl`;
  fs.writeFileSync(path.join(root, "--old--", oldName), `${sessionLine("x", now)}\n`);
  fs.writeFileSync(path.join(root, "--repro--", "repro.jsonl"), `${sessionLine("y", now)}\n`);

  const { Effect } = await import("effect");
  const scan = await Effect.runPromise(
    scanLocalUsage({ sessionsDir: root, sinceMs: now - 7 * 24 * HOUR }),
  );
  assert.equal(scan.filesScanned, 1); // dated file skipped, repro.jsonl always scanned
  assert.deepEqual(
    scan.records.map((record) => record.id),
    ["y"],
  );

  fs.rmSync(root, { recursive: true, force: true });
});

test("sessionFileStartMs parses pi session filenames", () => {
  const ms = sessionFileStartMs(
    "2026-08-11T07-15-43-671Z_019fefad-5bb7-712a-919a-a71d64ee97ce.jsonl",
  );
  assert.equal(ms, Date.UTC(2026, 7, 11, 7, 15, 43, 671));
  assert.equal(sessionFileStartMs("repro.jsonl"), undefined);
});

// --- panel -------------------------------------------------------------------

function panelHarness(snapshot: ScanResult) {
  const renders: number[] = [];
  let closed = false;
  const theme = {
    fg: (_name: string, text: string) => text,
    bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
  };
  const keybindings = {
    matches: (data: string, name: string) => name === "cancel" && data === "\x1b",
  };
  const panel = new TokensPanel({
    tui: { requestRender: () => {} },
    theme,
    keybindings,
    snapshot,
    refresh: async () => snapshot,
    done: () => {
      closed = true;
    },
  });
  return { panel, renders, theme, isClosed: () => closed };
}

async function scanLocalUsageFixture(): Promise<ScanResult> {
  const { Effect } = await import("effect");
  // Anchor today's records inside the current LOCAL day. Naive `now - 2h`
  // offsets cross midnight in early-morning CI runs (GitHub runners are
  // UTC), which silently drops records from the Today window.
  const now = new Date();
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const anchor = Math.min(now.getTime(), dayStart.getTime() + 12 * HOUR);
  const earlyToday = (minute: number, fallback: number) =>
    Math.max(dayStart.getTime() + minute * 60_000, anchor - fallback * 60_000);
  const root = fixtureDir({
    "--project--": [sessionLine("a", earlyToday(1, 10)), sessionLine("b", earlyToday(2, 5))],
  });
  const scan = await Effect.runPromise(
    scanLocalUsage({ sessionsDir: root, sinceMs: now.getTime() - 30 * 24 * HOUR }),
  );
  fs.rmSync(root, { recursive: true, force: true });
  return scan;
}

test("TokensPanel renders within width and navigates windows", async () => {
  const snapshot = await scanLocalUsageFixture();
  const { panel, isClosed } = panelHarness(snapshot);

  for (const width of [42, 60, 100]) {
    const lines = panel.render(width);
    assert.ok(lines.length > 8, `renders a full panel at width ${width}`);
    for (const line of lines) {
      assert.ok(
        visibleWidth(line) <= width,
        `width ${width}: visible ${visibleWidth(line)} > ${width}: ${JSON.stringify(line)}`,
      );
    }
  }

  // Default window is 7d; arrows move through all four windows. Both legacy
  // CSI and application-cursor-mode sequences must work (real terminal
  // regression: raw "\\x1b[D" comparisons miss the latter).
  const initial = panel.render(80).join("\n");
  assert.ok(initial.includes("Last 7 days"));
  panel.handleInput("\x1b[C");
  assert.ok(panel.render(80).join("\n").includes("Last 30 days"));
  panel.handleInput("\x1bOC"); // app-cursor right (kitty/Ghostty-style)
  assert.ok(panel.render(80).join("\n").includes("Month to date"));
  panel.handleInput("\x1bOD"); // app-cursor left
  assert.ok(panel.render(80).join("\n").includes("Last 30 days"));
  panel.handleInput("h"); // vim-style left
  assert.ok(panel.render(80).join("\n").includes("Last 7 days"));
  panel.handleInput("l"); // vim-style right
  assert.ok(panel.render(80).join("\n").includes("Last 30 days"));
  panel.handleInput("\x1b[D"); // legacy left
  assert.ok(panel.render(80).join("\n").includes("Last 7 days"));
  panel.handleInput("\x1b[C"); // 30d
  panel.handleInput("\x1b[C"); // mtd
  panel.handleInput("\x1b[C"); // 1d (wrapped)
  assert.ok(panel.render(80).join("\n").includes("Today"));
  panel.handleInput("\x1b[D"); // back to mtd
  assert.ok(panel.render(80).join("\n").includes("Month to date"));

  // Direct digit jump + metric toggle.
  panel.handleInput("1");
  assert.ok(panel.render(80).join("\n").includes("Today"));
  panel.handleInput("\t");
  assert.ok(panel.render(80).join("\n").includes("per hour, cost"));

  // Close keys.
  panel.handleInput("\x1b");
  assert.ok(isClosed());
});

test("TokensPanel shows today's records in the 1d window", async () => {
  const snapshot = await scanLocalUsageFixture();
  const { panel } = panelHarness(snapshot);
  panel.handleInput("1");
  const text = panel.render(80).join("\n");
  assert.ok(text.includes("2.2K tokens"), "today's two records sum up");
  assert.ok(text.includes("Today ("), "1d window labels today");
});

test("TokensPanel scrolls top models with up/down and j/k keys", async () => {
  const now = Date.now();
  const lines: string[] = [];
  for (let i = 1; i <= 8; i++) {
    lines.push(
      sessionLine(`msg-${i}`, now - 1000 * i, {
        provider: "p",
        model: `model-${String(i).padStart(2, "0")}`,
        usage: {
          input: (9 - i) * 1000,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: (9 - i) * 1000,
          cost: { total: 0.01 },
        },
      }),
    );
  }
  const root = fixtureDir({ "--models--": lines });
  const { Effect } = await import("effect");
  const snapshot = await Effect.runPromise(
    scanLocalUsage({ sessionsDir: root, sinceMs: now - 7 * 24 * HOUR }),
  );
  fs.rmSync(root, { recursive: true, force: true });

  const { panel } = panelHarness(snapshot);
  const initial = panel.render(80).join("\n");
  assert.ok(initial.includes("top models by tokens (1–5 of 8 · ↑/↓ scroll)"));
  assert.ok(initial.includes("1. p/model-01"));
  assert.ok(initial.includes("5. p/model-05"));
  assert.ok(!initial.includes("6. p/model-06"));

  // Scroll down with arrow down
  panel.handleInput("\x1b[B");
  const scrolledDown = panel.render(80).join("\n");
  assert.ok(scrolledDown.includes("top models by tokens (2–6 of 8 · ↑/↓ scroll)"));
  assert.ok(!scrolledDown.includes("1. p/model-01"));
  assert.ok(scrolledDown.includes("6. p/model-06"));

  // Scroll down with vim 'j'
  panel.handleInput("j");
  assert.ok(panel.render(80).join("\n").includes("top models by tokens (3–7 of 8 · ↑/↓ scroll)"));

  // Scroll up with vim 'k'
  panel.handleInput("k");
  assert.ok(panel.render(80).join("\n").includes("top models by tokens (2–6 of 8 · ↑/↓ scroll)"));

  // Scroll up with arrow up
  panel.handleInput("\x1b[A");
  assert.ok(panel.render(80).join("\n").includes("top models by tokens (1–5 of 8 · ↑/↓ scroll)"));
});
