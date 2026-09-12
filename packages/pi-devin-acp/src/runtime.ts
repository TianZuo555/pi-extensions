/**
 * DevinRuntime — Effect service owning the `devin acp` child process, the
 * pi-session ↔ ACP-session binding, and turn execution.
 *
 * Continuity policy: devin owns authoritative session history server-side
 * (`session/load` resumes a persisted session), so the binding is reused
 * across turns and dropped only on /devin reset, a pi branch move, or a
 * failed load.
 */

import { Context, Data, Effect, Layer, ManagedRuntime, Exit, Cause, Result } from "effect";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import type { DevinAcpClient, DevinConfigOption, DevinListSessionInfo } from "../lib/acp-client.ts";
import {
  HISTORY_RESOURCE_URI,
  INSTRUCTIONS_RESOURCE_URI,
  piSystemInstructionsPrompt,
  restoredPiContextPrompt,
} from "../lib/prompt.ts";
import { acpUpdateToActivities, agentStoppedToActivity } from "./updates.ts";
import {
  DevinTurnController,
  TERMINAL_TOOL_STATUSES,
  type DevinActivity,
  type DevinTurnStats,
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
  configOptions: DevinConfigOption[] | undefined;
  availableCommands: { name: string; description?: string; hint?: string }[] | undefined;
  lastTurnStats: DevinTurnStats | undefined;
  /** Devin-side operations still in flight (long execs, detached shells). */
  liveOps: DevinLiveOp[];
  client: { pid?: number; spawned: number; requestsSent: number; notificationsReceived: number };
}

/** A tool call devin has not finished — may still run past the turn's end. */
export interface DevinLiveOp {
  view: DevinToolView;
  startedAt: number;
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
    const activitySubscribers = new Set<(activity: DevinActivity) => void>();
    let lastSentSystemPrompt: string | undefined;
    let closed = false;
    let active: DevinTurnController | undefined;
    let activeAbort: AbortController | undefined;
    let generation = 0;
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
          if (client !== created || method !== "_cognition.ai/agent_stopped") return;
          const activity = agentStoppedToActivity(params);
          if (activity?.type !== "stopped") return;
          lastTurnStats = activity.stats;
          active?.push(activity);
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
      title = undefined;
      model = undefined;
      modeId = undefined;
      configOptions = undefined;
      availableCommands = undefined;
      lastTurnStats = undefined;
      needsBootstrap = bootstrap;
      lastSentSystemPrompt = undefined;
      liveOps.clear();
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
      const prev = liveOps.get(view.id);
      const merged = prev ? { ...prev.view, ...view } : view;
      if (TERMINAL_TOOL_STATUSES.has(merged.status ?? "") || merged.exitCode !== undefined) {
        liveOps.delete(view.id);
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
          contextTokens = activity.usage.contextUsed ?? contextTokens;
          contextSize = activity.usage.contextSize ?? contextSize;
        }
      }
    };

    /** Wire a live controller to a session's update stream. */
    const attachSessionListener = (id: string, controller: DevinTurnController) => {
      const acp = ensureClient();
      const listenerGeneration = generation;
      acp.setSessionListener(id, (update) => {
        if (client !== acp || sessionId !== id || generation !== listenerGeneration) return;
        const activities = acpUpdateToActivities(update);
        applyStateUpdate(activities);
        for (const activity of activities) {
          trackLiveOp(activity);
          notifySubscribers(activity);
          controller.push(activity);
        }
      });
    };

    /**
     * Ensure a live ACP session for the current cwd. Loads the pending
     * persisted session when marked; falls back to session/new when the load
     * reports a missing session. The session listener must already be wired
     * to the turn controller so replayed state updates are captured.
     */
    const ensureSession = async (
      cwd: string,
      controller: DevinTurnController,
      check: () => void,
    ): Promise<string> => {
      const acp = ensureClient();
      await acp.ensureStarted();
      check();
      if (sessionId && sessionCwd === cwd && !pendingLoadId) {
        // Re-point the session listener at this turn's controller — the
        // previous turn's controller is closed.
        attachSessionListener(sessionId, controller);
        return sessionId;
      }
      if (pendingLoadId) {
        const loadId = pendingLoadId;
        sessionId = loadId;
        sessionCwd = cwd;
        attachSessionListener(loadId, controller);
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
      attachSessionListener(created.sessionId, controller);
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
                  const liveSessionId = await ensureSession(request.cwd, controller, check);
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
                      lastSentSystemPrompt = request.systemPrompt;
                    }
                    needsBootstrap = false;
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

                  const promptPromise = acp.prompt(liveSessionId, outgoing);
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
                      controller.push({
                        type: "result",
                        stopReason: result.stopReason ?? "end_turn",
                        usage: {
                          inputTokens: result.usage?.inputTokens,
                          outputTokens: result.usage?.outputTokens,
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
                  acp.setSessionListener(created.sessionId, (update) => {
                    for (const activity of acpUpdateToActivities(update)) {
                      if (activity.type === "text") collected.push(activity.delta);
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
                    try {
                      const outgoing = await applyPromptTransform(
                        transformPrompt,
                        created.sessionId,
                        [{ type: "text", text: prompt }],
                      );
                      check();
                      await Promise.race([acp.prompt(created.sessionId, outgoing), cancelled]);
                    } finally {
                      signal?.removeEventListener("abort", onAbort);
                    }
                  } finally {
                    acp.setSessionListener(created.sessionId, undefined);
                  }
                  return { text: collected.join("") };
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
            configOptions,
            availableCommands,
            lastTurnStats,
            liveOps: [...liveOps.values()],
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
