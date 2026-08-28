/**
 * Herdr pane backend — interactive agent runs via herdr CLI.
 */

import { Effect } from "effect";
import type { BackendRunInput, BackendRunOutput, SubagentBackend } from "./backend.ts";
import { emptyUsage } from "./domain.ts";
import {
  HerdrApiError,
  HerdrCommandError,
  herdrBlockingOptions,
  type HerdrCliOptions,
  type HerdrError,
  herdrJson,
  stripAnsi,
} from "./herdr/cli.ts";
import {
  closePane,
  closeHerdrWorkspace,
  currentLayout,
  readAgent,
  readAgentVisible,
  removeHerdrWorktree,
  splitPane,
  waitForShell,
} from "./herdr/workspace.ts";
import { buildInteractivePrompt } from "./prompt.ts";
import {
  readReportFile,
  reportPathFor,
  semanticReportFromFile,
  type ReportFileOutcome,
} from "./report-file.ts";
import { renderRunReport, type ChildSemanticReport } from "./run-report.ts";
import { createWorktreeViaHerdrEffect, type WorktreeInfo } from "./worktree.ts";

const AGENT_START_TIMEOUT_MS = 30_000;
const RECOVERY_WAIT_MS = 30_000;
const TRANSCRIPT_LINES = 200;
const MODEL_FLAG_KINDS = new Set(["pi", "codex", "cursor"]);

type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

interface RunState {
  paneId: string | undefined;
  workspaceId: string | undefined;
  agentStatus: AgentStatus | undefined;
  worktree: WorktreeInfo | undefined;
}

export class HerdrSubagentBackend implements SubagentBackend {
  readonly id = "herdr";
  private artifactRoot: string;
  private cliOptions: HerdrCliOptions | undefined;
  private trackedResources: Array<{
    paneId: string;
    workspaceId?: string;
    worktreeWorkspace?: boolean;
  }>;

  constructor(artifactRoot: string, cliOptions?: HerdrCliOptions) {
    this.artifactRoot = artifactRoot;
    this.cliOptions = cliOptions;
    this.trackedResources = [];
  }

  getCliOptions(): HerdrCliOptions | undefined {
    return this.cliOptions;
  }

  async run(input: BackendRunInput): Promise<BackendRunOutput> {
    return Effect.runPromise(this.runEffect(input));
  }

  async cancel(runId: string, _reason?: string): Promise<void> {
    try {
      await Effect.runPromise(this.sendEsc(runId));
    } catch {
      // best-effort
    }
  }

  async dispose(): Promise<void> {
    for (const resource of this.trackedResources) {
      try {
        await Effect.runPromise(closePane(resource.paneId, this.cliOptions));
      } catch {
        // best-effort
      }
      if (resource.workspaceId) {
        try {
          if (resource.worktreeWorkspace) {
            await Effect.runPromise(removeHerdrWorktree(resource.workspaceId, this.cliOptions));
          } else {
            await Effect.runPromise(closeHerdrWorkspace(resource.workspaceId, this.cliOptions));
          }
        } catch {
          // best-effort
        }
      }
    }
    this.trackedResources = [];
  }

  private trackSessionResource(input: {
    paneId: string;
    workspaceId?: string;
    worktreeWorkspace?: boolean;
  }): void {
    if (this.trackedResources.some((r) => r.paneId === input.paneId)) return;
    this.trackedResources.push(input);
  }

  private runEffect(input: BackendRunInput): Effect.Effect<BackendRunOutput> {
    const self = this;
    const runState: RunState = {
      paneId: undefined,
      workspaceId: undefined,
      agentStatus: undefined,
      worktree: undefined,
    };

    const onAbortEsc = () => {
      void Effect.runPromise(self.sendEsc(input.runId).pipe(Effect.ignore));
    };

    const registerAbortEsc = () => {
      if (!input.signal.aborted) {
        input.signal.addEventListener("abort", onAbortEsc);
      }
    };

    const unregisterAbortEsc = () => {
      input.signal.removeEventListener("abort", onAbortEsc);
    };

    const core = Effect.gen(function* () {
      const reportPath = reportPathFor(self.artifactRoot, input.runId);
      const task = input.task ?? input.prompt;
      if (!task.trim()) {
        return self.withWorktree(self.failOutput(input, "subagent task is empty"), undefined);
      }

      const composedPrompt = buildInteractivePrompt(input.profile, task, input.context, reportPath);

      input.onActivity?.("starting");

      let worktreeInfo: WorktreeInfo | undefined;

      if (input.profile.workspace === "worktree") {
        worktreeInfo = yield* createWorktreeViaHerdrEffect(input.cwd, input.runId, self.cliOptions);
        if (!worktreeInfo) {
          return self.failOutput(input, "could not create Herdr worktree for this profile");
        }
        runState.worktree = worktreeInfo;
        runState.workspaceId = worktreeInfo.herdrWorkspaceId;
        runState.paneId = worktreeInfo.rootPaneId;
        if (worktreeInfo.rootPaneId) {
          self.trackSessionResource({
            paneId: worktreeInfo.rootPaneId,
            workspaceId: worktreeInfo.herdrWorkspaceId,
            worktreeWorkspace: true,
          });
        }
      } else {
        const layout = yield* currentLayout(self.cliOptions);
        runState.workspaceId = layout.workspaceId;
        runState.paneId = yield* splitPane(
          { cwd: input.cwd, direction: layout.direction },
          self.cliOptions,
        );
        self.trackSessionResource({ paneId: runState.paneId });
      }

      if (!runState.paneId) {
        return self.withWorktree(
          self.failOutput(input, "Herdr pane id missing after workspace setup"),
          worktreeInfo,
        );
      }

      yield* waitForShell(runState.paneId, self.cliOptions);
      yield* self.startAgent(input, runState.paneId);

      input.onActivity?.("prompting");
      const promptResult = yield* self.promptAndWait(input, composedPrompt, task);
      runState.agentStatus = promptResult.agentStatus;

      if (promptResult.cancelled) {
        return self.withWorktree(
          self.cancelledOutput(input, runState.paneId, runState.workspaceId, runState.agentStatus),
          worktreeInfo,
        );
      }
      if (promptResult.timedOut) {
        return self.withWorktree(
          self.timedOutOutput(input, runState.paneId, runState.workspaceId, runState.agentStatus),
          worktreeInfo,
        );
      }
      if (promptResult.error) {
        return self.withWorktree(
          self.failOutput(
            input,
            promptResult.error,
            runState.paneId,
            runState.workspaceId,
            runState.agentStatus,
          ),
          worktreeInfo,
        );
      }

      input.onActivity?.("working");

      const reportOutcome = readReportFile(reportPath);
      const transcript = yield* self.readTranscript(input.runId, composedPrompt);
      const { semanticReport, reportText, terminalReportReceived } = self.composeReport(
        reportOutcome,
        transcript,
        runState.agentStatus,
      );

      return self.withWorktree(
        {
          settled: true,
          reportText,
          semanticReport,
          usage: emptyUsage(),
          usageAvailable: false,
          terminalReportReceived,
          herdr: {
            paneId: runState.paneId,
            alias: input.runId,
            workspaceId: runState.workspaceId,
            agentStatus: runState.agentStatus,
          },
        },
        worktreeInfo,
      );
    });

    registerAbortEsc();

    return core.pipe(
      Effect.ensuring(Effect.sync(() => unregisterAbortEsc())),
      Effect.catch((error) => {
        if (input.signal.aborted) {
          return Effect.succeed(
            self.withWorktree(
              self.cancelledOutput(
                input,
                runState.paneId,
                runState.workspaceId,
                runState.agentStatus,
              ),
              runState.worktree,
            ),
          );
        }
        const message =
          error instanceof HerdrApiError
            ? error.message
            : error instanceof Error
              ? error.message
              : String(error);
        return Effect.succeed(
          self.withWorktree(
            self.failOutput(
              input,
              message,
              runState.paneId,
              runState.workspaceId,
              runState.agentStatus,
            ),
            runState.worktree,
          ),
        );
      }),
    );
  }

  private withWorktree(output: BackendRunOutput, worktree?: WorktreeInfo): BackendRunOutput {
    return worktree ? { ...output, worktree } : output;
  }

  private startAgent(input: BackendRunInput, paneId: string): Effect.Effect<void, HerdrError> {
    const args: string[] = [
      "agent",
      "start",
      input.runId,
      "--kind",
      input.profile.kind,
      "--pane",
      paneId,
      "--timeout",
      String(AGENT_START_TIMEOUT_MS),
    ];

    const extra: string[] = [...input.profile.agentArgs];
    if (input.modelArg && MODEL_FLAG_KINDS.has(input.profile.kind)) {
      extra.push("--model", input.modelArg);
    }
    if (extra.length > 0) {
      args.push("--", ...extra);
    }

    const opts = herdrBlockingOptions(this.cliOptions, AGENT_START_TIMEOUT_MS);
    return herdrJson(args, opts).pipe(Effect.asVoid);
  }

  private promptAndWait(
    input: BackendRunInput,
    composedPrompt: string,
    task: string,
  ): Effect.Effect<
    {
      agentStatus?: AgentStatus;
      cancelled?: boolean;
      timedOut?: boolean;
      error?: string;
    },
    HerdrError
  > {
    const self = this;
    const promptArgs = [
      "agent",
      "prompt",
      input.runId,
      composedPrompt,
      "--wait",
      "--until",
      "idle",
      "--until",
      "done",
      "--until",
      "blocked",
      "--timeout",
      String(input.timeoutMs),
    ];
    const waitOpts = herdrBlockingOptions(self.cliOptions, input.timeoutMs);

    const promptLoop = Effect.gen(function* () {
      let stalledRecoveryUsed = false;

      while (true) {
        if (input.signal.aborted) {
          yield* self.sendEsc(input.runId);
          return { cancelled: true };
        }

        const attempt = yield* herdrJson(promptArgs, waitOpts).pipe(
          Effect.map((result) => ({ ok: true as const, result })),
          Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
        );

        if (attempt.ok) {
          return { agentStatus: self.readAgentStatus(attempt.result) };
        }

        if (input.signal.aborted) {
          yield* self.sendEsc(input.runId);
          return { cancelled: true };
        }

        const error = attempt.error;
        if (error instanceof HerdrCommandError && error.killed) {
          yield* self.sendEsc(input.runId);
          const agentStatus = yield* self.readAgentStatusSafe(input.runId);
          return { timedOut: true, agentStatus };
        }
        if (error instanceof HerdrApiError) {
          if (error.code === "agent_prompt_stalled" && !stalledRecoveryUsed) {
            stalledRecoveryUsed = true;
            const recovered = yield* self.recoverStalledPrompt(input, task, composedPrompt);
            if (!recovered) {
              return { error: "agent_prompt_stalled recovery failed" };
            }
            continue;
          }
          if (error.code === "timeout") {
            yield* self.sendEsc(input.runId);
            const agentStatus = yield* self.readAgentStatusSafe(input.runId);
            return { timedOut: true, agentStatus };
          }
          if (error.code === "agent_pane_not_found") {
            return { error: error.message };
          }
          if (error.code === "empty_agent_prompt") {
            return { error: error.message };
          }
        }

        return yield* error;
      }
    });

    const onPromptAbortEsc = () => {
      void Effect.runPromise(self.sendEsc(input.runId).pipe(Effect.ignore));
    };

    if (!input.signal.aborted) {
      input.signal.addEventListener("abort", onPromptAbortEsc);
    }

    return promptLoop.pipe(
      Effect.ensuring(
        Effect.sync(() => input.signal.removeEventListener("abort", onPromptAbortEsc)),
      ),
    );
  }

  private recoverStalledPrompt(
    input: BackendRunInput,
    task: string,
    composedPrompt: string,
  ): Effect.Effect<boolean, HerdrError> {
    const self = this;
    return Effect.gen(function* () {
      const getResult = yield* herdrJson(["agent", "get", input.runId], self.cliOptions);
      const visible = yield* readAgentVisible(input.runId, self.cliOptions);
      const status = self.readAgentStatus(getResult);

      if (!self.promptLooksStaged(visible, task, composedPrompt) || status !== "idle") {
        return false;
      }

      yield* herdrJson(["agent", "send-keys", input.runId, "enter"], self.cliOptions);
      const waitOpts = herdrBlockingOptions(self.cliOptions, RECOVERY_WAIT_MS);
      yield* herdrJson(
        ["agent", "wait", input.runId, "--until", "working", "--timeout", String(RECOVERY_WAIT_MS)],
        waitOpts,
      );
      return true;
    }).pipe(Effect.orElseSucceed(() => false));
  }

  private readAgentStatus(result: unknown): AgentStatus | undefined {
    const status = (result as { agent?: { agent_status?: string } }).agent?.agent_status;
    if (
      status === "idle" ||
      status === "working" ||
      status === "blocked" ||
      status === "done" ||
      status === "unknown"
    ) {
      return status;
    }
    return undefined;
  }

  private readAgentStatusSafe(alias: string): Effect.Effect<AgentStatus | undefined, never> {
    return herdrJson(["agent", "get", alias], this.cliOptions).pipe(
      Effect.map((result) => this.readAgentStatus(result)),
      Effect.orElseSucceed(() => undefined),
    );
  }

  private promptLooksStaged(visible: string, task: string, composedPrompt: string): boolean {
    const taskSnippet = task.trim().slice(0, 120);
    if (taskSnippet && visible.includes(taskSnippet)) return true;
    const snippet = composedPrompt.trim().slice(0, 120);
    if (!snippet) return false;
    return visible.includes(snippet);
  }

  private readTranscript(alias: string, composedPrompt: string): Effect.Effect<string, HerdrError> {
    return readAgent(alias, TRANSCRIPT_LINES, this.cliOptions).pipe(
      Effect.map((text) => this.stripTranscriptChrome(text, composedPrompt)),
    );
  }

  private stripTranscriptChrome(text: string, prompt: string): string {
    let out = stripAnsi(text);
    const promptTrimmed = prompt.trim();
    if (promptTrimmed) {
      const idx = out.indexOf(promptTrimmed);
      if (idx >= 0) {
        out = out.slice(0, idx) + out.slice(idx + promptTrimmed.length);
      }
    }
    out = out.replace(/^[\u2500-\u257f\u2580-\u259f]+.*$/gm, "");
    return out.trim();
  }

  private composeReport(
    reportOutcome: ReportFileOutcome,
    transcript: string,
    agentStatus: AgentStatus | undefined,
  ): {
    semanticReport: ChildSemanticReport;
    reportText: string;
    terminalReportReceived: boolean;
  } {
    const blocked = agentStatus === "blocked";
    let diagnostic: string;
    if (reportOutcome.kind === "missing") {
      diagnostic = blocked
        ? "agent blocked awaiting approval; report file missing; fell back to transcript"
        : "report file missing; fell back to transcript";
    } else if (reportOutcome.kind === "invalid") {
      diagnostic = blocked
        ? `agent blocked awaiting approval; ${reportOutcome.reason}; fell back to transcript`
        : `${reportOutcome.reason}; fell back to transcript`;
    } else if (blocked) {
      diagnostic = "agent blocked awaiting approval; structured report file";
    } else {
      diagnostic = "structured report file";
    }

    const semanticReport = semanticReportFromFile(reportOutcome, transcript, diagnostic);
    let reportText =
      semanticReport.kind === "structured"
        ? renderRunReport(semanticReport.report)
        : semanticReport.text;

    if (blocked) {
      reportText = `Agent blocked (awaiting approval).\n\n${reportText}`;
    }

    return {
      semanticReport,
      reportText,
      terminalReportReceived: reportOutcome.kind === "valid",
    };
  }

  private sendEsc(alias: string): Effect.Effect<void, HerdrError> {
    return herdrJson(["agent", "send-keys", alias, "esc"], this.cliOptions).pipe(Effect.asVoid);
  }

  private failOutput(
    input: BackendRunInput,
    message: string,
    paneId?: string,
    workspaceId?: string,
    agentStatus?: AgentStatus,
  ): BackendRunOutput {
    return {
      settled: false,
      reportText: message,
      semanticReport: {
        kind: "unstructured",
        text: message,
        diagnostic: "herdr backend failure",
      },
      usage: emptyUsage(),
      usageAvailable: false,
      error: message,
      terminalReportReceived: false,
      herdr: paneId ? { paneId, alias: input.runId, workspaceId, agentStatus } : undefined,
    };
  }

  private cancelledOutput(
    input: BackendRunInput,
    paneId?: string,
    workspaceId?: string,
    agentStatus?: AgentStatus,
  ): BackendRunOutput {
    return {
      settled: false,
      reportText: "",
      semanticReport: {
        kind: "unstructured",
        text: "(no output)",
        diagnostic: "herdr run cancelled",
      },
      usage: emptyUsage(),
      usageAvailable: false,
      error: "subagent cancelled",
      terminalReportReceived: false,
      herdr: paneId ? { paneId, alias: input.runId, workspaceId, agentStatus } : undefined,
    };
  }

  private timedOutOutput(
    input: BackendRunInput,
    paneId?: string,
    workspaceId?: string,
    agentStatus?: AgentStatus,
  ): BackendRunOutput {
    return {
      settled: false,
      reportText: "",
      semanticReport: {
        kind: "unstructured",
        text: "(no output)",
        diagnostic: "herdr run timed out",
      },
      usage: emptyUsage(),
      usageAvailable: false,
      error: "subagent timed out",
      terminalReportReceived: false,
      herdr: paneId ? { paneId, alias: input.runId, workspaceId, agentStatus } : undefined,
    };
  }
}
