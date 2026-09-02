import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { OutputView, TerminalSnapshot } from "./src/domain.ts";
import {
  BASH_PARAMETER_DESCRIPTIONS,
  BASH_PROMPT_SNIPPET,
  BASH_TOOL_DESCRIPTION,
  buildBashProgress,
  buildBashResult,
  buildTerminalResultBatchMessage,
  buildTerminalResultMessage,
  deriveCommandTitle,
  MAX_COMPLETION_BATCH_CONTENT_BYTES,
  TERMINAL_LOG_READ_PROMPT_SNIPPET,
  TERMINAL_LOG_READ_TOOL_DESCRIPTION,
  truncateUtf8WithMarker,
} from "./src/prompt.ts";

test("bash metadata states the managed-shell contract concisely", () => {
  assert.match(BASH_TOOL_DESCRIPTION, /background terminal/);
  assert.match(BASH_TOOL_DESCRIPTION, /returns .*id/);
  assert.match(BASH_TOOL_DESCRIPTION, /fresh shell/);
  assert.match(BASH_TOOL_DESCRIPTION, /no interactive stdin/);
  assert.match(BASH_TOOL_DESCRIPTION, /working_dir/);
  // yield_time_ms waits, timeout kills: the pair models most often confuse.
  assert.match(BASH_TOOL_DESCRIPTION, /yield_time_ms sets the wait/);
  assert.match(BASH_TOOL_DESCRIPTION, /timeout kills the process tree/);
  assert.match(BASH_TOOL_DESCRIPTION, /do not poll/i);
  assert.match(BASH_PARAMETER_DESCRIPTIONS.command, /script/);
  assert.match(BASH_PARAMETER_DESCRIPTIONS.yieldTimeMs, /default 10000, clamped to 250-30000/);
  assert.match(BASH_PARAMETER_DESCRIPTIONS.timeout, /no default/i);
  assert.match(BASH_PARAMETER_DESCRIPTIONS.workingDir, /session cwd/);
  // The schema carries exclusiveMinimum/maximum for timeout, so prose must not
  // spend tokens repeating them.
  assert.doesNotMatch(BASH_PARAMETER_DESCRIPTIONS.timeout, /maximum/i);
  assert.ok(BASH_TOOL_DESCRIPTION.length <= 320);
  assert.ok(BASH_PROMPT_SNIPPET.length <= 50);
  assert.ok(TERMINAL_LOG_READ_TOOL_DESCRIPTION.length <= 120);
  assert.ok(TERMINAL_LOG_READ_PROMPT_SNIPPET.length <= 32);
});

test("default titles expose work after repeated setup prefixes", () => {
  const root = "/Users/example/a/very/long/pi-coding-agent/install/path";
  assert.equal(
    deriveCommandTitle(`D=${root}; grep -rn 'contextTokens' $D/docs/*.md | head -20`),
    "grep -rn 'contextTokens' $D/docs/*.md | head -20",
  );
  assert.equal(deriveCommandTitle(`cd ${root} && npm test`), "npm test");
  assert.equal(deriveCommandTitle("ignored", "Meaningful title"), "Meaningful title");

  const long = deriveCommandTitle(`printf '${"x".repeat(120)}'`);
  assert.equal(long.length, 80);
  assert.match(long, / … /);
});

function view(overrides: Partial<OutputView> = {}): OutputView {
  return {
    text: "",
    head: "",
    tail: "",
    totalBytes: 0,
    truncatedBytes: 0,
    archiveComplete: false,
    ...overrides,
  };
}

function snap(overrides: Partial<TerminalSnapshot> = {}): TerminalSnapshot {
  return {
    id: "bt-1",
    command: "sleep 999",
    title: "test",
    cwd: "/tmp",
    pid: 123,
    status: "done",
    createdAt: Date.now() - 5_000,
    settledAt: Date.now(),
    exitCode: 0,
    stdout: view(),
    stderr: view(),
    ...overrides,
  };
}

test("yielded result tells the model not to poll and points the user to /ps", () => {
  const text = buildBashResult(
    snap({
      status: "running",
      settledAt: undefined,
      exitCode: undefined,
      stdout: view({ text: "ready\n", head: "ready\n", totalBytes: 6 }),
    }),
  );
  assert.match(text, /still running as background terminal bt-1/);
  assert.match(text, /do not poll/);
  assert.match(text, /user can inspect or stop it with \/ps/);
  // pid and title arrive once, via the metadata line, not twice.
  assert.equal(text.match(/pid 123/g)?.length, 1);
  assert.match(text, /stdout:\nready/);
});

test("every settled result names the directory the command actually ran in", () => {
  // The common wrong-directory mistake is assuming a cwd that was never set, so
  // the session cwd is exactly the case that must not be silent.
  assert.match(
    buildBashResult(snap({ cwd: "/repo/packages/x" })),
    /Command finished in .* \(exit 0\) in \/repo\/packages\/x\./,
  );
  assert.match(buildBashResult(snap({ cwd: "/repo" })), /\(exit 0\) in \/repo\./);
  assert.match(
    buildBashResult(snap({ cwd: "/repo", status: "timed_out" })),
    /timed out after .* in \/repo\./,
  );
});

test("quick completion returns ordinary bash output without terminal identity", () => {
  const text = buildBashResult(
    snap({
      stdout: view({ text: "done\n", head: "done\n", totalBytes: 5 }),
    }),
  );
  assert.match(text, /Command finished in 5s \(exit 0\)/);
  assert.match(text, /stdout:\ndone/);
  assert.doesNotMatch(text, /bt-1|background terminal/);
  assert.ok(!text.includes("stderr:\n"), "empty stderr section omitted");
});

test("initial progress does not claim the command already yielded", () => {
  const text = buildBashProgress(
    snap({ status: "running", settledAt: undefined, exitCode: undefined }),
  );
  assert.match(text, /during the initial wait/);
  assert.match(text, /only if it outlives that wait/);
  assert.doesNotMatch(text, /background terminal bt-1/);
});

test("model-facing output uses an opaque archive reference without leaking paths", () => {
  const head = `startup\n${"h".repeat(20 * 1024)}`;
  const tail = `${"t".repeat(20 * 1024)}\nlatest failure`;
  const totalBytes = 5 * 1024 * 1024;
  const spillDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bt-prompt-"));
  const spillPath = path.join(spillDir, "stdout.log");
  fs.writeFileSync(spillPath, "complete capture");

  try {
    const text = buildBashResult(
      snap({
        status: "failed",
        exitCode: 1,
        stdout: view({
          text: `${head}\n... middle omitted ...\n${tail}`,
          head,
          tail,
          totalBytes,
          truncatedBytes: totalBytes - Buffer.byteLength(head) - Buffer.byteLength(tail),
          spillPath,
          archiveComplete: true,
        }),
      }),
    );

    assert.match(text, /startup/);
    assert.match(text, /latest failure/);
    assert.match(text, /omitted/);
    assert.match(text, /bounded head\+tail/);
    assert.match(text, /archive ref bt-1:stdout/);
    assert.match(text, /terminal_log_read/);
    assert.match(text, /complete: yes/);
    assert.match(text, /omitted bytes \d+-\d+/);
    assert.equal(text.includes(spillPath), false);
    assert.equal(text.includes("Full log:"), false);

    // Deferred snapshots can retain the old path after the manager prunes the
    // entry. A missing archive must not become a model-visible dangling ref.
    fs.rmSync(spillPath);
    const expired = buildBashResult(
      snap({
        status: "failed",
        exitCode: 1,
        stdout: view({
          text: `${head}\n... middle omitted ...\n${tail}`,
          head,
          tail,
          totalBytes,
          truncatedBytes: totalBytes - Buffer.byteLength(head) - Buffer.byteLength(tail),
          spillPath,
        }),
      }),
    );
    assert.doesNotMatch(expired, /archive ref/);
    assert.match(expired, /complete archive unavailable to the model/);
  } finally {
    fs.rmSync(spillDir, { recursive: true, force: true });
  }
});

test("archive completeness does not follow settlement status", () => {
  const text = buildTerminalResultMessage(
    snap({
      stdout: view({
        text: "head\n... middle omitted ...\ntail",
        head: "head",
        tail: "tail",
        totalBytes: 100,
        truncatedBytes: 90,
        spillPath: process.execPath,
        archiveComplete: false,
      }),
    }),
  );
  assert.match(text, /complete: no/);
});

test("line-bounded output does not duplicate overlapping head and tail", () => {
  const output = Array.from({ length: 41 }, (_, index) => `line-${index + 1}`).join("\n");
  const text = buildTerminalResultMessage(
    snap({
      stdout: view({
        text: output,
        head: output,
        totalBytes: Buffer.byteLength(output),
      }),
    }),
  );
  const lines = text.split("\n");
  for (let index = 1; index <= 41; index++) {
    assert.ok(
      lines.filter((line) => line === `line-${index}`).length <= 1,
      `line ${index} was duplicated`,
    );
  }
  assert.match(text, /omitted/);
});

test("byte-bounded output de-duplicates line-rounded windows", () => {
  const output = Array.from(
    { length: 5 },
    (_, index) => `line-${index + 1}:${"x".repeat(1_700)}`,
  ).join("\n");
  const text = buildTerminalResultMessage(
    snap({
      stdout: view({
        text: output,
        head: output,
        totalBytes: Buffer.byteLength(output),
      }),
    }),
  );
  const lines = text.split("\n");
  for (let index = 1; index <= 5; index++) {
    assert.ok(
      lines.filter((line) => line.startsWith(`line-${index}:`)).length <= 1,
      `line ${index} was duplicated`,
    );
  }
});

test("completion message reports kill vs exit", () => {
  const killed = buildTerminalResultMessage(
    snap({ status: "killed", exitCode: undefined, signal: "SIGTERM" }),
  );
  assert.match(killed, /was killed after/);

  const failed = buildTerminalResultMessage(
    snap({
      status: "failed",
      exitCode: 3,
      stderr: view({ text: "boom\n", head: "boom\n", totalBytes: 5 }),
    }),
  );
  assert.match(failed, /exited \(exit 3\)/);
  assert.match(failed, /stderr:\nboom/);

  const timedOut = buildTerminalResultMessage(
    snap({
      status: "timed_out",
      timeoutMs: 1_000,
      exitCode: undefined,
      signal: "SIGTERM",
    }),
  );
  assert.match(timedOut, /timed out after/);
});

test("an isolated completion keeps the existing message shape", () => {
  const terminal = snap();
  assert.equal(buildTerminalResultBatchMessage([terminal]), buildTerminalResultMessage(terminal));
});

test("the truncation marker stays inside an arbitrarily small UTF-8 budget", () => {
  const maximumBytes = 17;
  const truncated = truncateUtf8WithMarker("界".repeat(100), maximumBytes);

  assert.ok(Buffer.byteLength(truncated) <= maximumBytes);
  assert.doesNotMatch(truncated, /�/);
});

test("batched completions retain every terminal summary within one bounded message", () => {
  const output = "界".repeat(10_000);
  const terminals = Array.from({ length: 8 }, (_, index) =>
    snap({
      id: `bt-${index + 1}`,
      title: `batch command ${index + 1}`,
      stdout: view({
        text: output,
        head: output,
        totalBytes: Buffer.byteLength(output),
      }),
    }),
  );

  const message = buildTerminalResultBatchMessage(terminals);
  assert.ok(Buffer.byteLength(message) <= MAX_COMPLETION_BATCH_CONTENT_BYTES);
  assert.match(message, /^8 background terminals completed\./);
  for (const terminal of terminals) {
    assert.match(message, new RegExp(`Background terminal ${terminal.id} `));
  }
  assert.match(message, /output truncated; use \/ps for complete logs/);
});

test("failed and timed-out completions keep the diagnostic output budget", () => {
  const output = Array.from({ length: 1_000 }, (_, index) => `line-${index + 1}`).join("\n");
  const failed = buildTerminalResultMessage(
    snap({
      status: "failed",
      exitCode: 1,
      stdout: view({
        text: output,
        head: output,
        totalBytes: Buffer.byteLength(output),
      }),
    }),
  );
  const timedOut = buildTerminalResultMessage(
    snap({
      status: "timed_out",
      stdout: view({
        text: output,
        head: output,
        totalBytes: Buffer.byteLength(output),
      }),
    }),
  );
  const successful = buildTerminalResultMessage(
    snap({
      stdout: view({
        text: output,
        head: output,
        totalBytes: Buffer.byteLength(output),
      }),
    }),
  );

  assert.ok(failed.length > successful.length);
  assert.ok(timedOut.length > successful.length);
  assert.match(failed, /line-1/);
  assert.match(failed, /line-1000/);
  assert.match(timedOut, /line-1000/);
});

test("completion output is shorter than the initial bash result", () => {
  const output = Array.from({ length: 1_000 }, (_, index) => `line-${index + 1}`).join("\n");
  const terminal = snap({
    stdout: view({
      text: output,
      head: output,
      totalBytes: Buffer.byteLength(output),
    }),
  });

  const completion = buildTerminalResultMessage(terminal);
  const initial = buildBashResult(terminal);

  assert.ok(completion.length < initial.length);
  assert.match(completion, /line-1/);
  assert.match(completion, /line-1000/);
  assert.match(completion, /bounded head\+tail/);
});
