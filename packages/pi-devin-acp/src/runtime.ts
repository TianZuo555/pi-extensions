/**
 * DevinRuntime — Effect service owning the `devin acp` child process, the
 * pi-session ↔ ACP-session binding, and turn execution.
 *
 * Continuity policy: devin owns authoritative session history server-side
 * (`session/load` resumes a persisted session), so the binding is reused
 * across turns and dropped only on /devin reset, a pi branch move, or a
 * failed load.
 */

import { randomUUID } from "node:crypto";
import { Context, Data, Effect, Layer, ManagedRuntime, Exit, Cause, Result } from "effect";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import type {
  DevinAcpClient,
  DevinConfigOption,
  DevinListSessionInfo,
  DevinPromptResult,
} from "../lib/acp-client.ts";
import {
  HISTORY_RESOURCE_URI,
  INSTRUCTIONS_RESOURCE_URI,
  piSystemInstructionsPrompt,
  restoredPiContextPrompt,
} from "../lib/prompt.ts";
import {
  acpUpdateToActivities,
  agentStoppedToActivity,
  connectionRetryToActivity,
  turnStatsToDimensions,
  turnStatsToUsage,
} from "./updates.ts";
import {
  DevinTurnController,
  mergeDevinUsage,
  TERMINAL_TOOL_STATUSES,
  type DevinActivity,
  type DevinTurnStats,
  type DevinUsage,
} from "./turn.ts";
import type { DevinToolView } from "../lib/tool-content.ts";

export class DevinRuntimeClosedError extends Data.TaggedError("DevinRuntimeClosedError")<{
  readonly message: string;
}> {}

/**
 * How long a superseded turn may hold up the next prompt while its
 * `session/cancel` is acknowledged. Live devin settles in 5–10 ms; the bound
 * only exists so a wedged agent cannot block a new turn forever.
 */
const SUPERSEDE_SETTLE_TIMEOUT_MS = 3_000;

/**
 * A connection_retry state is only reported while fresh: devin notifies once
 * per attempt and recovery is signalled implicitly by resumed updates, so a
 * retry that arrived between turns would otherwise linger forever.
 */
const RETRY_STALE_MS = 30_000;

/** Activity kinds that prove the backend stream is alive after a retry. */
const PROGRESS_ACTIVITY_TYPES = new Set<DevinActivity["type"]>([
  "text",
  "thought",
  "tool_start",
  "tool_update",
  "plan",
  "compaction",
]);

export class DevinSessionError extends Data.TaggedError("DevinSessionError")<{
  readonly message: string;
}> {}

export type DevinRuntimeError = DevinRuntimeClosedError | DevinSessionError;

export interface DevinSessionBindingState {
  acpSessionId: string;
  cwd: string;
  modelId: string;
  turns: number;
  contextTokens?: number;
}

export interface DevinStateSnapshot {
  sessionId: string | undefined;
  title: string | undefined;
  model: string | undefined;
  /** Concrete devin model id synced into the ACP session. */
  concreteModel: string | undefined;
  modeId: string | undefined;
  cwd: string | undefined;
  turns: number;
  contextTokens: number | undefined;
  contextSize: number | undefined;
  /** Latest cumulative usage_update snapshot (tokens, cost, dimensions). */
  usage: DevinUsage | undefined;
  configOptions: DevinConfigOption[] | undefined;
  availableCommands: { name: string; description?: string; hint?: string }[] | undefined;
  lastTurnStats: DevinTurnStats | undefined;
  /** Devin-side operations still in flight (long execs, detached shells). */
  liveOps: DevinLiveOp[];
  /** Present while devin is retrying its backend stream (fresh only). */
  retry: DevinRetryState | undefined;
  client: { pid?: number; spawned: number; requestsSent: number; notificationsReceived: number };
}

/** A tool call devin has not finished — may still run past the turn's end. */
export interface DevinLiveOp {
  view: DevinToolView;
  startedAt: number;
}

/** Latest `_cognition.ai/connection_retry` state for the bound session. */
export interface DevinRetryState {
  attempt: number;
  maxAttempts?: number;
  isStreamRetry?: boolean;
  /** When the latest retry notification arrived (Date.now). */
  at: number;
}

export interface DevinTurnRequest {
  /** Base user prompt text (used for re-attach matching). */
  readonly prompt: string;
  /** Full ACP content blocks for the prompt (text + images + bootstrap). */
  readonly blocks: ContentBlock[];
  /** Pi model id (group) this turn is for. */
  readonly modelId: string;
  /** Concrete devin model id resolved from the group + thinking level. */
  readonly concreteModelId: string;
  readonly cwd: string;
  readonly systemPrompt?: string;
  /** Serialized pi history, sent only when the session needs bootstrapping. */
  readonly historyBootstrap?: string;
  readonly signal?: AbortSignal;
  /** Inspect or replace the outgoing ACP prompt before it is sent. */
  readonly transformPrompt?: DevinPromptTransform;
}

/** The outgoing ACP prompt request, as seen by pi's payload hook. */
export interface DevinPromptRequest {
  sessionId: string;
  prompt: ContentBlock[];
}

/**
 * pi's `before_provider_request` equivalent: return replacement content blocks
 * to send instead, or undefined to keep the prompt unchanged.
 */
export type DevinPromptTransform = (
  request: DevinPromptRequest,
) => ContentBlock[] | undefined | Promise<ContentBlock[] | undefined>;

export interface DevinSummaryResult {
  text: string;
  /** Per-turn usage of the throwaway summary session, when it completed. */
  usage?: DevinUsage;
}

export interface DevinRuntimeShape {
  /** Point the runtime at a cwd; a changed cwd drops the session binding. */
  readonly setSession: (
    cwd: string,
    opts?: { rebootstrap?: boolean },
  ) => Effect.Effect<void, DevinRuntimeClosedError>;
  /** Mark a persisted ACP session for lazy `session/load` on the next turn. */
  readonly restoreSession: (
    state: DevinSessionBindingState,
  ) => Effect.Effect<void, DevinRuntimeClosedError>;
  /** Start a devin turn or re-attach to the still-running one. */
  readonly beginStreamTurn: (
    request: DevinTurnRequest,
  ) => Effect.Effect<DevinTurnController, DevinRuntimeClosedError | DevinSessionError>;
  readonly finishTurn: Effect.Effect<void>;
  /** Run a standalone prompt in a throwaway ACP session (pi summaries). */
  readonly runSummaryTurn: (
    prompt: string,
    signal?: AbortSignal,
    modelId?: string,
    transformPrompt?: DevinPromptTransform,
  ) => Effect.Effect<DevinSummaryResult, DevinRuntimeClosedError | DevinSessionError>;
  /** Set the desired devin session mode (ask/plan/accept-edits/bypass). */
  readonly setMode: (
    modeId: string,
  ) => Effect.Effect<void, DevinRuntimeClosedError | DevinSessionError>;
  readonly reset: Effect.Effect<void, DevinRuntimeClosedError>;
  /**
   * Kill the ACP child process and drop all session state while keeping the
   * runtime usable: the extension instance survives pi /new, /resume, and
   * /fork (extensions are cached across session replacement), so only quit
   * and reload may close it for good. Unlike a crashed child, no lazy
   * session/load retry is queued — the dropped binding stays dropped.
   */
  readonly suspend: Effect.Effect<void, DevinRuntimeClosedError>;
  /** Subscribe to session activities (for UI surfaces like live-op widgets). */
  readonly onActivity: (
    fn: (activity: DevinActivity) => void,
  ) => Effect.Effect<() => void, DevinRuntimeClosedError>;
  readonly snapshot: Effect.Effect<DevinStateSnapshot, DevinRuntimeClosedError>;
  readonly listSessions: Effect.Effect<
    DevinListSessionInfo[],
    DevinRuntimeClosedError | DevinSessionError
  >;
  /** Delete an ACP session; reports whether it was the bound one. */
  readonly deleteSession: (
    sessionId: string,
  ) => Effect.Effect<boolean, DevinRuntimeClosedError | DevinSessionError>;
  /**
   * Drop a live-op entry locally without asking devin — for entries stranded
   * by missed terminal updates. If the op is genuinely still running, its
   * next update re-adds it.
   */
  readonly dismissOp: (toolCallId: string) => Effect.Effect<boolean, DevinRuntimeClosedError>;
  readonly authenticate: (
    methodId: string,
  ) => Effect.Effect<void, DevinRuntimeClosedError | DevinSessionError>;
  readonly close: Effect.Effect<void, DevinRuntimeClosedError>;
}

export class DevinRuntime extends Context.Service<DevinRuntime, DevinRuntimeShape>()(
  "pi-devin-acp/DevinRuntime",
) {}

export type DevinClientFactory = () => DevinAcpClient;

const makeRuntime = (createClient: DevinClientFactory) =>
  Effect.gen(function* () {
    let client: DevinAcpClient | undefined;
    let sessionId: string | undefined;
    let sessionCwd: string | undefined;
    let model: string | undefined;
    let modeId: string | undefined;
    let desiredModeId: string | undefined;
    let title: string | undefined;
    let turns = 0;
    let contextTokens: number | undefined;
    let contextSize: number | undefined;
    let usage: DevinUsage | undefined;
    let configOptions: DevinConfigOption[] | undefined;
    let availableCommands: DevinStateSnapshot["availableCommands"];
    let lastTurnStats: DevinTurnStats | undefined;
    /** Concrete devin model id the live session was last synced to. */
    let syncedModelId: string | undefined;
    /** Session marked for lazy load on the next turn. */
    let pendingLoadId: string | undefined;
    let needsBootstrap = false;
    /** Devin-side tool calls still in flight; keyed by toolCallId. */
    const liveOps = new Map<string, DevinLiveOp>();
    /**
     * Ids that already reached a terminal state. Devin re-emits non-terminal
     * tool_call_update for a finished exec when a later get_output read (or
     * late PTY output) touches its session — without tombstoning, the stale
     * update resurrects the op as "running" forever.
     */
    const closedOps = new Set<string>();
    const CLOSED_OPS_LIMIT = 4_000;
    /** Latest backend-stream retry state for the bound session. */
    let retry: DevinRetryState | undefined;
    const activitySubscribers = new Set<(activity: DevinActivity) => void>();
    let lastSentSystemPrompt: string | undefined;
    /** Monotonic sequence of committed instruction snapshots on this binding.
     * Late completions of older requests must not overwrite newer commits.
     */
    let instructionSeq = 0;
    let closed = false;
    let active: DevinTurnController | undefined;
    let activeAbort: AbortController | undefined;
    let generation = 0;
    // Unlike turn generation, this survives supersession within one binding.
    let bindingGeneration = 0;
    /** Settles when the last started ACP prompt request finishes. */
    let activePromptSettled: Promise<void> | undefined;

    const ensureClient = (): DevinAcpClient => {
      if (!client) {
        const created = createClient();
        client = created;
        created.setOnClose(() => {
          // A delayed exit from a replaced process must not clobber the
          // binding a newer client already established.
          if (client !== created) return;
          invalidateActiveTurn();
          // The dead child took its in-turn ops with it; nothing can report
          // their terminal state now, and session/load replays are dropped.
          liveOps.clear();
          closedOps.clear();
          retry = undefined;
          if (sessionId && !pendingLoadId) {
            // Devin persists sessions server-side: retry session/load on the
            // next turn; its failure path falls back to a fresh session
            // bootstrapped from pi history.
            pendingLoadId = sessionId;
          }
          sessionId = undefined;
          syncedModelId = undefined;
          client = undefined;
        });
        created.setCustomNotificationHandler((method, params) => {
          if (client !== created) return;
          if (method === "_cognition.ai/agent_stopped") {
            const activity = agentStoppedToActivity(params);
            if (activity?.type !== "stopped") return;
            retry = undefined;
            lastTurnStats = activity.stats;
            active?.push(activity);
          } else if (method === "_cognition.ai/connection_retry") {
            const activity = connectionRetryToActivity(params);
            if (activity?.type !== "retry") return;
            const target = (params as { sessionId?: unknown }).sessionId;
            // Only the bound session's retries are surfaced; a foreign
            // target (e.g. a throwaway summary session) is ignored.
            if (!sessionId || (typeof target === "string" && target !== sessionId)) return;
            retry = {
              attempt: activity.attempt,
              maxAttempts: activity.maxAttempts,
              isStreamRetry: activity.isStreamRetry,
              at: Date.now(),
            };
            active?.push(activity);
            notifySubscribers(activity);
          } else if (method === "_cognition.ai/turn_stats") {
            // Carries only response dimensions (also replayed on load) —
            // merge them into the existing stats instead of replacing.
            const dimensions = turnStatsToDimensions(params);
            if (dimensions) lastTurnStats = { ...(lastTurnStats ?? {}), dimensions };
            // The cumulative token sums are the turn's authoritative
            // billable usage (every internal request, not just the last).
            // turnClientMessageId ties them to the owning turn: replayed
            // or superseded-turn stats carry other ids and stay state-only.
            const stats = turnStatsToUsage(params);
            if (
              stats?.usage &&
              stats.clientMessageId !== undefined &&
              stats.clientMessageId === active?.turnClientMessageId
            ) {
              active?.push({ type: "usage", usage: stats.usage });
            }
          }
        });
      }
      return client;
    };

    const invalidateActiveTurn = () => {
      generation += 1;
      activeAbort?.abort();
      activeAbort = undefined;
      if (active) {
        const turn = active;
        active = undefined;
        turn.fail(new Error("devin turn was superseded."));
      }
    };

    /**
     * `session/cancel` is a notification: devin answers the in-flight prompt
     * with stopReason "cancelled" a few ms later. Prompting again before that
     * lands makes devin cancel the NEW prompt instead — the request is dropped
     * and the caller sees an empty aborted turn. Wait (bounded) for the
     * cancelled prompt to settle before reusing the session.
     */
    const settleSupersededPrompt = async (): Promise<void> => {
      const pending = activePromptSettled;
      if (!pending) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          pending,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, SUPERSEDE_SETTLE_TIMEOUT_MS);
            timer.unref?.();
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };

    const dropSession = (bootstrap: boolean) => {
      bindingGeneration += 1;
      invalidateActiveTurn();
      if (sessionId && client) {
        const id = sessionId;
        client.setSessionListener(id, undefined);
      }
      sessionId = undefined;
      sessionCwd = undefined;
      syncedModelId = undefined;
      pendingLoadId = undefined;
      turns = 0;
      contextTokens = undefined;
      contextSize = undefined;
      usage = undefined;
      title = undefined;
      model = undefined;
      modeId = undefined;
      configOptions = undefined;
      availableCommands = undefined;
      lastTurnStats = undefined;
      needsBootstrap = bootstrap;
      lastSentSystemPrompt = undefined;
      liveOps.clear();
      closedOps.clear();
      retry = undefined;
    };

    const ensureOpen: Effect.Effect<void, DevinRuntimeClosedError> = Effect.suspend(() =>
      closed
        ? Effect.fail(new DevinRuntimeClosedError({ message: "devin runtime is shut down." }))
        : Effect.void,
    );

    const failSession = (error: unknown): DevinSessionError =>
      new DevinSessionError({
        message: error instanceof Error ? error.message : String(error),
      });

    /** Apply a prompt transform, ignoring empty or non-block replacements. */
    const applyPromptTransform = async (
      transform: DevinPromptTransform | undefined,
      sessionId: string,
      prompt: ContentBlock[],
    ): Promise<ContentBlock[]> => {
      if (!transform) return prompt;
      const replaced = await transform({ sessionId, prompt });
      return Array.isArray(replaced) && replaced.length > 0 ? replaced : prompt;
    };

    /**
     * Track in-flight devin operations across turns: a backgrounded shell or
     * a slow exec stays listed until its terminal status (or terminal_exit)
     * arrives — which may happen between turns, through the live listener.
     */
    const trackLiveOp = (activity: DevinActivity) => {
      if (activity.type !== "tool_start" && activity.type !== "tool_update") return;
      const view = activity.view;
      if (closedOps.has(view.id)) return;
      const prev = liveOps.get(view.id);
      const merged = prev ? { ...prev.view, ...view } : view;
      if (TERMINAL_TOOL_STATUSES.has(merged.status ?? "") || merged.exitCode !== undefined) {
        liveOps.delete(view.id);
        if (closedOps.size >= CLOSED_OPS_LIMIT) {
          closedOps.delete(closedOps.values().next().value as string);
        }
        closedOps.add(view.id);
      } else {
        liveOps.set(view.id, { view: merged, startedAt: prev?.startedAt ?? Date.now() });
      }
    };

    const notifySubscribers = (activity: DevinActivity) => {
      for (const fn of activitySubscribers) {
        try {
          fn(activity);
        } catch {
          // A UI subscriber must never break the turn pipeline.
        }
      }
    };

    /**
     * Apply state-only updates (mode/config/title/commands/usage) arriving
     * outside a turn — including the tail of a session/load replay.
     */
    const applyStateUpdate = (activities: ReturnType<typeof acpUpdateToActivities>) => {
      for (const activity of activities) {
        if (activity.type === "mode") modeId = activity.modeId;
        else if (activity.type === "config") configOptions = activity.options;
        else if (activity.type === "title") title = activity.title;
        else if (activity.type === "commands") availableCommands = activity.commands;
        else if (activity.type === "usage") {
          usage = mergeDevinUsage(usage, activity.usage);
          contextTokens = usage.contextUsed;
          contextSize = usage.contextSize;
        }
      }
    };

    /**
     * Wire a controller to a session's update stream. Pass undefined for a
     * state-only listener (the session/load replay tail): replayed updates
     * still refresh the snapshot, but they are the loaded session's stored
     * state — not this turn's activity — so they must not reach the turn's
     * usage accounting.
     */
    const attachSessionListener = (id: string, controller: DevinTurnController | undefined) => {
      const acp = ensureClient();
      const listenerGeneration = generation;
      acp.setSessionListener(id, (update) => {
        if (client !== acp || sessionId !== id) return;
        const activities = acpUpdateToActivities(update);
        const deliver = generation === listenerGeneration;
        // State updates are session-scoped and ordering-sensitive: a stale
        // turn's trailing usage must not regress the newer turn's numbers.
        if (deliver) applyStateUpdate(activities);
        for (const activity of activities) {
          if (PROGRESS_ACTIVITY_TYPES.has(activity.type)) retry = undefined;
          // Session-scoped bookkeeping keeps running through supersession:
          // devin emits terminal tool updates right after a cancel, exactly
          // when the listener generation is stale — dropping them here would
          // strand the ops in liveOps forever.
          trackLiveOp(activity);
          notifySubscribers(activity);
          if (deliver) controller?.push(activity);
        }
      });
    };

    /**
     * Ensure a live ACP session for the current cwd. Loads the pending
     * persisted session when marked; falls back to session/new when the load
     * reports a missing session. Listeners stay state-only through setup —
     * the caller points one at the turn controller when the prompt goes out.
     */
    const ensureSession = async (cwd: string, check: () => void): Promise<string> => {
      const acp = ensureClient();
      await acp.ensureStarted();
      check();
      if (sessionId && sessionCwd === cwd && !pendingLoadId) {
        // The previous turn's listener is still attached; its controller is
        // closed, so stale updates are absorbed until the prompt attaches.
        return sessionId;
      }
      if (pendingLoadId) {
        const loadId = pendingLoadId;
        sessionId = loadId;
        sessionCwd = cwd;
        // The replay tail is the loaded session's stored state. Feeding its
        // usage snapshot to the fresh turn seeds the turn's billable total
        // with prior-turn totals — a turn aborted before live usage arrives
        // would persist them again, double-billing them in pi's session log.
        attachSessionListener(loadId, undefined);
        try {
          await acp.loadSession(loadId, cwd);
          check();
          pendingLoadId = undefined;
          return loadId;
        } catch {
          // Cancellation/supersession is not a missing session. Never let
          // an old load clear a newer binding or fall back to session/new.
          check();
          pendingLoadId = undefined;
          acp.setSessionListener(loadId, undefined);
          sessionId = undefined;
          syncedModelId = undefined;
          needsBootstrap = true;
          lastSentSystemPrompt = undefined;
          // The loaded session never materialized; drop its stale counters.
          turns = 0;
          contextTokens = undefined;
          contextSize = undefined;
          usage = undefined;
          title = undefined;
        }
      }
      const created = await acp.newSession(cwd);
      try {
        check();
      } catch (error) {
        // A cancelled session/new may still have created an empty remote session.
        void acp.deleteSession(created.sessionId).catch(() => {});
        throw error;
      }
      sessionId = created.sessionId;
      sessionCwd = cwd;
      modeId = created.modes?.currentModeId ?? modeId;
      configOptions = created.configOptions ?? configOptions;
      // State-only until the prompt attaches the turn controller below.
      attachSessionListener(created.sessionId, undefined);
      return created.sessionId;
    };

    const syncConfig = async (
      id: string,
      concreteModelId: string,
      check: () => void,
    ): Promise<void> => {
      const acp = ensureClient();
      if (desiredModeId && desiredModeId !== modeId) {
        const next = desiredModeId;
        await acp.setMode(id, next);
        check();
        modeId = next;
      }
      if (concreteModelId && syncedModelId !== concreteModelId) {
        await acp.setConfigOption(id, "model", concreteModelId);
        check();
        syncedModelId = concreteModelId;
      }
    };

    return DevinRuntime.of({
      setSession: (cwd, opts) =>
        ensureOpen.pipe(
          Effect.andThen(
            Effect.sync(() => {
              const cwdChanged = sessionCwd !== undefined && sessionCwd !== cwd;
              if (opts?.rebootstrap || cwdChanged) {
                dropSession(true);
              }
              if (!sessionCwd) sessionCwd = cwd;
            }),
          ),
        ),

      restoreSession: (state) =>
        ensureOpen.pipe(
          Effect.andThen(
            Effect.sync(() => {
              dropSession(false);
              sessionId = state.acpSessionId;
              sessionCwd = state.cwd;
              model = state.modelId;
              turns = state.turns;
              contextTokens = state.contextTokens;
              pendingLoadId = state.acpSessionId;
              needsBootstrap = false;
              lastSentSystemPrompt = undefined;
              syncedModelId = undefined;
            }),
          ),
        ),

      beginStreamTurn: (request) =>
        ensureOpen.pipe(
          Effect.andThen(
            Effect.tryPromise({
              try: async () => {
                request.signal?.throwIfAborted();
                if (sessionCwd !== undefined && sessionCwd !== request.cwd) dropSession(true);
                if (
                  active &&
                  !activeAbort?.signal.aborted &&
                  active.prompt === request.prompt &&
                  (!active.isClosed() || active.hasPending())
                ) {
                  return active;
                }
                invalidateActiveTurn();
                await settleSupersededPrompt();
                request.signal?.throwIfAborted();
                const turnGeneration = generation;
                const turnAbort = new AbortController();
                activeAbort = turnAbort;
                const onAbort = () => turnAbort.abort();
                request.signal?.addEventListener("abort", onAbort, { once: true });
                const check = () => {
                  if (turnGeneration !== generation) throw new Error("devin turn was superseded.");
                  if (turnAbort.signal.aborted) throw new Error("devin turn was aborted.");
                };
                const cleanup = () => {
                  request.signal?.removeEventListener("abort", onAbort);
                  if (activeAbort === turnAbort) activeAbort = undefined;
                };
                const controller = new DevinTurnController(request.prompt, "");
                active = controller;
                try {
                  check();
                  const acp = ensureClient();
                  const liveSessionId = await ensureSession(request.cwd, check);
                  check();
                  controller.sessionId = liveSessionId;
                  await syncConfig(liveSessionId, request.concreteModelId, check);
                  check();
                  model = request.modelId;

                  // Compose prompt blocks: bootstrap resources on fresh
                  // sessions, an instruction snapshot when pi's system prompt
                  // changed, then the request's content blocks. A bare
                  // "/name args" prompt is a devin command — attaching
                  // resources makes devin treat it as plain text, so command
                  // turns carry no extras and leave bootstrap state pending
                  // for the next real turn.
                  const isCommandPrompt = /^\/\S/.test(request.prompt);
                  const blocks: ContentBlock[] = [];
                  let attachedSystemPrompt: string | undefined;
                  if (!isCommandPrompt) {
                    if (needsBootstrap && request.historyBootstrap) {
                      blocks.push({
                        type: "resource",
                        resource: {
                          uri: HISTORY_RESOURCE_URI,
                          mimeType: "text/plain",
                          text: restoredPiContextPrompt(request.historyBootstrap),
                        },
                      });
                    }
                    if (
                      request.systemPrompt !== undefined &&
                      request.systemPrompt !== lastSentSystemPrompt
                    ) {
                      blocks.push({
                        type: "resource",
                        resource: {
                          uri: INSTRUCTIONS_RESOURCE_URI,
                          mimeType: "text/plain",
                          text: piSystemInstructionsPrompt(request.systemPrompt),
                        },
                      });
                      attachedSystemPrompt = request.systemPrompt;
                    }
                  }
                  blocks.push(...request.blocks);

                  const outgoing = await applyPromptTransform(
                    request.transformPrompt,
                    liveSessionId,
                    blocks,
                  );
                  check();

                  const cancelled = new Promise<never>((_resolve, reject) => {
                    turnAbort.signal.addEventListener(
                      "abort",
                      () => {
                        void acp.cancel(liveSessionId).catch(() => {});
                        reject(new Error("devin turn was aborted."));
                      },
                      { once: true },
                    );
                  });

                  const promptBindingGeneration = bindingGeneration;
                  const promptInstructionSeq = ++instructionSeq;
                  // The turn's activity feed starts with its prompt: updates
                  // arriving earlier (load replay, a superseded turn's tail)
                  // are session state and must not seed the turn's usage.
                  attachSessionListener(liveSessionId, controller);
                  // Stamped on the prompt so devin echoes it as
                  // turnClientMessageId — the correlation key that lets the
                  // turn claim its cumulative turn_stats token sums.
                  controller.turnClientMessageId = randomUUID();
                  const promptPromise = acp.prompt(liveSessionId, outgoing, {
                    clientMessageId: controller.turnClientMessageId,
                  });
                  // Commit context state only once devin answers the prompt
                  // request — a transform-hook or transport failure leaves it
                  // pending so the next turn re-attaches the resources.
                  // Attached before activePromptSettled so a superseding turn
                  // (which waits on it) observes the committed state.
                  if (!isCommandPrompt) {
                    void promptPromise.then(
                      () => {
                        if (
                          closed ||
                          bindingGeneration !== promptBindingGeneration ||
                          client !== acp ||
                          sessionId !== liveSessionId
                        )
                          return;
                        needsBootstrap = false;
                        // Out-of-order commits are the only unsound case: an
                        // equal-or-newer snapshot is always current, and an
                        // older one must not overwrite a newer commit.
                        if (
                          attachedSystemPrompt !== undefined &&
                          promptInstructionSeq >= instructionSeq
                        ) {
                          lastSentSystemPrompt = attachedSystemPrompt;
                        }
                      },
                      () => {},
                    );
                  }
                  activePromptSettled = promptPromise.then(
                    () => undefined,
                    () => undefined,
                  );
                  void Promise.race([promptPromise, cancelled])
                    .then((result) => {
                      if (turnGeneration !== generation) {
                        controller.close();
                        return;
                      }
                      if (result.stopReason !== "cancelled") turns += 1;
                      retry = undefined;
                      controller.push({
                        type: "result",
                        stopReason: result.stopReason ?? "end_turn",
                        usage: {
                          inputTokens: result.usage?.inputTokens,
                          outputTokens: result.usage?.outputTokens,
                          cachedReadTokens: result.usage?.cachedReadTokens,
                          cachedWriteTokens: result.usage?.cachedWriteTokens,
                        },
                      });
                      controller.close();
                    })
                    .catch((cause: unknown) => {
                      if (turnGeneration !== generation) {
                        controller.close();
                        return;
                      }
                      controller.fail(cause instanceof Error ? cause : new Error(String(cause)));
                    })
                    .finally(cleanup);

                  return controller;
                } catch (error) {
                  cleanup();
                  controller.fail(error instanceof Error ? error : new Error(String(error)));
                  if (active === controller) active = undefined;
                  throw error;
                }
              },
              catch: (error) => failSession(error),
            }),
          ),
        ),

      finishTurn: Effect.sync(() => {
        if (active?.isClosed()) active = undefined;
      }),

      runSummaryTurn: (prompt, signal, modelId, transformPrompt) =>
        ensureOpen.pipe(
          Effect.andThen(
            Effect.tryPromise({
              try: async () => {
                const summaryGeneration = generation;
                const check = () => {
                  signal?.throwIfAborted();
                  if (closed || summaryGeneration !== generation) {
                    throw new Error("devin summary turn was superseded.");
                  }
                };
                check();
                const acp = ensureClient();
                await acp.ensureStarted();
                check();
                const created = await acp.newSession(sessionCwd ?? process.cwd());
                try {
                  check();
                  if (modelId) {
                    try {
                      await acp.setConfigOption(created.sessionId, "model", modelId);
                    } catch {
                      // Best-effort: a summary on the session default beats none.
                    }
                    check();
                  }
                  const collected: string[] = [];
                  let summaryUsage: DevinUsage | undefined;
                  acp.setSessionListener(created.sessionId, (update) => {
                    for (const activity of acpUpdateToActivities(update)) {
                      if (activity.type === "text") collected.push(activity.delta);
                      if (activity.type === "usage")
                        summaryUsage = mergeDevinUsage(summaryUsage, activity.usage);
                    }
                  });
                  try {
                    const abort = new AbortController();
                    const onAbort = () => {
                      abort.abort();
                      void acp.cancel(created.sessionId).catch(() => {});
                    };
                    const cancelled = new Promise<never>((_r, reject) =>
                      abort.signal.addEventListener(
                        "abort",
                        () => reject(new Error("devin summary turn aborted.")),
                        { once: true },
                      ),
                    );
                    signal?.addEventListener("abort", onAbort, { once: true });
                    let summaryResult: DevinPromptResult | undefined;
                    try {
                      const outgoing = await applyPromptTransform(
                        transformPrompt,
                        created.sessionId,
                        [{ type: "text", text: prompt }],
                      );
                      check();
                      summaryResult = await Promise.race([
                        acp.prompt(created.sessionId, outgoing),
                        cancelled,
                      ]);
                    } finally {
                      signal?.removeEventListener("abort", onAbort);
                    }
                    return {
                      text: collected.join(""),
                      usage: mergeDevinUsage(summaryUsage, summaryResult?.usage),
                    };
                  } finally {
                    acp.setSessionListener(created.sessionId, undefined);
                  }
                } finally {
                  void acp.deleteSession(created.sessionId).catch(() => {});
                }
              },
              catch: (error) => failSession(error),
            }),
          ),
        ),

      setMode: (next) =>
        ensureOpen.pipe(
          Effect.andThen(
            Effect.tryPromise({
              try: async () => {
                if (!["ask", "plan", "accept-edits", "bypass"].includes(next)) {
                  throw new Error(`Invalid devin mode: ${next}`);
                }
                const modeGeneration = generation;
                if (sessionId && !pendingLoadId) {
                  await ensureClient().setMode(sessionId, next);
                  if (generation !== modeGeneration)
                    throw new Error("devin session was superseded.");
                  modeId = next;
                }
                desiredModeId = next;
              },
              catch: (error) => failSession(error),
            }),
          ),
        ),

      reset: ensureOpen.pipe(
        Effect.andThen(
          Effect.sync(() => {
            desiredModeId = undefined;
            dropSession(false);
          }),
        ),
      ),

      suspend: ensureOpen.pipe(
        Effect.andThen(
          Effect.promise(async () => {
            invalidateActiveTurn();
            // Detach before close so the child-exit listener (which queues a
            // lazy session/load retry) sees a stale client and no-ops.
            const current = client;
            client = undefined;
            dropSession(true);
            if (current) await current.close();
          }),
        ),
      ),

      onActivity: (fn) =>
        ensureOpen.pipe(
          Effect.map(() => {
            activitySubscribers.add(fn);
            return () => {
              activitySubscribers.delete(fn);
            };
          }),
        ),

      snapshot: Effect.suspend(() =>
        ensureOpen.pipe(
          Effect.map(() => ({
            sessionId,
            title,
            model,
            concreteModel: syncedModelId,
            modeId,
            cwd: sessionCwd,
            turns,
            contextTokens,
            contextSize,
            usage,
            configOptions,
            availableCommands,
            lastTurnStats,
            liveOps: [...liveOps.values()],
            retry: retry && Date.now() - retry.at < RETRY_STALE_MS ? retry : undefined,
            client: client?.stats ?? {
              spawned: 0,
              requestsSent: 0,
              notificationsReceived: 0,
            },
          })),
        ),
      ),

      listSessions: ensureOpen.pipe(
        Effect.andThen(
          Effect.tryPromise({
            try: async () => {
              const acp = ensureClient();
              await acp.ensureStarted();
              return await acp.listSessions();
            },
            catch: (error) => failSession(error),
          }),
        ),
      ),

      dismissOp: (toolCallId) =>
        ensureOpen.pipe(Effect.andThen(Effect.sync(() => liveOps.delete(toolCallId)))),

      deleteSession: (id) =>
        ensureOpen.pipe(
          Effect.andThen(
            Effect.tryPromise({
              try: async () => {
                await ensureClient().deleteSession(id);
                const droppedBinding = id === sessionId;
                if (droppedBinding) dropSession(false);
                return droppedBinding;
              },
              catch: (error) => failSession(error),
            }),
          ),
        ),

      authenticate: (methodId) =>
        ensureOpen.pipe(
          Effect.andThen(
            Effect.tryPromise({
              try: async () => {
                const acp = ensureClient();
                await acp.ensureStarted();
                await acp.authenticate(methodId);
              },
              catch: (error) => failSession(error),
            }),
          ),
        ),

      close: Effect.suspend(() =>
        ensureOpen.pipe(
          Effect.andThen(
            Effect.promise(async () => {
              closed = true;
              invalidateActiveTurn();
              const current = client;
              client = undefined;
              sessionId = undefined;
              if (current) await current.close();
            }),
          ),
        ),
      ),
    });
  });

const runtimeLayer = (createClient: DevinClientFactory): Layer.Layer<DevinRuntime> =>
  Layer.effect(DevinRuntime, makeRuntime(createClient));

export function createDevinRuntime(createClient: DevinClientFactory) {
  return ManagedRuntime.make(runtimeLayer(createClient));
}

export type DevinRuntimeInstance = ReturnType<typeof createDevinRuntime>;

export async function runDevin<A, E>(
  runtime: DevinRuntimeInstance,
  effect: Effect.Effect<A, E>,
  options: { signal?: AbortSignal } = {},
): Promise<A> {
  const exit = await runtime.runPromiseExit(
    effect,
    options.signal ? { signal: options.signal } : undefined,
  );
  if (Exit.isSuccess(exit)) return exit.value;
  if (Cause.hasInterruptsOnly(exit.cause)) {
    throw new Error("devin operation was aborted.");
  }
  const failure = Cause.findFail(exit.cause);
  if (Result.isSuccess(failure)) throw failure.success.error;
  const [first] = Cause.prettyErrors(exit.cause);
  throw new Error(first?.message ?? Cause.pretty(exit.cause));
}
