import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { HerdrSubagentBackend } from "../lib/backend-herdr.ts";
import { resetHerdrCapabilityCache, setHerdrBinaryPathForTests } from "../lib/herdr/capability.ts";
import type { BackendRunInput } from "../lib/backend.ts";
import type { ProfileDefinition } from "../lib/domain.ts";
import { reportPathFor } from "../lib/report-file.ts";
import { finalizeWorktree } from "../lib/worktree.ts";
import { hermeticGitProcessEnv } from "./git-env.ts";

hermeticGitProcessEnv();

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "fake-herdr.mjs",
);

function fakeCliOptions(): { command: string; argsPrefix: string[] } {
  return { command: process.execPath, argsPrefix: [FIXTURE] };
}

function withEnv(
  overrides: Record<string, string | undefined>,
  fn: () => Promise<void>,
): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) {
    saved[key] = process.env[key];
    const value = overrides[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return fn().finally(() => {
    for (const key of Object.keys(overrides)) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function baseProfile(overrides: Partial<ProfileDefinition> = {}): ProfileDefinition {
  return {
    qualifiedId: "user/test",
    name: "test",
    source: "user",
    description: "test profile",
    tools: ["read"],
    systemPrompt: "You are a test agent.",
    workspace: "shared-readonly",
    timeoutMs: 60_000,
    maxTurns: 8,
    kind: "pi",
    backend: "herdr",
    agentArgs: [],
    ...overrides,
  };
}

function runInput(
  _artifactRoot: string,
  overrides: Partial<BackendRunInput> & { profile?: ProfileDefinition } = {},
): BackendRunInput {
  const controller = new AbortController();
  return {
    runId: "sa-herdr01",
    profile: overrides.profile ?? baseProfile(),
    cwd: process.cwd(),
    prompt: "ignored for herdr",
    task: overrides.task ?? "inspect the codebase",
    context: overrides.context,
    modelArg: overrides.modelArg ?? "openai/gpt-4",
    timeoutMs: overrides.timeoutMs ?? 5_000,
    signal: overrides.signal ?? controller.signal,
    ...overrides,
  };
}

function initGitRepo(dir: string): void {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  };
  // Hooks export GIT_DIR (and friends); without stripping them every git
  // call below would target the repository running the hook instead of this
  // fixture directory. See pi-commit's test/git-env.ts for the full story.
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_NAMESPACE",
  ] as const) {
    delete env[key];
  }
  execFileSync("git", ["init"], { cwd: dir, stdio: "pipe", env });
  execFileSync("git", ["config", "user.name", "pi-herdr test"], { cwd: dir, stdio: "pipe", env });
  execFileSync("git", ["config", "user.email", "pi-herdr-test@example.invalid"], {
    cwd: dir,
    stdio: "pipe",
    env,
  });
  fs.writeFileSync(path.join(dir, "README.md"), "init\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: dir, stdio: "pipe", env });
  execFileSync(
    "git",
    ["-c", "user.name=init", "-c", "user.email=init@local", "commit", "-m", "init"],
    { cwd: dir, stdio: "pipe", env },
  );
}

describe("HerdrSubagentBackend", () => {
  it("happy path uses a valid report file", async () => {
    const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-herdr-artifact-"));
    const reportPath = reportPathFor(artifactRoot, "sa-herdr01");
    try {
      await withEnv(
        {
          FAKE_HERDR_REPORT_PATH: reportPath,
          FAKE_HERDR_REPORT_MODE: "valid",
          FAKE_HERDR_AGENT_STATUS: "done",
        },
        async () => {
          const backend = new HerdrSubagentBackend(artifactRoot, fakeCliOptions());
          const output = await backend.run(runInput(artifactRoot));
          assert.equal(output.settled, true);
          assert.equal(output.usageAvailable, false);
          assert.equal(output.usage.cost, 0);
          assert.equal(output.terminalReportReceived, true);
          assert.equal(output.semanticReport?.kind, "structured");
          assert.equal(output.herdr?.paneId, "pane-split-1");
        },
      );
    } finally {
      fs.rmSync(artifactRoot, { recursive: true, force: true });
    }
  });

  it("falls back to transcript when the report file is missing", async () => {
    const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-herdr-artifact-"));
    try {
      await withEnv(
        {
          FAKE_HERDR_REPORT_MODE: "missing",
          FAKE_HERDR_TRANSCRIPT: "fallback transcript text",
        },
        async () => {
          const backend = new HerdrSubagentBackend(artifactRoot, fakeCliOptions());
          const output = await backend.run(runInput(artifactRoot));
          assert.equal(output.terminalReportReceived, false);
          assert.equal(output.semanticReport?.kind, "unstructured");
          if (output.semanticReport?.kind === "unstructured") {
            assert.match(output.semanticReport.text, /fallback transcript/);
          }
        },
      );
    } finally {
      fs.rmSync(artifactRoot, { recursive: true, force: true });
    }
  });

  it("falls back to transcript when the report file is invalid JSON", async () => {
    const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-herdr-artifact-"));
    const reportPath = reportPathFor(artifactRoot, "sa-herdr01");
    try {
      await withEnv(
        {
          FAKE_HERDR_REPORT_PATH: reportPath,
          FAKE_HERDR_REPORT_MODE: "invalid",
          FAKE_HERDR_TRANSCRIPT: "invalid json fallback",
        },
        async () => {
          const backend = new HerdrSubagentBackend(artifactRoot, fakeCliOptions());
          const output = await backend.run(runInput(artifactRoot));
          assert.equal(output.terminalReportReceived, false);
          assert.equal(output.semanticReport?.kind, "unstructured");
        },
      );
    } finally {
      fs.rmSync(artifactRoot, { recursive: true, force: true });
    }
  });

  it("falls back when the report file is oversized", async () => {
    const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-herdr-artifact-"));
    const reportPath = reportPathFor(artifactRoot, "sa-herdr01");
    try {
      await withEnv(
        {
          FAKE_HERDR_REPORT_PATH: reportPath,
          FAKE_HERDR_REPORT_MODE: "oversized",
          FAKE_HERDR_TRANSCRIPT: "oversized fallback",
        },
        async () => {
          const backend = new HerdrSubagentBackend(artifactRoot, fakeCliOptions());
          const output = await backend.run(runInput(artifactRoot));
          assert.equal(output.terminalReportReceived, false);
          const outcome = fs.existsSync(reportPath);
          assert.equal(outcome, true);
          assert.equal(output.semanticReport?.kind, "unstructured");
        },
      );
    } finally {
      fs.rmSync(artifactRoot, { recursive: true, force: true });
    }
  });

  it("always reports usageAvailable false with zeroed usage", async () => {
    const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-herdr-artifact-"));
    try {
      await withEnv({ FAKE_HERDR_REPORT_MODE: "missing" }, async () => {
        const backend = new HerdrSubagentBackend(artifactRoot, fakeCliOptions());
        const output = await backend.run(runInput(artifactRoot));
        assert.equal(output.usageAvailable, false);
        assert.deepEqual(output.usage, {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
          turns: 0,
        });
      });
    } finally {
      fs.rmSync(artifactRoot, { recursive: true, force: true });
    }
  });

  it("recovers from agent_prompt_stalled exactly once", async () => {
    const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-herdr-artifact-"));
    const counterFile = path.join(os.tmpdir(), `herdr-prompt-counter-${process.pid}`);
    const task = "unique staged task marker for recovery";
    try {
      await withEnv(
        {
          FAKE_HERDR_PROMPT_FAIL_COUNT: "1",
          FAKE_HERDR_PROMPT_COUNTER_FILE: counterFile,
          FAKE_HERDR_GET_STATUS: "idle",
          FAKE_HERDR_VISIBLE_TEXT: `${task} visible in terminal`,
          FAKE_HERDR_REPORT_MODE: "missing",
        },
        async () => {
          fs.writeFileSync(counterFile, "0", "utf8");
          const backend = new HerdrSubagentBackend(artifactRoot, fakeCliOptions());
          const output = await backend.run(runInput(artifactRoot, { task }));
          assert.equal(output.settled, true);
          assert.equal(fs.readFileSync(counterFile, "utf8"), "1");
        },
      );
    } finally {
      fs.rmSync(counterFile, { force: true });
      fs.rmSync(artifactRoot, { recursive: true, force: true });
    }
  });

  it("fails when agent_prompt_stalled recovery cannot proceed", async () => {
    const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-herdr-artifact-"));
    const counterFile = path.join(os.tmpdir(), `herdr-prompt-counter-fail-${process.pid}`);
    try {
      await withEnv(
        {
          FAKE_HERDR_PROMPT_FAIL_COUNT: "1",
          FAKE_HERDR_PROMPT_COUNTER_FILE: counterFile,
          FAKE_HERDR_GET_STATUS: "working",
          FAKE_HERDR_VISIBLE_TEXT: "not the staged prompt",
        },
        async () => {
          fs.writeFileSync(counterFile, "0", "utf8");
          const backend = new HerdrSubagentBackend(artifactRoot, fakeCliOptions());
          const output = await backend.run(runInput(artifactRoot, { task: "other task" }));
          assert.equal(output.settled, false);
          assert.match(output.error ?? "", /recovery failed/i);
        },
      );
    } finally {
      fs.rmSync(counterFile, { force: true });
      fs.rmSync(artifactRoot, { recursive: true, force: true });
    }
  });

  it("maps timeout to timed_out and sends esc", async () => {
    const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-herdr-artifact-"));
    const sendKeysLog = path.join(os.tmpdir(), `herdr-send-keys-${process.pid}`);
    try {
      await withEnv(
        {
          FAKE_HERDR_PROMPT_ERROR: "timeout",
          FAKE_HERDR_RECORD_SEND_KEYS: sendKeysLog,
        },
        async () => {
          const backend = new HerdrSubagentBackend(artifactRoot, fakeCliOptions());
          const output = await backend.run(runInput(artifactRoot));
          assert.equal(output.settled, false);
          assert.match(output.error ?? "", /timed out/i);
          assert.match(fs.readFileSync(sendKeysLog, "utf8"), /esc/);
        },
      );
    } finally {
      fs.rmSync(sendKeysLog, { force: true });
      fs.rmSync(artifactRoot, { recursive: true, force: true });
    }
  });

  it("fails on agent_pane_not_found without retry", async () => {
    const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-herdr-artifact-"));
    try {
      await withEnv({ FAKE_HERDR_PROMPT_ERROR: "agent_pane_not_found" }, async () => {
        const backend = new HerdrSubagentBackend(artifactRoot, fakeCliOptions());
        const output = await backend.run(runInput(artifactRoot));
        assert.equal(output.settled, false);
        assert.match(output.error ?? "", /agent_pane_not_found|fake prompt error/i);
      });
    } finally {
      fs.rmSync(artifactRoot, { recursive: true, force: true });
    }
  });

  it("rejects worktree profiles when cwd is not a git repository", async () => {
    const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-herdr-artifact-"));
    const nonRepo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-herdr-nonrepo-"));
    try {
      resetHerdrCapabilityCache();
      setHerdrBinaryPathForTests("/tmp/fake-herdr-for-test");
      await withEnv({ HERDR_ENV: "1" }, async () => {
        const backend = new HerdrSubagentBackend(artifactRoot, fakeCliOptions());
        const output = await backend.run(
          runInput(artifactRoot, {
            cwd: nonRepo,
            profile: baseProfile({
              workspace: "worktree",
              tools: ["write", "edit"],
              backend: "herdr",
            }),
          }),
        );
        assert.equal(output.settled, false);
        assert.match(output.error ?? "", /could not create Herdr worktree/i);
      });
    } finally {
      setHerdrBinaryPathForTests(undefined);
      resetHerdrCapabilityCache();
      fs.rmSync(nonRepo, { recursive: true, force: true });
      fs.rmSync(artifactRoot, { recursive: true, force: true });
    }
  });

  it("rejects an empty task before calling herdr", async () => {
    const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-herdr-artifact-"));
    const touchedFile = path.join(os.tmpdir(), `herdr-touched-empty-${process.pid}`);
    try {
      await withEnv({ FAKE_HERDR_TOUCHED: touchedFile }, async () => {
        const backend = new HerdrSubagentBackend(artifactRoot, fakeCliOptions());
        const output = await backend.run(
          runInput(artifactRoot, {
            profile: baseProfile({ systemPrompt: "   ", name: "empty" }),
            task: "   ",
          }),
        );
        assert.equal(output.settled, false);
        assert.match(output.error ?? "", /subagent task is empty/i);
        assert.equal(fs.existsSync(touchedFile), false);
      });
    } finally {
      fs.rmSync(touchedFile, { force: true });
      fs.rmSync(artifactRoot, { recursive: true, force: true });
    }
  });

  it("maps subprocess kill during long prompt wait to timed out", async () => {
    const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-herdr-artifact-"));
    const sendKeysLog = path.join(os.tmpdir(), `herdr-send-keys-subproc-${process.pid}`);
    try {
      await withEnv(
        {
          FAKE_HERDR_PROMPT_SLEEP_MS: "20000",
          FAKE_HERDR_RECORD_SEND_KEYS: sendKeysLog,
        },
        async () => {
          const backend = new HerdrSubagentBackend(artifactRoot, fakeCliOptions());
          const output = await backend.run(runInput(artifactRoot, { timeoutMs: 50 }));
          assert.equal(output.settled, false);
          assert.match(output.error ?? "", /timed out/i);
          assert.match(fs.readFileSync(sendKeysLog, "utf8"), /esc/);
        },
      );
    } finally {
      fs.rmSync(sendKeysLog, { force: true });
      fs.rmSync(artifactRoot, { recursive: true, force: true });
    }
  });

  it("preserves indented transcript lines when stripping box chrome", async () => {
    const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-herdr-artifact-"));
    const transcript = "line one\n  indented content here\n\tTabbed\n── box ──\nplain";
    try {
      await withEnv(
        {
          FAKE_HERDR_REPORT_MODE: "missing",
          FAKE_HERDR_TRANSCRIPT: transcript,
        },
        async () => {
          const backend = new HerdrSubagentBackend(artifactRoot, fakeCliOptions());
          const output = await backend.run(runInput(artifactRoot));
          assert.equal(output.semanticReport?.kind, "unstructured");
          if (output.semanticReport?.kind === "unstructured") {
            assert.match(output.semanticReport.text, /indented content here/);
            assert.match(output.semanticReport.text, /Tabbed/);
            assert.doesNotMatch(output.semanticReport.text, /── box ──/);
          }
        },
      );
    } finally {
      fs.rmSync(artifactRoot, { recursive: true, force: true });
    }
  });

  it("surfaces blocked agent status when report file is missing", async () => {
    const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-herdr-artifact-"));
    try {
      await withEnv(
        {
          FAKE_HERDR_REPORT_MODE: "missing",
          FAKE_HERDR_AGENT_STATUS: "blocked",
          FAKE_HERDR_TRANSCRIPT: "awaiting approval in terminal",
        },
        async () => {
          const backend = new HerdrSubagentBackend(artifactRoot, fakeCliOptions());
          const output = await backend.run(runInput(artifactRoot));
          assert.equal(output.settled, true);
          assert.equal(output.herdr?.agentStatus, "blocked");
          assert.match(output.reportText, /blocked/i);
          if (output.semanticReport?.kind === "unstructured") {
            assert.match(output.semanticReport.diagnostic, /blocked/i);
          }
        },
      );
    } finally {
      fs.rmSync(artifactRoot, { recursive: true, force: true });
    }
  });

  it("dispose closes only backend-created panes", async () => {
    const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-herdr-artifact-"));
    const closeLog = path.join(os.tmpdir(), `herdr-close-log-${process.pid}`);
    try {
      await withEnv(
        { FAKE_HERDR_REPORT_MODE: "missing", FAKE_HERDR_CLOSE_LOG: closeLog },
        async () => {
          const backend = new HerdrSubagentBackend(artifactRoot, fakeCliOptions());
          await backend.run(runInput(artifactRoot));
          await backend.dispose();
          assert.match(fs.readFileSync(closeLog, "utf8"), /pane-split-1/);
        },
      );
    } finally {
      fs.rmSync(closeLog, { force: true });
      fs.rmSync(artifactRoot, { recursive: true, force: true });
    }
  });

  it("includes --model for pi and omits it for kinds without model support", async () => {
    const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-herdr-artifact-"));
    const piArgsFile = path.join(os.tmpdir(), `herdr-start-args-pi-${process.pid}`);
    const geminiArgsFile = path.join(os.tmpdir(), `herdr-start-args-gemini-${process.pid}`);
    try {
      await withEnv(
        {
          FAKE_HERDR_REPORT_MODE: "missing",
          FAKE_HERDR_RECORD_ARGS: piArgsFile,
        },
        async () => {
          const backend = new HerdrSubagentBackend(artifactRoot, fakeCliOptions());
          await backend.run(runInput(artifactRoot, { profile: baseProfile({ kind: "pi" }) }));

          const piArgs = JSON.parse(fs.readFileSync(piArgsFile, "utf8")) as string[];
          assert.ok(piArgs.includes("--model"));
        },
      );

      await withEnv(
        {
          FAKE_HERDR_REPORT_MODE: "missing",
          FAKE_HERDR_RECORD_ARGS: geminiArgsFile,
        },
        async () => {
          const backend = new HerdrSubagentBackend(artifactRoot, fakeCliOptions());
          await backend.run(
            runInput(artifactRoot, {
              profile: baseProfile({ kind: "gemini" }),
              modelArg: "google/gemini-pro",
            }),
          );

          const geminiArgs = JSON.parse(fs.readFileSync(geminiArgsFile, "utf8")) as string[];
          assert.equal(geminiArgs.includes("--model"), false);
        },
      );
    } finally {
      fs.rmSync(piArgsFile, { force: true });
      fs.rmSync(geminiArgsFile, { force: true });
      fs.rmSync(artifactRoot, { recursive: true, force: true });
    }
  });

  it("worktree profile uses herdr worktree create and finalize patch flow", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-herdr-wt-repo-"));
    initGitRepo(repo);
    const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-herdr-wt-artifact-"));
    const runId = "sa-herdr-wt";
    const reportPath = reportPathFor(artifactRoot, runId);
    const removeLog = path.join(os.tmpdir(), `herdr-wt-remove-${process.pid}`);
    try {
      await withEnv(
        {
          FAKE_HERDR_REPORT_PATH: reportPath,
          FAKE_HERDR_REPORT_MODE: "valid",
          FAKE_HERDR_RECORD_REMOVE: removeLog,
          FAKE_HERDR_WORKSPACE_ID: "ws-wt-happy",
          FAKE_HERDR_ROOT_PANE_ID: "pane-wt-happy",
        },
        async () => {
          const backend = new HerdrSubagentBackend(artifactRoot, fakeCliOptions());
          const output = await backend.run(
            runInput(artifactRoot, {
              runId,
              cwd: repo,
              profile: baseProfile({ workspace: "worktree", tools: ["write", "edit"] }),
            }),
          );
          assert.equal(output.settled, true);
          assert.ok(output.worktree);
          assert.equal(output.worktree!.branchPreexisting, true);
          assert.equal(output.worktree!.herdrWorkspaceId, "ws-wt-happy");
          assert.equal(output.herdr?.paneId, "pane-wt-happy");

          fs.writeFileSync(path.join(output.worktree!.workPath, "wt-change.txt"), "from test\n");

          const finalized = await finalizeWorktree(output.worktree!, {
            description: "worktree herdr happy path",
            runId,
            artifactRoot,
            herdrCliOptions: fakeCliOptions(),
          });
          assert.equal(finalized.hasChanges, true);
          assert.equal(finalized.delivery.branch, output.worktree!.branch);
          assert.ok(finalized.delivery.patch);
          assert.match(fs.readFileSync(removeLog, "utf8"), /ws-wt-happy/);
        },
      );
    } finally {
      fs.rmSync(removeLog, { force: true });
      fs.rmSync(artifactRoot, { recursive: true, force: true });
      const list = execFileSync("git", ["worktree", "list"], { cwd: repo, encoding: "utf8" });
      for (const line of list.split("\n")) {
        const wtPath = line.split(/\s+/)[0];
        if (wtPath && wtPath !== repo && wtPath.includes("fake-herdr-wt")) {
          execFileSync("git", ["worktree", "remove", "--force", wtPath], {
            cwd: repo,
            stdio: "pipe",
          });
        }
      }
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
