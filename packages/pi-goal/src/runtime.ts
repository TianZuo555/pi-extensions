/**
 * GoalRuntime — the Effect v4-owned orchestration state of the goal extension.
 *
 * Architecture: all mutable goal state lives in one `SynchronizedRef` behind a
 * `Context.Service`; every state transition is a single serialized
 * `SynchronizedRef.modify` that returns "directives" (persist / notify / send)
 * for the imperative pi adapter in `index.ts` to execute. All transitions are
 * synchronous, so the whole runtime runs under `Runtime.runSync`; there are no
 * fibers, so no Queue/Deferred/Scope machinery is needed beyond the
 * ManagedRuntime's own disposal scope.
 *
 * The service is intentionally pure: it knows nothing about pi. The adapter
 * resolves the service once (`runtime.runSync(GoalRuntime)`), runs effect
 * programs through `runGoalSync`, and translates typed `GoalError` failures
 * into tool errors / notifications at the boundary.
 */

import {
  Cause,
  Context,
  Data,
  Effect,
  Exit,
  Layer,
  ManagedRuntime,
  MutableRef,
  Result,
  SynchronizedRef,
} from "effect";
import {
  addGoalUsage,
  canCreateOver,
  cloneGoal,
  completionBudgetReport,
  createGoal,
  formatTokenCount,
  restoreGoal,
  setGoalStatus,
  usageFromUnknown,
  validateObjective,
  validateTokenBudget,
  type Goal,
  type GoalPauseReason,
  type GoalStatus,
} from "../lib/state.ts";
import {
  buildBudgetLimitPrompt,
  buildContinuationPrompt,
} from "../lib/prompt.ts";

export const CONTINUATION_MESSAGE_TYPE = "pi-goal-continuation";
export const BUDGET_MESSAGE_TYPE = "pi-goal-budget";
export const COMPLETION_MESSAGE_TYPE = "pi-goal-completion";

// --- State -------------------------------------------------------------------

export interface GoalTurnSnapshot {
  readonly goalId: string;
  readonly startedAt: number;
}

export interface GoalRuntimeState {
  goal: Goal | null;
  continuationQueued: boolean;
  continuationSuppressed: boolean;
  budgetSteeringGoalId: string | undefined;
  pendingUsageLimited: boolean;
  pendingCompletionReportGoalId: string | undefined;
  agentRunActive: boolean;
  agentRunWasContinuation: boolean;
  agentRunToolCalls: number;
  currentTurnIndex: number | undefined;
  goalTurns: Map<number, GoalTurnSnapshot>;
  turnStartTimes: Map<number, number>;
}

function initialState(): GoalRuntimeState {
  return {
    goal: null,
    continuationQueued: false,
    continuationSuppressed: false,
    budgetSteeringGoalId: undefined,
    pendingUsageLimited: false,
    pendingCompletionReportGoalId: undefined,
    agentRunActive: false,
    agentRunWasContinuation: false,
    agentRunToolCalls: 0,
    currentTurnIndex: undefined,
    goalTurns: new Map(),
    turnStartTimes: new Map(),
  };
}

// --- Directives (adapter-executed side effects) --------------------------------

export type GoalDirective =
  | { readonly kind: "persist"; readonly goal: Goal | null }
  | {
      readonly kind: "notify";
      readonly message: string;
      readonly type: "info" | "warning" | "error";
    }
  | {
      readonly kind: "send";
      readonly customType: string;
      readonly content: string;
      readonly details: Readonly<Record<string, unknown>>;
      readonly deliverAs: "steer" | "followUp";
      readonly triggerTurn: boolean;
    };

export interface GoalOpResult {
  readonly directives: readonly GoalDirective[];
  readonly goal: Goal | null;
  readonly changed: boolean;
}

// --- Typed domain failures -----------------------------------------------------

export class NoGoalError extends Data.TaggedError("NoGoalError")<{
  readonly message: string;
}> {}
export class UnfinishedGoalError extends Data.TaggedError("UnfinishedGoalError")<{
  readonly message: string;
}> {}
export class AlreadyCompleteError extends Data.TaggedError("AlreadyCompleteError")<{
  readonly message: string;
}> {}
export class InvalidObjectiveError extends Data.TaggedError(
  "InvalidObjectiveError",
)<{ readonly message: string }> {}
export class InvalidBudgetError extends Data.TaggedError("InvalidBudgetError")<{
  readonly message: string;
}> {}
export class GoalRuntimeClosedError extends Data.TaggedError(
  "GoalRuntimeClosedError",
)<{ readonly message: string }> {}

export type GoalError =
  | NoGoalError
  | UnfinishedGoalError
  | AlreadyCompleteError
  | InvalidObjectiveError
  | InvalidBudgetError
  | GoalRuntimeClosedError;

// --- Service --------------------------------------------------------------------

export interface GoalRuntimeShape {
  /** Current state snapshot (live maps; do not mutate). */
  readonly state: Effect.Effect<GoalRuntimeState, GoalError>;
  readonly goal: Effect.Effect<Goal | null, GoalError>;
  readonly loadFromBranch: (
    entries: readonly unknown[],
  ) => Effect.Effect<void, GoalError>;
  readonly noteUserInput: (text: string) => Effect.Effect<void, GoalError>;
  readonly steerPause: Effect.Effect<GoalOpResult, GoalError>;
  readonly agentStart: Effect.Effect<void, GoalError>;
  readonly toolExecutionStarted: Effect.Effect<void, GoalError>;
  readonly turnStarted: (
    turnIndex: number,
    timestamp: number,
  ) => Effect.Effect<void, GoalError>;
  readonly turnEnded: (
    turnIndex: number,
    message: unknown,
    toolResults: readonly unknown[],
  ) => Effect.Effect<GoalOpResult, GoalError>;
  readonly agentEnded: (
    messages: readonly unknown[],
  ) => Effect.Effect<GoalOpResult, GoalError>;
  readonly agentSettled: Effect.Effect<GoalOpResult, GoalError>;
  readonly pause: (
    reason: GoalPauseReason,
  ) => Effect.Effect<GoalOpResult, GoalError>;
  readonly resume: Effect.Effect<GoalOpResult, GoalError>;
  readonly setBudget: (
    tokenBudget: number | undefined,
  ) => Effect.Effect<GoalOpResult, GoalError>;
  readonly createGoal: (
    objective: string,
    tokenBudget: number | undefined,
  ) => Effect.Effect<GoalOpResult, GoalError>;
  readonly replaceGoal: (
    objective: string,
    tokenBudget: number | undefined,
  ) => Effect.Effect<GoalOpResult, GoalError>;
  readonly updateGoalStatus: (
    status: "complete" | "blocked",
  ) => Effect.Effect<GoalOpResult, GoalError>;
  readonly completeGoal: Effect.Effect<GoalOpResult, GoalError>;
  readonly clearGoal: Effect.Effect<GoalOpResult, GoalError>;
  readonly queueContinuation: Effect.Effect<readonly GoalDirective[], GoalError>;
  readonly steerBudget: (
    goal: Goal,
  ) => Effect.Effect<readonly GoalDirective[], GoalError>;
  readonly forgetBudgetSteering: Effect.Effect<void, GoalError>;
  readonly noteContinuationSendFailed: Effect.Effect<void, GoalError>;
  /** Deterministic disposal: marks the runtime closed so every subsequent
   * operation fails fast with a typed GoalRuntimeClosedError. */
  readonly close: Effect.Effect<void, GoalError>;
}

export class GoalRuntime extends Context.Service<
  GoalRuntime,
  GoalRuntimeShape
>()("pi-goal/GoalRuntime") {}

// --- Pure transition helpers ----------------------------------------------------

function isAssistantLike(value: unknown): value is {
  role: string;
  usage?: unknown;
  stopReason?: string;
  errorMessage?: unknown;
} {
  return typeof value === "object" && value !== null && "role" in value;
}

function isUsageLimitedMessage(value: unknown): boolean {
  if (!isAssistantLike(value) || value.role !== "assistant" || value.stopReason !== "error") {
    return false;
  }
  const message = typeof value.errorMessage === "string" ? value.errorMessage.toLowerCase() : "";
  // Hard usage/quota limits and final rate limits. A rate-limit error is
  // retryable mid-run — the pending candidate is cleared by the next
  // agentStart — but when the aggregate run settles on it with no retry, the
  // goal must become usage-limited instead of auto-continuing into repeated
  // 429s.
  return /usage limit|quota|rate limit|resource exhausted|insufficient quota|monthly limit/.test(message);
}

function usageForTurn(message: unknown, toolResults: readonly unknown[]): number {
  const messageUsage = isAssistantLike(message) ? usageFromUnknown(message.usage) : 0;
  const nestedUsage = toolResults.reduce<number>((sum, result) => {
    if (!isAssistantLike(result)) return sum;
    return sum + usageFromUnknown(result.usage);
  }, 0);
  return messageUsage + nestedUsage;
}

// --- Transition builders (pure: (state, args) => [result, nextState]) ----------

type TransitionOutcome<E> =
  | { readonly ok: true; readonly result: GoalOpResult }
  | { readonly ok: false; readonly error: E };

function resultOf(
  state: GoalRuntimeState,
  directives: readonly GoalDirective[],
  changed: boolean,
): GoalOpResult {
  return { directives, goal: cloneGoal(state.goal), changed };
}

function persistDirective(goal: Goal | null): GoalDirective {
  return { kind: "persist", goal: cloneGoal(goal) };
}

function notifyDirective(
  message: string,
  type: "info" | "warning" | "error",
): GoalDirective {
  return { kind: "notify", message, type };
}

function sendDirective(
  customType: string,
  content: string,
  details: Record<string, unknown>,
  deliverAs: "steer" | "followUp",
  triggerTurn: boolean,
): GoalDirective {
  return { kind: "send", customType, content, details, deliverAs, triggerTurn };
}

/** Attach the in-flight turn to a goal that became active mid-turn (model
 * creation only; resumed/replaced goals never take over a turn that began
 * under another state). */
function trackCurrentTurnGoal(
  state: GoalRuntimeState,
  goal: Goal,
): GoalRuntimeState {
  if (state.currentTurnIndex === undefined || goal.status !== "active") {
    return state;
  }
  const startedAt = state.turnStartTimes.get(state.currentTurnIndex);
  if (startedAt === undefined) return state;
  const goalTurns = new Map(state.goalTurns);
  goalTurns.set(state.currentTurnIndex, { goalId: goal.goalId, startedAt });
  return { ...state, goalTurns };
}

function loadFromBranchTransition(
  state: GoalRuntimeState,
  entries: readonly unknown[],
): GoalRuntimeState {
  return {
    ...state,
    goal: restoreGoal(entries),
    currentTurnIndex: undefined,
    goalTurns: new Map(),
    turnStartTimes: new Map(),
    continuationQueued: false,
    continuationSuppressed: false,
    budgetSteeringGoalId: undefined,
    pendingUsageLimited: false,
    pendingCompletionReportGoalId: undefined,
  };
}

function noteUserInputTransition(
  state: GoalRuntimeState,
  text: string,
): GoalRuntimeState {
  return {
    ...state,
    continuationSuppressed:
      text.trim().length > 0 ? false : state.continuationSuppressed,
    continuationQueued: false,
  };
}

function steerPauseTransition(
  state: GoalRuntimeState,
  reason: GoalPauseReason,
): [GoalOpResult, GoalRuntimeState] {
  if (!state.goal || state.goal.status !== "active") {
    return [resultOf(state, [], false), state];
  }
  const next: GoalRuntimeState = {
    ...state,
    goal: setGoalStatus(state.goal, "paused", Date.now(), reason),
    continuationSuppressed: true,
    continuationQueued: false,
  };
  return [resultOf(next, [persistDirective(next.goal)], true), next];
}

function agentStartTransition(state: GoalRuntimeState): GoalRuntimeState {
  const next: GoalRuntimeState = { ...state, pendingUsageLimited: false };
  if (state.agentRunActive) return next;
  // Initialize aggregate-run fields only at the first low-level run of an
  // unsettled sequence; retries must not lose continuation provenance or
  // previously accumulated tool activity.
  return {
    ...next,
    agentRunActive: true,
    agentRunWasContinuation: state.continuationQueued,
    continuationQueued: false,
    agentRunToolCalls: 0,
  };
}

function toolExecutionStartedTransition(state: GoalRuntimeState): GoalRuntimeState {
  if (!state.agentRunActive) return state;
  return {
    ...state,
    agentRunToolCalls: state.agentRunToolCalls + 1,
    continuationSuppressed: false,
  };
}

function turnStartedTransition(
  state: GoalRuntimeState,
  turnIndex: number,
  timestamp: number,
): GoalRuntimeState {
  const turnStartTimes = new Map(state.turnStartTimes);
  turnStartTimes.set(turnIndex, timestamp);
  const next: GoalRuntimeState = { ...state, currentTurnIndex: turnIndex, turnStartTimes };
  if (next.goal && next.goal.status === "active") {
    return trackCurrentTurnGoal(next, next.goal);
  }
  return next;
}

function turnEndedTransition(
  state: GoalRuntimeState,
  turnIndex: number,
  message: unknown,
  toolResults: readonly unknown[],
): [GoalOpResult, GoalRuntimeState] {
  const completingGoalId = state.pendingCompletionReportGoalId;
  const snapshot = state.goalTurns.get(turnIndex);
  const directives: GoalDirective[] = [];

  if (!snapshot) {
    // No in-flight goal turn was tracked, so persisted totals are already
    // final; deliver the completion report immediately if one is owed.
    const next: GoalRuntimeState = { ...state, pendingCompletionReportGoalId: undefined };
    if (
      completingGoalId !== undefined &&
      next.goal?.goalId === completingGoalId &&
      next.goal.status === "complete"
    ) {
      const report = completionBudgetReport(next.goal);
      if (report) {
        directives.push(
          sendDirective(COMPLETION_MESSAGE_TYPE, report, { goalId: next.goal.goalId }, "steer", false),
        );
      }
    }
    return [resultOf(next, directives, false), next];
  }

  const goalTurns = new Map(state.goalTurns);
  goalTurns.delete(turnIndex);
  const turnStartTimes = new Map(state.turnStartTimes);
  turnStartTimes.delete(turnIndex);
  let next: GoalRuntimeState = {
    ...state,
    pendingCompletionReportGoalId: undefined,
    goalTurns,
    turnStartTimes,
    currentTurnIndex: state.currentTurnIndex === turnIndex ? undefined : state.currentTurnIndex,
  };

  const tokens = usageForTurn(message, toolResults);
  const seconds = Math.max(0, (Date.now() - snapshot.startedAt) / 1_000);
  let budgetLimitedGoal: Goal | undefined;
  if (next.goal && next.goal.goalId === snapshot.goalId) {
    const wasActive = next.goal.status === "active";
    const accounted = addGoalUsage(next.goal, { tokens, seconds });
    next = { ...next, goal: accounted };
    if (wasActive && accounted.status === "budget-limited") {
      budgetLimitedGoal = accounted;
    }
  }
  directives.push(persistDirective(next.goal));

  // The completion turn's usage is persisted now; deliver the corrected
  // completion budget report (the closing response after this turn is not
  // billed to the goal, so these totals are final).
  if (
    completingGoalId !== undefined &&
    next.goal?.goalId === completingGoalId &&
    next.goal.status === "complete"
  ) {
    const report = completionBudgetReport(next.goal);
    if (report) {
      directives.push(
        sendDirective(COMPLETION_MESSAGE_TYPE, report, { goalId: next.goal.goalId }, "steer", false),
      );
    }
  }

  if (budgetLimitedGoal) {
    directives.push(
      notifyDirective(
        `Goal token budget reached: ${formatTokenCount(budgetLimitedGoal.tokensUsed)} of ${formatTokenCount(budgetLimitedGoal.tokenBudget ?? budgetLimitedGoal.tokensUsed)} tokens.`,
        "warning",
      ),
    );
    if (state.budgetSteeringGoalId !== budgetLimitedGoal.goalId) {
      next = { ...next, budgetSteeringGoalId: budgetLimitedGoal.goalId };
      directives.push(
        sendDirective(
          BUDGET_MESSAGE_TYPE,
          buildBudgetLimitPrompt(budgetLimitedGoal),
          { goalId: budgetLimitedGoal.goalId },
          "steer",
          false,
        ),
      );
    }
  }
  return [resultOf(next, directives, true), next];
}

function agentEndedTransition(
  state: GoalRuntimeState,
  messages: readonly unknown[],
): [GoalOpResult, GoalRuntimeState] {
  // A usage/quota error is only terminal once the aggregate run settles
  // without a retry; Pi may retry rate-limit and quota errors after agent_end.
  if (messages.some(isUsageLimitedMessage)) {
    const next: GoalRuntimeState = { ...state, pendingUsageLimited: true };
    return [resultOf(next, [], false), next];
  }

  const interrupted = messages.some((message) => {
    if (!isAssistantLike(message)) return false;
    return message.role === "assistant" && message.stopReason === "aborted";
  });
  if (interrupted && state.goal?.status === "active") {
    const next: GoalRuntimeState = {
      ...state,
      goal: setGoalStatus(state.goal, "paused", Date.now(), "interrupt"),
      continuationSuppressed: true,
    };
    return [resultOf(next, [persistDirective(next.goal)], true), next];
  }
  return [resultOf(state, [], false), state];
}

function agentSettledTransition(
  state: GoalRuntimeState,
): [GoalOpResult, GoalRuntimeState] {
  let next: GoalRuntimeState = {
    ...state,
    agentRunActive: false,
    agentRunWasContinuation: false,
    agentRunToolCalls: 0,
    goalTurns: new Map(),
    turnStartTimes: new Map(),
    currentTurnIndex: undefined,
  };
  const directives: GoalDirective[] = [];

  // The aggregate run settled with a hard usage/quota limit still pending:
  // no retry occurred, so the state is genuinely terminal.
  if (next.pendingUsageLimited) {
    next = { ...next, pendingUsageLimited: false };
    if (next.goal?.status === "active") {
      next = {
        ...next,
        goal: setGoalStatus(next.goal, "usage-limited"),
        continuationSuppressed: true,
      };
      directives.push(persistDirective(next.goal));
      directives.push(notifyDirective("The provider usage limit stopped the active goal.", "warning"));
    }
  }

  if (state.agentRunActive && state.agentRunWasContinuation && state.agentRunToolCalls === 0) {
    // A continuation that only chatted must not spin forever. User input or
    // a tool call resets this guard.
    next = { ...next, continuationSuppressed: true };
  } else if (state.agentRunActive && state.agentRunToolCalls > 0) {
    next = { ...next, continuationSuppressed: false };
  }

  return [resultOf(next, directives, false), next];
}

function pauseTransition(
  state: GoalRuntimeState,
  reason: GoalPauseReason,
): [GoalOpResult, GoalRuntimeState] {
  if (!state.goal || state.goal.status !== "active") {
    return [resultOf(state, [], false), state];
  }
  const next: GoalRuntimeState = {
    ...state,
    goal: setGoalStatus(state.goal, "paused", Date.now(), reason),
    continuationSuppressed: true,
  };
  return [resultOf(next, [persistDirective(next.goal)], true), next];
}

function resumeTransition(state: GoalRuntimeState): [GoalOpResult, GoalRuntimeState] {
  if (!state.goal || state.goal.status !== "paused") {
    return [resultOf(state, [], false), state];
  }
  const nextStatus: GoalStatus =
    state.goal.tokenBudget !== undefined && state.goal.tokensUsed >= state.goal.tokenBudget
      ? "budget-limited"
      : "active";
  // Do not attach an in-flight turn that began while paused: work performed
  // under the paused goal is not goal work and must not be billed to the
  // resumed goal. Turns that start after activation are tracked by
  // turnStarted.
  const next: GoalRuntimeState = {
    ...state,
    goal: setGoalStatus(state.goal, nextStatus),
    continuationSuppressed: nextStatus !== "active",
    budgetSteeringGoalId: undefined,
  };
  return [resultOf(next, [persistDirective(next.goal)], true), next];
}

function setBudgetTransition(
  state: GoalRuntimeState,
  tokenBudget: number | undefined,
): readonly [TransitionOutcome<GoalError>, GoalRuntimeState] {
  if (!state.goal) {
    return [{ ok: false, error: new NoGoalError({ message: "No goal exists for this thread." }) }, state];
  }
  const budgetError = validateTokenBudget(tokenBudget);
  if (budgetError) {
    return [{ ok: false, error: new InvalidBudgetError({ message: budgetError }) }, state];
  }
  let nextStatus: GoalStatus = state.goal.status;
  if (state.goal.status === "active" && tokenBudget !== undefined && state.goal.tokensUsed >= tokenBudget) {
    // Only an active goal can newly become budget-limited.
    nextStatus = "budget-limited";
  } else if (
    state.goal.status === "budget-limited" &&
    (tokenBudget === undefined || state.goal.tokensUsed < tokenBudget)
  ) {
    // Raising the budget above usage, or clearing it, makes a
    // budget-limited goal runnable again.
    nextStatus = "active";
  }
  // Paused stays paused (resume enforces the cap), and terminal states
  // (blocked, usage-limited, complete) are never resurrected by a budget
  // change — in particular no two-step
  // terminal -> budget-limited -> active recovery exists.
  const goal: Goal = {
    ...state.goal,
    tokenBudget,
    status: nextStatus,
    updatedAt: Date.now(),
    ...(nextStatus !== state.goal.status ? { pauseReason: undefined } : {}),
  };
  let next: GoalRuntimeState = { ...state, goal };
  if (nextStatus !== "budget-limited") {
    next = { ...next, budgetSteeringGoalId: undefined };
  }
  if (nextStatus === "active") {
    // The user explicitly made the goal runnable; rearm continuation.
    next = { ...next, continuationSuppressed: false };
  }
  return [{ ok: true, result: resultOf(next, [persistDirective(goal)], true) }, next];
}

function createGoalTransition(
  state: GoalRuntimeState,
  objective: string,
  tokenBudget: number | undefined,
): readonly [TransitionOutcome<GoalError>, GoalRuntimeState] {
  if (!canCreateOver(state.goal)) {
    return [
      {
        ok: false,
        error: new UnfinishedGoalError({
          message:
            "An unfinished goal already exists. Use get_goal to inspect it; only a complete goal can be replaced by create_goal.",
        }),
      },
      state,
    ];
  }
  const outcome = validateNewGoal(objective, tokenBudget);
  if (!outcome.ok) return [{ ok: false, error: outcome.error }, state];
  const goal = createGoal(objective, tokenBudget);
  let next: GoalRuntimeState = {
    ...state,
    goal,
    continuationSuppressed: false,
    budgetSteeringGoalId: undefined,
  };
  // The model's own turn is the new goal's first turn.
  next = trackCurrentTurnGoal(next, goal);
  return [{ ok: true, result: resultOf(next, [persistDirective(goal)], true) }, next];
}

function replaceGoalTransition(
  state: GoalRuntimeState,
  objective: string,
  tokenBudget: number | undefined,
): readonly [TransitionOutcome<GoalError>, GoalRuntimeState] {
  const outcome = validateNewGoal(objective, tokenBudget);
  if (!outcome.ok) return [{ ok: false, error: outcome.error }, state];
  const goal = createGoal(objective, tokenBudget);
  const next: GoalRuntimeState = {
    ...state,
    goal,
    // The in-flight turn snapshot (if any) still belongs to the previous
    // goal and must not be re-pointed at the replacement.
    continuationSuppressed: false,
    continuationQueued: false,
    budgetSteeringGoalId: undefined,
  };
  return [{ ok: true, result: resultOf(next, [persistDirective(goal)], true) }, next];
}

function validateNewGoal(
  objective: string,
  tokenBudget: number | undefined,
): { readonly ok: true } | { readonly ok: false; readonly error: GoalError } {
  const objectiveError = validateObjective(objective);
  if (objectiveError) {
    return { ok: false, error: new InvalidObjectiveError({ message: objectiveError }) };
  }
  const budgetError = validateTokenBudget(tokenBudget);
  if (budgetError) {
    return { ok: false, error: new InvalidBudgetError({ message: budgetError }) };
  }
  return { ok: true };
}

function updateGoalStatusTransition(
  state: GoalRuntimeState,
  status: "complete" | "blocked",
): readonly [TransitionOutcome<GoalError>, GoalRuntimeState] {
  if (!state.goal) {
    return [{ ok: false, error: new NoGoalError({ message: "No goal exists for this thread." }) }, state];
  }
  if (state.goal.status === "complete") {
    return [{ ok: false, error: new AlreadyCompleteError({ message: "The goal is already complete." }) }, state];
  }
  const goal = setGoalStatus(state.goal, status);
  let next: GoalRuntimeState = {
    ...state,
    goal,
    continuationSuppressed: true,
    budgetSteeringGoalId: undefined,
  };
  if (status === "complete" && goal.tokenBudget !== undefined) {
    // The completion turn's usage is not persisted yet; the corrected
    // budget report is delivered as a steering message at turn_end.
    next = { ...next, pendingCompletionReportGoalId: goal.goalId };
  }
  return [{ ok: true, result: resultOf(next, [persistDirective(goal)], true) }, next];
}

function completeGoalTransition(
  state: GoalRuntimeState,
): [GoalOpResult, GoalRuntimeState] {
  if (!state.goal || state.goal.status === "complete") {
    return [resultOf(state, [], false), state];
  }
  const next: GoalRuntimeState = {
    ...state,
    goal: setGoalStatus(state.goal, "complete"),
    continuationSuppressed: true,
    budgetSteeringGoalId: undefined,
  };
  return [resultOf(next, [persistDirective(next.goal)], true), next];
}

function clearGoalTransition(state: GoalRuntimeState): [GoalOpResult, GoalRuntimeState] {
  const changed = state.goal !== null;
  const next: GoalRuntimeState = {
    ...state,
    goal: null,
    continuationSuppressed: true,
    continuationQueued: false,
    budgetSteeringGoalId: undefined,
  };
  return [resultOf(next, [persistDirective(null)], changed), next];
}

function queueContinuationTransition(
  state: GoalRuntimeState,
): readonly [readonly GoalDirective[], GoalRuntimeState] {
  if (!state.goal || state.goal.status !== "active") return [[], state];
  if (state.continuationSuppressed || state.continuationQueued) return [[], state];
  const next: GoalRuntimeState = { ...state, continuationQueued: true };
  return [
    [
      sendDirective(
        CONTINUATION_MESSAGE_TYPE,
        buildContinuationPrompt(state.goal),
        { goalId: state.goal.goalId },
        "followUp",
        true,
      ),
    ],
    next,
  ];
}

function steerBudgetTransition(
  state: GoalRuntimeState,
  goal: Goal,
): readonly [readonly GoalDirective[], GoalRuntimeState] {
  if (state.budgetSteeringGoalId === goal.goalId) return [[], state];
  const next: GoalRuntimeState = { ...state, budgetSteeringGoalId: goal.goalId };
  return [
    [
      sendDirective(
        BUDGET_MESSAGE_TYPE,
        buildBudgetLimitPrompt(goal),
        { goalId: goal.goalId },
        "steer",
        false,
      ),
    ],
    next,
  ];
}

// --- Runtime construction -------------------------------------------------------

const makeGoalRuntime = Effect.gen(function* () {
  const ref = yield* SynchronizedRef.make<GoalRuntimeState>(initialState());
  // Deterministic disposal: session_shutdown / reload / session replacement
  // runs the `close` operation, after which every operation fails fast with a
  // typed GoalRuntimeClosedError instead of mutating stale state. The runtime
  // owns no external resources (no processes, files, timers, or fibers), so
  // closing the flag IS the whole disposal; the ManagedRuntime itself is
  // garbage-collected with the extension instance. (Calling
  // ManagedRuntime.dispose() would additionally kill the runtime context and
  // turn the typed failure into an opaque "ManagedRuntime disposed" defect,
  // so it is deliberately not used.)
  const closed = MutableRef.make(false);

  const ensureOpen: Effect.Effect<void, GoalError> = Effect.suspend(() =>
    MutableRef.get(closed)
      ? Effect.fail(
          new GoalRuntimeClosedError({
            message: "Goal runtime is shut down; no further goal operations are accepted.",
          }),
        )
      : Effect.void,
  );

  /** One serialized atomic transition: compute [outcome, nextState] inside
   * the ref's semaphore; validations are part of the pure computation and
   * become typed failures without touching the state. */
  const transition = <E>(
    f: (s: GoalRuntimeState) => readonly [TransitionOutcome<E>, GoalRuntimeState],
  ): Effect.Effect<GoalOpResult, GoalError | E> =>
    ensureOpen.pipe(
      Effect.andThen(SynchronizedRef.modify(ref, f)),
      Effect.flatMap((outcome) =>
        outcome.ok ? Effect.succeed(outcome.result) : Effect.fail(outcome.error),
      ),
    );

  /** Transition that cannot fail (its outcome is always `ok`). */
  const transitionOk = (
    f: (s: GoalRuntimeState) => readonly [GoalOpResult, GoalRuntimeState],
  ): Effect.Effect<GoalOpResult, GoalError> =>
    transition((s) => {
      const [result, next] = f(s);
      return [{ ok: true, result }, next];
    });

  const update = (
    f: (s: GoalRuntimeState) => GoalRuntimeState,
  ): Effect.Effect<void, GoalError> =>
    ensureOpen.pipe(Effect.andThen(SynchronizedRef.update(ref, f)));

  return GoalRuntime.of({
    state: ensureOpen.pipe(Effect.andThen(SynchronizedRef.get(ref))),
    goal: ensureOpen.pipe(
      Effect.andThen(SynchronizedRef.get(ref)),
      Effect.map((state) => cloneGoal(state.goal)),
    ),
    loadFromBranch: (entries) => update((s) => loadFromBranchTransition(s, entries)),
    noteUserInput: (text) => update((s) => noteUserInputTransition(s, text)),
    steerPause: transitionOk((s) => steerPauseTransition(s, "interrupt")),
    agentStart: update(agentStartTransition),
    toolExecutionStarted: update(toolExecutionStartedTransition),
    turnStarted: (turnIndex, timestamp) =>
      update((s) => turnStartedTransition(s, turnIndex, timestamp)),
    turnEnded: (turnIndex, message, toolResults) =>
      transitionOk((s) => turnEndedTransition(s, turnIndex, message, toolResults)),
    agentEnded: (messages) => transitionOk((s) => agentEndedTransition(s, messages)),
    agentSettled: transitionOk(agentSettledTransition),
    pause: (reason) => transitionOk((s) => pauseTransition(s, reason)),
    resume: transitionOk(resumeTransition),
    setBudget: (tokenBudget) => transition((s) => setBudgetTransition(s, tokenBudget)),
    createGoal: (objective, tokenBudget) =>
      transition((s) => createGoalTransition(s, objective, tokenBudget)),
    replaceGoal: (objective, tokenBudget) =>
      transition((s) => replaceGoalTransition(s, objective, tokenBudget)),
    updateGoalStatus: (status) => transition((s) => updateGoalStatusTransition(s, status)),
    completeGoal: transitionOk(completeGoalTransition),
    clearGoal: transitionOk(clearGoalTransition),
    queueContinuation: ensureOpen.pipe(
      Effect.andThen(SynchronizedRef.modify(ref, queueContinuationTransition)),
    ),
    steerBudget: (goal) =>
      ensureOpen.pipe(
        Effect.andThen(SynchronizedRef.modify(ref, (s) => steerBudgetTransition(s, goal))),
      ),
    forgetBudgetSteering: update((s) => ({ ...s, budgetSteeringGoalId: undefined })),
    noteContinuationSendFailed: update((s) => ({ ...s, continuationQueued: false })),
    close: Effect.sync(() => MutableRef.set(closed, true)),
  });
});

export const GoalRuntimeLive: Layer.Layer<GoalRuntime> = Layer.effect(
  GoalRuntime,
  makeGoalRuntime,
);

// --- Adapter boundary helpers ----------------------------------------------------

/** One ManagedRuntime owned by the extension instance. On session shutdown,
 * the adapter runs the service's typed `close` operation; this runtime owns no
 * external resources that require ManagedRuntime disposal. */
export function createGoalRuntime() {
  return ManagedRuntime.make(GoalRuntimeLive);
}

export type GoalRuntimeInstance = ReturnType<typeof createGoalRuntime>;

/** Run a synchronous goal program. Typed failures and defects are converted
 * to thrown Errors (what pi's tool/command contract expects); the typed
 * GoalError instances are Error subclasses, so `error.message` stays
 * available to the imperative adapters. */
export function runGoalSync<A, E>(
  runtime: GoalRuntimeInstance,
  effect: Effect.Effect<A, E>,
): A {
  const exit = runtime.runSyncExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;
  const failure = Cause.findFail(exit.cause);
  if (Result.isSuccess(failure)) throw failure.success.error;
  const [first] = Cause.prettyErrors(exit.cause);
  throw new Error(first?.message ?? Cause.pretty(exit.cause));
}
