import assert from "node:assert/strict";
import test from "node:test";
import type { OutputView, TerminalSnapshot } from "./src/domain.ts";
import {
  BASH_PARAMETER_DESCRIPTIONS,
  BASH_PROMPT_GUIDELINES,
  BASH_TOOL_DESCRIPTION,
  buildBashProgress,
  buildBashResult,
  buildTerminalResultMessage,
  deriveCommandTitle,
} from "./src/prompt.ts";

test("bash descriptions identify managed yielding, timeout, and no-stdin contracts", () => {
  assert.match(BASH_TOOL_DESCRIPTION, /keeps running as a background terminal, returns an id/);
  assert.match(BASH_TOOL_DESCRIPTION, /fresh, non-persistent shell/);
  assert.match(BASH_TOOL_DESCRIPTION, /no interactive stdin/);
  assert.match(BASH_TOOL_DESCRIPTION, /timeout kills the command/);
  assert.match(BASH_TOOL_DESCRIPTION, /do not poll/i);
  // The exploration budget is stated once, in the guidelines, where it also
  // carries the remediation. It must not creep back into the description.
  assert.doesNotMatch(BASH_TOOL_DESCRIPTION, /blocks after/);
  assert.match(BASH_PARAMETER_DESCRIPTIONS.command, /no interactive stdin/);
  assert.match(BASH_PARAMETER_DESCRIPTIONS.yieldTimeMs, /clamped to 250-30000 ms/);
  assert.match(BASH_PARAMETER_DESCRIPTIONS.timeout, /hard total runtime timeout/);
  assert.match(BASH_PARAMETER_DESCRIPTIONS.workingDir, /fresh shell/);
  assert.ok(
    BASH_PROMPT_GUIDELINES.some((guideline) => /non-persistent shell/.test(guideline)),
  );
  assert.ok(
    BASH_PROMPT_GUIDELINES.some((guideline) => /synthesize instead of recursively searching/.test(guideline)),
  );
  assert.ok(
    BASH_PROMPT_GUIDELINES.some((guideline) => /blocks after 8/.test(guideline)),
  );
});

test("default titles expose work after repeated setup prefixes", () => {
  const root = "/Users/example/a/very/long/pi-coding-agent/install/path";
  assert.equal(
    deriveCommandTitle(
      `D=${root}; grep -rn 'contextTokens' $D/docs/*.md | head -20`,
    ),
    "grep -rn 'contextTokens' $D/docs/*.md | head -20",
  );
  assert.equal(
    deriveCommandTitle(`cd ${root} && npm test`),
    "npm test",
  );
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
  assert.match(text, /stdout:\nready/);
});

test("every settled result names the directory the command actually ran in", () => {
  // The common wrong-directory mistake is assuming a cwd that was never set, so
  // the session cwd is exactly the case that must not be silent.
  assert.match(
    buildBashResult(snap({ cwd: "/repo/packages/x" })),
    /Command finished in .* \(exit 0\) in \/repo\/packages\/x\./,
  );
  assert.match(
    buildBashResult(snap({ cwd: "/repo" })),
    /\(exit 0\) in \/repo\./,
  );
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

test("model-facing output preserves bounded startup head and recent tail", () => {
  const head = `startup\n${"h".repeat(20 * 1024)}`;
  const tail = `${"t".repeat(20 * 1024)}\nlatest failure`;
  const totalBytes = 5 * 1024 * 1024;
  const text = buildBashResult(
    snap({
      status: "failed",
      exitCode: 1,
      stdout: view({
        text: `${head}\n... middle omitted ...\n${tail}`,
        head,
        tail,
        totalBytes,
        truncatedBytes:
          totalBytes - Buffer.byteLength(head) - Buffer.byteLength(tail),
        spillPath: "/tmp/bt-1.stdout.log",
      }),
    }),
  );

  assert.match(text, /startup/);
  assert.match(text, /latest failure/);
  assert.match(text, /omitted/);
  assert.match(text, /bounded head\+tail/);
  assert.match(text, /Full log: \/tmp\/bt-1\.stdout\.log/);
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

test("completion output is shorter than the initial bash result", () => {
  const output = Array.from(
    { length: 1_000 },
    (_, index) => `line-${index + 1}`,
  ).join("\n");
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
