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
import { DevinTurnController, type DevinTurnStats } from "./turn.ts";

export class DevinRuntimeClosedError extends Data.TaggedError("DevinRuntimeClosedError")<{
  readonly message: string;
}> {}

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
  client: { pid?: number; spawned: number; requestsSent: number; notificationsReceived: number };
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
}

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
  ) => Effect.Effect<DevinSummaryResult, DevinRuntimeClosedError | DevinSessionError>;
  /** Set the desired devin session mode (ask/plan/accept-edits/bypass). */
  readonly setMode: (
    modeId: string,
  ) => Effect.Effect<void, DevinRuntimeClosedError | DevinSessionError>;
  readonly reset: Effect.Effect<void, DevinRuntimeClosedError>;
  readonly snapshot: Effect.Effect<DevinStateSnapshot, DevinRuntimeClosedError>;
  readonly listSessions: Effect.Effect<
    DevinListSessionInfo[],
    DevinRuntimeClosedError | DevinSessionError
  >;
  readonly deleteSession: (
    sessionId: string,
  ) => Effect.Effect<void, DevinRuntimeClosedError | DevinSessionError>;
  readonly authenticate: (
    methodId: string,
  ) => Effect.Effect<void, DevinRuntimeClosedError | DevinSessionError>;
  readonly close: Effect.Effect<void, DevinRuntimeClosedError>;
}

export class DevinRuntime extends Context.Service<DevinRuntime, DevinRuntimeShape>()(
  "pi-devin/DevinRuntime",
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
    let lastSentSystemPrompt: string | undefined;
    let closed = false;
    let active: DevinTurnController | undefined;
    let activeAbort: AbortController | undefined;
    let generation = 0;

    const ensureClient = (): DevinAcpClient => {
      if (!client) {
        client = createClient();
        client.setOnClose(() => {
          const turn = active;
          active = undefined;
          turn?.fail(new Error("devin acp process exited."));
          client = undefined;
          sessionId = undefined;
          syncedModelId = undefined;
        });
        client.setCustomNotificationHandler((method, params) => {
          if (method !== "_cognition.ai/agent_stopped") return;
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
      configOptions = undefined;
      needsBootstrap = bootstrap;
      lastSentSystemPrompt = undefined;
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
      ensureClient().setSessionListener(id, (update) => {
        const activities = acpUpdateToActivities(update);
        applyStateUpdate(activities);
        for (const activity of activities) controller.push(activity);
      });
    };

    /**
     * Ensure a live ACP session for the current cwd. Loads the pending
     * persisted session when marked; falls back to session/new when the load
     * reports a missing session. The session listener must already be wired
     * to the turn controller so replayed state updates are captured.
     */
    const ensureSession = async (cwd: string, controller: DevinTurnController): Promise<string> => {
      const acp = ensureClient();
      await acp.ensureStarted();
      if (sessionId && sessionCwd === cwd && !pendingLoadId) {
        // Re-point the session listener at this turn's controller — the
        // previous turn's controller is closed.
        attachSessionListener(sessionId, controller);
        return sessionId;
      }
      if (sessionId && sessionCwd !== cwd) dropSession(true);
      if (pendingLoadId) {
        const loadId = pendingLoadId;
        sessionId = loadId;
        sessionCwd = cwd;
        attachSessionListener(loadId, controller);
        try {
          await acp.loadSession(loadId, cwd);
          return loadId;
        } catch {
          acp.setSessionListener(loadId, undefined);
          sessionId = undefined;
          syncedModelId = undefined;
          needsBootstrap = true;
          lastSentSystemPrompt = undefined;
        } finally {
          pendingLoadId = undefined;
        }
      }
      const created = await acp.newSession(cwd);
      sessionId = created.sessionId;
      sessionCwd = cwd;
      modeId = created.modes?.currentModeId ?? modeId;
      configOptions = created.configOptions ?? configOptions;
      attachSessionListener(created.sessionId, controller);
      return created.sessionId;
    };

    const syncConfig = async (id: string, concreteModelId: string): Promise<void> => {
      const acp = ensureClient();
      if (desiredModeId && desiredModeId !== modeId) {
        await acp.setMode(id, desiredModeId);
        modeId = desiredModeId;
      }
      if (concreteModelId && syncedModelId !== concreteModelId) {
        await acp.setConfigOption(id, "model", concreteModelId);
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
              invalidateActiveTurn();
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
                if (
                  active &&
                  active.prompt === request.prompt &&
                  (!active.isClosed() || active.hasPending())
                ) {
                  return active;
                }
                if (active) invalidateActiveTurn();

                const acp = ensureClient();
                await acp.ensureStarted();
                const controller = new DevinTurnController(request.prompt, "");
                const liveSessionId = await ensureSession(request.cwd, controller);
                controller.sessionId = liveSessionId;
                await syncConfig(liveSessionId, request.concreteModelId);

                model = request.modelId;

                const turnAbort = new AbortController();
                activeAbort = turnAbort;
                const turnGeneration = generation;
                if (request.signal) {
                  if (request.signal.aborted) turnAbort.abort();
                  else
                    request.signal.addEventListener("abort", () => turnAbort.abort(), {
                      once: true,
                    });
                }

                // Compose prompt blocks: bootstrap resources on fresh
                // sessions, an instruction snapshot when pi's system prompt
                // changed, then the request's content blocks.
                const blocks: ContentBlock[] = [];
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
                blocks.push(...request.blocks);
                needsBootstrap = false;

                const cancelled = new Promise<never>((_resolve, reject) => {
                  turnAbort.signal.addEventListener(
                    "abort",
                    () => reject(new Error("devin turn was aborted.")),
                    { once: true },
                  );
                  if (turnAbort.signal.aborted) {
                    reject(new Error("devin turn was aborted."));
                  }
                });

                const promptPromise = acp.prompt(liveSessionId, blocks);
                void Promise.race([promptPromise, cancelled])
                  .then((result) => {
                    if (turnGeneration !== generation) {
                      controller.close();
                      return;
                    }
                    turns += 1;
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
                  });

                turnAbort.signal.addEventListener(
                  "abort",
                  () => {
                    void acp.cancel(liveSessionId).catch(() => {});
                  },
                  { once: true },
                );

                active = controller;
                return controller;
              },
              catch: (error) => failSession(error),
            }),
          ),
        ),

      finishTurn: Effect.sync(() => {
        if (active?.isClosed()) active = undefined;
      }),

      runSummaryTurn: (prompt, signal) =>
        ensureOpen.pipe(
          Effect.andThen(
            Effect.tryPromise({
              try: async () => {
                const acp = ensureClient();
                await acp.ensureStarted();
                const created = await acp.newSession(sessionCwd ?? process.cwd());
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
                  signal?.addEventListener("abort", onAbort, { once: true });
                  try {
                    await Promise.race([
                      acp.prompt(created.sessionId, [{ type: "text", text: prompt }]),
                      new Promise<never>((_r, reject) =>
                        abort.signal.addEventListener(
                          "abort",
                          () => reject(new Error("devin summary turn aborted.")),
                          { once: true },
                        ),
                      ),
                    ]);
                  } finally {
                    signal?.removeEventListener("abort", onAbort);
                  }
                } finally {
                  acp.setSessionListener(created.sessionId, undefined);
                  void acp.deleteSession(created.sessionId).catch(() => {});
                }
                return { text: collected.join("") };
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
                desiredModeId = next;
                if (sessionId && !pendingLoadId) {
                  await ensureClient().setMode(sessionId, next);
                  modeId = next;
                }
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
                if (id === sessionId) dropSession(false);
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
