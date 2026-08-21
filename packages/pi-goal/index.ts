/**
 * pi-goal — Codex-style persistent, evidence-checked goals for the pi coding
 * agent.
 *
 * Architecture: the mutable orchestration state (goal, continuation flags,
 * aggregate agent-run provenance, per-turn snapshots, pending usage-limit /
 * completion-report state) lives in an Effect v4 `GoalRuntime` service behind
 * one `ManagedRuntime` (see `src/runtime.ts`). Every state transition is a
 * single serialized `SynchronizedRef` modify that returns directives
 * (persist / notify / send); this file is the thin imperative boundary that
 * runs those effect programs via `runGoalSync` and translates typed
 * `GoalError` failures into tool errors and command notifications.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Effect } from "effect";
import { Type, type Static } from "typebox";
import {
  buildGoalContextMessage,
  buildGoalSystemGuidance,
  GET_GOAL_DESCRIPTION,
  GOAL_PARAMETER_DESCRIPTIONS,
  GOAL_PROMPT_SNIPPET,
  UPDATE_GOAL_DESCRIPTION,
} from "./lib/prompt.ts";
import {
  cloneGoal,
  formatGoalSummary,
  formatTokenCount,
  GOAL_ENTRY_TYPE,
  remainingTokens,
  validateObjective,
  type Goal,
  type GoalEntryData,
} from "./lib/state.ts";
import {
  BUDGET_MESSAGE_TYPE,
  CONTINUATION_MESSAGE_TYPE,
  createGoalRuntime,
  OBJECTIVE_UPDATED_MESSAGE_TYPE,
  GoalRuntime,
  runGoalSync,
  type GoalDirective,
  type GoalRuntimeInstance,
} from "./src/runtime.ts";

const STATUS_KEY = "pi-goal";

export const EmptyGoalParams = Type.Object({});

export const UpdateGoalParams = Type.Object({
  status: StringEnum(["complete", "blocked"] as const, {
    description: GOAL_PARAMETER_DESCRIPTIONS.status,
  }),
});

type UpdateGoalInput = Static<typeof UpdateGoalParams>;

type GoalOperation = "get" | "update";

interface GoalToolDetails {
  operation: GoalOperation;
  goal: Goal | null;
  remainingTokens?: number;
}

function formatGoalForTool(goal: Goal | null): string {
  if (!goal) return "No goal exists for this thread.";
  const budget =
    goal.tokenBudget === undefined
      ? `${formatTokenCount(goal.tokensUsed)} tokens used`
      : `${formatTokenCount(goal.tokensUsed)} of ${formatTokenCount(goal.tokenBudget)} tokens used`;
  const remaining = remainingTokens(goal);
  return [
    `Goal status: ${goal.status}`,
    `Objective: ${goal.objective}`,
    `Usage: ${budget}`,
    `Elapsed time: ${Math.round(goal.timeUsedSeconds)} seconds`,
    ...(remaining === undefined
      ? []
      : [`Remaining token budget: ${formatTokenCount(remaining)}`]),
  ].join("\n");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function goalExtension(pi: ExtensionAPI): void {
  const runtime: GoalRuntimeInstance = createGoalRuntime();
  /** Resolve the Effect service once; all handlers run sync programs through
   * it. After session_shutdown the runtime is closed and every op fails fast
   * with a typed GoalRuntimeClosedError. */
  const goalRuntime = runtime.runSync(GoalRuntime);
  const run = <A, E>(effect: Effect.Effect<A, E>): A =>
    runGoalSync(runtime, effect);

  function refreshStatus(ctx: ExtensionContext, goal: Goal | null): void {
    if (!goal) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      ctx.ui.setWorkingMessage();
      return;
    }
    const budget =
      goal.tokenBudget === undefined
        ? formatTokenCount(goal.tokensUsed)
        : `${formatTokenCount(goal.tokensUsed)}/${formatTokenCount(goal.tokenBudget)}`;
    const objective = goal.objective.replace(/\s+/g, " ");
    const preview = objective.length > 48 ? `${objective.slice(0, 48)}…` : objective;
    ctx.ui.setStatus(
      STATUS_KEY,
      `goal ${goal.status} · ${budget} · ${preview}`,
    );
    ctx.ui.setWorkingMessage(
      goal.status === "active" ? `Pursuing goal: ${preview}` : undefined,
    );
  }

  function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void {
    ctx.ui.notify(message, type);
  }

  /** Execute the directives a transition produced, in order: persistence and
   * status refresh first, then notifications, then model-facing messages. */
  function executeDirectives(ctx: ExtensionContext, directives: readonly GoalDirective[]): void {
    for (const directive of directives) {
      switch (directive.kind) {
        case "persist": {
          const data: GoalEntryData = {
            version: 1,
            goal: cloneGoal(directive.goal),
          };
          pi.appendEntry(GOAL_ENTRY_TYPE, data);
          refreshStatus(ctx, directive.goal);
          break;
        }
        case "notify":
          ctx.ui.notify(directive.message, directive.type);
          break;
        case "send":
          try {
            pi.sendMessage(
              {
                customType: directive.customType,
                content: directive.content,
                display: true,
                details: directive.details,
              },
              {
                deliverAs: directive.deliverAs,
                triggerTurn: directive.triggerTurn,
              },
            );
          } catch (error) {
            console.error(`pi-goal: failed to queue ${directive.customType}: ${errorText(error)}`);
            // A failed send must not leave the runtime thinking a message is
            // queued: rearm continuation / budget steering for a later try.
            if (directive.customType === CONTINUATION_MESSAGE_TYPE) {
              run(goalRuntime.noteContinuationSendFailed);
            }
            if (directive.customType === BUDGET_MESSAGE_TYPE) {
              run(goalRuntime.forgetBudgetSteering);
            }
          }
          break;
      }
    }
  }

  /** Queue one follow-up goal turn from an idle thread (no pending user
   * input); the runtime gates on goal state, suppression, and duplicates. */
  function maybeQueueContinuation(ctx: ExtensionContext): void {
    if (!ctx.isIdle() || ctx.hasPendingMessages()) return;
    try {
      const directives = run(goalRuntime.queueContinuation);
      executeDirectives(ctx, directives);
    } catch (error) {
      console.error(`pi-goal: failed to queue continuation: ${errorText(error)}`);
    }
  }

  function scheduleContinuation(ctx: ExtensionContext): void {
    queueMicrotask(() => {
      if (ctx.isIdle()) maybeQueueContinuation(ctx);
    });
  }

  function result(
    operation: GoalOperation,
    text: string,
    goal: Goal | null,
  ): AgentToolResult<GoalToolDetails> {
    const details: GoalToolDetails = {
      operation,
      goal: cloneGoal(goal),
      ...(remainingTokens(goal) === undefined ? {} : { remainingTokens: remainingTokens(goal) }),
    };
    return {
      content: [{ type: "text", text }],
      details,
    };
  }

  function renderCall(
    name: string,
    args: Record<string, unknown>,
    theme: Theme,
  ): Text {
    let text = theme.fg("toolTitle", theme.bold(`${name} `));
    if (typeof args.objective === "string") {
      const preview = args.objective.length > 64 ? `${args.objective.slice(0, 64)}…` : args.objective;
      text += theme.fg("dim", preview);
    } else if (typeof args.status === "string") {
      text += theme.fg("accent", args.status);
    } else {
      text += theme.fg("muted", "current thread");
    }
    return new Text(text, 0, 0);
  }

  function renderResult(
    toolResult: AgentToolResult<GoalToolDetails>,
    expanded: boolean,
    theme: Theme,
  ): Text {
    const details = toolResult.details;
    if (!details) return new Text("", 0, 0);
    const goal = details.goal;
    if (!goal) return new Text(theme.fg("dim", "No goal"), 0, 0);

    let text =
      theme.fg("success", "✓ ") +
      theme.fg("accent", `goal ${goal.status}`) +
      theme.fg("muted", ` · ${formatTokenCount(goal.tokensUsed)} tokens`);
    if (expanded) text += `\n${formatGoalForTool(goal)}`;
    return new Text(text, 0, 0);
  }

  pi.on("session_start", async (event, ctx) => {
    run(goalRuntime.loadFromBranch(ctx.sessionManager.getBranch() as readonly unknown[]));

    // Codex reactivates goals that were paused by an interrupted run when a
    // thread is resumed. An explicit /goal pause remains paused.
    if (event.reason === "startup" || event.reason === "resume") {
      const goal = run(goalRuntime.goal);
      if (goal?.status === "paused" && goal.pauseReason === "interrupt") {
        const op = run(goalRuntime.resume);
        executeDirectives(ctx, op.directives);
      }
    }

    const goal = run(goalRuntime.goal);
    refreshStatus(ctx, goal);
    if (
      goal?.status === "active" &&
      (event.reason === "startup" ||
        event.reason === "reload" ||
        event.reason === "new" ||
        event.reason === "resume" ||
        event.reason === "fork")
    ) {
      scheduleContinuation(ctx);
    }
  });

  pi.on("session_tree", async (_event, ctx) => {
    run(goalRuntime.loadFromBranch(ctx.sessionManager.getBranch() as readonly unknown[]));
    const goal = run(goalRuntime.goal);
    refreshStatus(ctx, goal);
    if (goal?.status === "active") scheduleContinuation(ctx);
  });

  pi.on("before_agent_start", (event, _ctx) => {
    const goal = run(goalRuntime.goal);
    if (!goal || goal.status === "complete") return;
    // Trusted extension guidance only: the user-controlled objective is
    // injected separately at user authority via the context event.
    return {
      systemPrompt: `${event.systemPrompt}\n\n${buildGoalSystemGuidance(goal)}`,
    };
  });

  pi.on("context", (event) => {
    const goal = run(goalRuntime.goal);
    if (!goal || goal.status !== "active") return;
    const messages = event.messages;
    const last = messages.length > 0 ? messages[messages.length - 1] : undefined;
    // Goal steering messages already carry the objective. Skip duplicate
    // context only when they contain the current revision; a queued stale
    // continuation must be supplemented after the user edits the objective.
    if (last !== undefined && typeof last === "object") {
      const steering = last as {
        customType?: unknown;
        details?: { goalUpdatedAt?: unknown };
      };
      if (
        (steering.customType === CONTINUATION_MESSAGE_TYPE ||
          steering.customType === OBJECTIVE_UPDATED_MESSAGE_TYPE) &&
        steering.details?.goalUpdatedAt === goal.updatedAt
      ) {
        return;
      }
    }
    const goalMessage = {
      role: "user" as const,
      content: [{ type: "text" as const, text: buildGoalContextMessage(goal) }],
      timestamp: Date.now(),
    };
    if (last?.role === "user") {
      // Keep the current user prompt last; the goal context reads as prior
      // user-role context rather than as the active request.
      return { messages: [...messages.slice(0, -1), goalMessage, last] };
    }
    return { messages: [...messages, goalMessage] };
  });

  pi.on("input", (event, ctx) => {
    if (event.source === "extension") return { action: "continue" as const };

    // A user steering an active run is an interruption. Pause before the
    // interrupted turn can settle so no automatic continuation races it.
    if (event.streamingBehavior === "steer") {
      const op = run(goalRuntime.steerPause);
      executeDirectives(ctx, op.directives);
      if (!op.changed) run(goalRuntime.noteUserInput(event.text));
      return { action: "continue" as const };
    }

    run(goalRuntime.noteUserInput(event.text));
    return { action: "continue" as const };
  });

  pi.on("agent_start", () => {
    run(goalRuntime.agentStart);
  });

  pi.on("tool_execution_start", () => {
    run(goalRuntime.toolExecutionStarted);
  });

  pi.on("turn_start", (event) => {
    run(goalRuntime.turnStarted(event.turnIndex, event.timestamp || Date.now()));
  });

  pi.on("turn_end", async (event, ctx) => {
    const op = run(
      goalRuntime.turnEnded(event.turnIndex, event.message, event.toolResults as readonly unknown[]),
    );
    executeDirectives(ctx, op.directives);
  });

  pi.on("agent_end", async (event, ctx) => {
    const op = run(goalRuntime.agentEnded(event.messages as readonly unknown[]));
    executeDirectives(ctx, op.directives);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const op = run(goalRuntime.agentSettled);
    executeDirectives(ctx, op.directives);
    if (ctx.isIdle() && !ctx.hasPendingMessages()) {
      maybeQueueContinuation(ctx);
    }
  });

  pi.registerTool({
    name: "get_goal",
    label: "Get Goal",
    description: GET_GOAL_DESCRIPTION,
    promptSnippet: GOAL_PROMPT_SNIPPET,
    parameters: EmptyGoalParams,
    executionMode: "sequential",
    async execute(): Promise<AgentToolResult<GoalToolDetails>> {
      const goal = run(goalRuntime.goal);
      return result("get", formatGoalForTool(goal), goal);
    },
    renderCall(_args, theme) {
      return renderCall("get_goal", {}, theme);
    },
    renderResult(toolResult, { expanded }, theme) {
      return renderResult(toolResult, expanded, theme);
    },
  });

  pi.registerTool({
    name: "update_goal",
    label: "Update Goal",
    description: UPDATE_GOAL_DESCRIPTION,
    parameters: UpdateGoalParams,
    executionMode: "sequential",
    async execute(
      _toolCallId,
      params: UpdateGoalInput,
      _signal,
      _onUpdate,
      ctx,
    ): Promise<AgentToolResult<GoalToolDetails>> {
      try {
        const op = run(goalRuntime.updateGoalStatus(params.status));
        executeDirectives(ctx, op.directives);
        const hasBudget = op.goal?.tokenBudget !== undefined;
        const text =
          params.status === "complete"
            ? hasBudget
              ? "Goal marked complete. A final budget usage report follows once this turn's usage is accounted."
              : "Goal marked complete."
            : "Goal marked blocked after the requested blocked-condition audit.";
        return result("update", text, op.goal);
      } catch (error) {
        throw toPiError(error);
      }
    },
    renderCall(args, theme) {
      return renderCall("update_goal", args as unknown as Record<string, unknown>, theme);
    },
    renderResult(toolResult, { expanded }, theme) {
      return renderResult(toolResult, expanded, theme);
    },
  });

  pi.registerCommand("goal", {
    description: "Set, edit, view, pause, resume, or clear the current long-running goal",
    getArgumentCompletions: (prefix) => {
      const options = ["edit", "pause", "resume", "clear", "complete", "budget"];
      const matches = options
        .filter((option) => option.startsWith(prefix.trim().toLowerCase()))
        .map((value) => ({ value, label: value }));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => {
      const raw = args.trim();
      if (!raw || raw.toLowerCase() === "status") {
        notify(ctx, formatGoalSummary(run(goalRuntime.goal)));
        return;
      }

      const command = raw.toLowerCase();

      const setUserObjective = async (
        objective: string,
        tokenBudget?: number,
      ): Promise<void> => {
        const objectiveError = validateObjective(objective);
        if (objectiveError) throw new Error(objectiveError);

        const before = run(goalRuntime.goal);
        const reactivatesStoppedGoal =
          before === null ||
          before.status === "complete" ||
          before.status === "budget-limited";
        if (reactivatesStoppedGoal && !ctx.isIdle()) {
          ctx.abort();
          await ctx.waitForIdle();
        }

        const steerActiveRun =
          before?.status === "active" && !ctx.isIdle();
        const op = run(
          goalRuntime.setGoalObjective(
            objective,
            tokenBudget,
            steerActiveRun,
          ),
        );
        executeDirectives(ctx, op.directives);
        const message = !op.changed
          ? "Goal objective unchanged."
          : before
            ? "Goal objective updated."
            : "Goal started.";
        notify(ctx, `${message}\n${formatGoalSummary(op.goal)}`);
        if (op.changed && op.goal?.status === "active" && ctx.isIdle()) {
          scheduleContinuation(ctx);
        }
      };

      if (command === "edit") {
        let current: Goal | null;
        try {
          current = run(goalRuntime.goal);
        } catch (error) {
          notify(ctx, errorText(error), "error");
          return;
        }
        if (!current) {
          notify(ctx, "No goal exists to edit.", "warning");
          return;
        }
        if (!ctx.hasUI) {
          notify(ctx, "Use /goal <objective> to edit the goal in this mode.", "error");
          return;
        }
        const objective = await ctx.ui.editor("Edit goal", current.objective);
        if (objective === undefined) return;
        try {
          await setUserObjective(objective);
        } catch (error) {
          notify(ctx, errorText(error), "error");
        }
        return;
      }

      if (command === "pause") {
        const op = run(goalRuntime.pause("user"));
        executeDirectives(ctx, op.directives);
        notify(ctx, op.changed ? "Goal paused." : "No active goal to pause.", op.changed ? "info" : "warning");
        if (op.changed && !ctx.isIdle()) ctx.abort();
        return;
      }
      if (command === "resume") {
        const before = run(goalRuntime.goal);
        if (
          !before ||
          (before.status !== "paused" &&
            before.status !== "blocked" &&
            before.status !== "usage-limited")
        ) {
          notify(ctx, "No paused or stopped goal to resume.", "warning");
          return;
        }
        const willActivate =
          before.tokenBudget === undefined ||
          before.tokensUsed < before.tokenBudget;
        if (willActivate && !ctx.isIdle()) {
          // Keep the goal stopped while the current run settles: the in-flight
          // turn began while stopped and must not be billed to the resumed
          // goal, and the settling run must neither repause the goal (via an
          // aborted agent_end) nor re-suppress the explicit resume. Activate
          // and schedule only from idle.
          ctx.abort();
          await ctx.waitForIdle();
        }
        const op = run(goalRuntime.resume);
        executeDirectives(ctx, op.directives);
        if (!op.changed) {
          notify(ctx, "No paused or stopped goal to resume.", "warning");
        } else if (op.goal?.status === "budget-limited") {
          // The cap is exhausted: describe the actual resulting state instead
          // of claiming the goal was resumed.
          notify(ctx, "Goal is budget-limited; raise the budget to resume.", "warning");
        } else {
          notify(ctx, "Goal resumed.", "info");
        }
        if (op.goal?.status === "active") scheduleContinuation(ctx);
        return;
      }
      if (command === "clear") {
        const op = run(goalRuntime.clearGoal);
        executeDirectives(ctx, op.directives);
        notify(ctx, op.changed ? "Goal cleared." : "No goal to clear.");
        if (op.changed && !ctx.isIdle()) ctx.abort();
        return;
      }
      if (command === "complete") {
        const op = run(goalRuntime.completeGoal);
        if (!op.changed) {
          notify(ctx, "No incomplete goal to complete.", "warning");
          return;
        }
        executeDirectives(ctx, op.directives);
        notify(ctx, "Goal marked complete.");
        // Stop the in-flight run so it does not keep working under the now
        // completed goal's guidance. The goal is complete, so the abort's
        // interrupt handling cannot pause it.
        if (!ctx.isIdle()) ctx.abort();
        return;
      }

      const budgetCommand = raw.match(/^budget(?:\s+(.+))?$/i);
      if (budgetCommand) {
        const value = budgetCommand[1]?.trim().toLowerCase();
        if (value === undefined) {
          notify(ctx, "Usage: /goal budget <positive integer> (or clear)", "error");
          return;
        }
        const nextBudget =
          value === "clear" || value === "none" || value === "off"
            ? undefined
            : Number(value);
        if (nextBudget !== undefined && !Number.isSafeInteger(nextBudget)) {
          notify(ctx, "Usage: /goal budget <positive integer> (or clear)", "error");
          return;
        }
        try {
          const before = run(goalRuntime.goal);
          const recoversLimited =
            before?.status === "budget-limited" &&
            (nextBudget === undefined || before.tokensUsed < nextBudget);
          const wasActive = before?.status === "active";
          if (recoversLimited && !ctx.isIdle()) {
            // Keep the goal budget-limited while its stop/report run settles:
            // the pending aborted agent_end cannot repause a non-active goal,
            // and the settled run cannot re-suppress the continuation that
            // follows activation. Activate and schedule only from idle.
            ctx.abort();
            await ctx.waitForIdle();
          }
          const op = run(goalRuntime.setBudget(nextBudget));
          executeDirectives(ctx, op.directives);
          notify(ctx, `Goal budget updated.\n${formatGoalSummary(op.goal)}`, "info");
          if (op.goal?.status === "active") {
            scheduleContinuation(ctx);
          } else if (op.goal?.status === "budget-limited" && wasActive && !ctx.isIdle()) {
            // The cap dropped below current usage mid-run: stop substantive
            // work through the normal stop/report steering path and halt the
            // run so no further turns run under the old active guidance.
            const steer = run(goalRuntime.steerBudget(op.goal));
            executeDirectives(ctx, steer);
            ctx.abort();
          }
        } catch (error) {
          notify(ctx, errorText(error), "error");
        }
        return;
      }

      let objective = raw;
      let tokenBudget: number | undefined;
      const budgetPrefix = raw.match(/^--(?:token-)?budget(?:=|\s+)(\S+)(?:\s+([\s\S]*))?$/i);
      if (budgetPrefix) {
        tokenBudget = Number(budgetPrefix[1]);
        objective = budgetPrefix[2]?.trim() ?? "";
        if (!Number.isSafeInteger(tokenBudget) || tokenBudget <= 0) {
          notify(ctx, "Token budget must be a positive safe integer.", "error");
          return;
        }
      }

      try {
        await setUserObjective(objective, tokenBudget);
      } catch (error) {
        notify(ctx, errorText(error), "error");
      }
    },
  });

  // Deterministic disposal on quit, reload, and session replacement: the
  // close operation marks the runtime closed, so any stale handler invocation
  // after shutdown fails fast with a typed GoalRuntimeClosedError instead of
  // mutating state.
  pi.on("session_shutdown", async (_event, ctx) => {
    try {
      ctx.ui.setStatus(STATUS_KEY, undefined);
    } catch {
      // The UI may already be torn down during process shutdown.
    }
    try {
      run(goalRuntime.close);
    } catch (error) {
      console.error(`pi-goal: failed to close runtime: ${errorText(error)}`);
    }
  });
}

/** Translate typed GoalError failures (and defects) into thrown Errors, which
 * is what pi's tool contract expects. GoalError variants are Error
 * subclasses, so their message survives. */
function toPiError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export type { Goal, GoalStatus } from "./lib/state.ts";
export { restoreGoal } from "./lib/state.ts";
export { buildContinuationPrompt } from "./lib/prompt.ts";
