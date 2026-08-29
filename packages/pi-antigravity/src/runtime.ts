/**
 * AntigravityRuntime — Effect v4 service owning agy conversation continuity
 * and turn execution. The imperative spawn lives in lib/agy-client.ts; this
 * service adds typed errors, abort support, and mutable session state.
 *
 * Continuity policy: agy keeps its own authoritative conversation history
 * (`--conversation <id>`), so the conversation is reused across turns and
 * reset only when the selected model changes or the user asks (/agy reset).
 */

import { Context, Data, Effect, Layer, ManagedRuntime, Exit, Cause, Result } from "effect";
import {
  AgySpawnError,
  AgyStallError,
  runAgyTurn,
  type AgyTurnRequest,
} from "../lib/agy-client.ts";
import type { AgyTurnOutcome, AgyUsage } from "../lib/reducer.ts";
import { stallContinuationPrompt } from "../lib/prompt.ts";
import { AgyTurnController } from "../lib/turn.ts";

function envInt(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function waitForRetryBackoff(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    const onAbort = () => {
      if (timer !== undefined) clearTimeout(timer);
      resolve(false);
    };
    timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

const STALL_MAX_RETRIES = 2;

function isMissingConversationFailure(value: unknown): boolean {
  const text =
    value instanceof AgySpawnError
      ? `${value.message}\n${value.stderr}`
      : value instanceof Error
        ? value.message
        : String(value);
  return /conversation.{0,80}(?:not found|does not exist|missing|failed to (?:load|resume))|(?:not found|missing).{0,80}conversation/i.test(
    text,
  );
}

export class AntigravitySpawnError extends Data.TaggedError("AntigravitySpawnError")<{
  readonly message: string;
  readonly stderr: string;
}> {}

export class AntigravityRuntimeClosedError extends Data.TaggedError(
  "AntigravityRuntimeClosedError",
)<{
  readonly message: string;
}> {}

export type AntigravityRuntimeError = AntigravitySpawnError | AntigravityRuntimeClosedError;

export interface RestoredAntigravityConversation {
  conversationId: string;
  modelId: string;
  cwd: string;
  turns: number;
  usage: AgyUsage;
}

export interface AntigravityStateSnapshot {
  conversationId: string | undefined;
  model: string | undefined;
  cwd: string | undefined;
  turns: number;
  conversationUsage: AgyUsage;
}

export interface AntigravityRuntimeShape {
  readonly setSession: (
    cwd: string,
    modelId: string | undefined,
    restoreFromPiContext?: boolean,
  ) => Effect.Effect<void, AntigravityRuntimeClosedError>;
  /** Restore a persisted native agy conversation owned by this Pi session. */
  readonly restoreConversation: (
    state: RestoredAntigravityConversation,
  ) => Effect.Effect<void, AntigravityRuntimeClosedError>;
  /**
   * Start a new agy turn or re-attach to the active one. Re-attachment
   * happens when pi re-invokes the provider after a tool-use turn: the same
   * prompt maps to the still-running (or finished-but-unconsumed) controller.
   */
  readonly beginStreamTurn: (request: {
    readonly prompt: string;
    /** Active pi-branch history used only when a fresh agy conversation needs restoring. */
    readonly historyBootstrap?: string;
    /**
     * Extra prompt text appended ONLY when this request starts a fresh agy
     * conversation (bootstrap). agy keeps full conversation history, so
     * re-sending it on `--conversation` resumes would duplicate the block on
     * every user turn. Ignored on re-attach, and excluded from the re-attach
     * prompt match, which uses the base prompt.
     */
    readonly bootstrapSuffix?: string;
    readonly modelId: string;
    readonly effort?: "low" | "medium" | "high";
    readonly signal?: AbortSignal;
  }) => Effect.Effect<AgyTurnController, AntigravityRuntimeClosedError>;
  /** Clear the active controller once a provider turn reached a terminal state. */
  readonly finishTurn: Effect.Effect<void>;
  /**
   * Route a bridged agy MCP call into the live turn controller as a
   * synthetic bridge_call activity. Returns false when no turn is active
   * (the bridge then fails the MCP call closed).
   */
  readonly pushBridgeCall: (call: {
    readonly id: string;
    readonly tool: string;
    readonly args: Record<string, unknown>;
  }) => boolean;
  readonly reset: Effect.Effect<void, AntigravityRuntimeClosedError>;
  readonly snapshot: Effect.Effect<AntigravityStateSnapshot, AntigravityRuntimeClosedError>;
  readonly close: Effect.Effect<void, AntigravityRuntimeClosedError>;
}

export class AntigravityRuntime extends Context.Service<
  AntigravityRuntime,
  AntigravityRuntimeShape
>()("pi-antigravity/AntigravityRuntime") {}

export type AgyTurnRunner = (request: AgyTurnRequest) => Promise<AgyTurnOutcome>;

const makeRuntime = (turnRunner: AgyTurnRunner) =>
  Effect.gen(function* () {
    let conversationId: string | undefined;
    /** Terminal usage counters from the last turn; agy reports them cumulatively on resume. */
    let conversationUsage: AgyUsage = {};
    /** The cwd the conversation was created in — agy pins conversations to their workspace. */
    let conversationCwd: string | undefined;
    let model: string | undefined;
    // pi loads extensions with the session directory as process cwd; session_start
    // refreshes this, but the default keeps print mode and early turns correct.
    let cwd: string | undefined = process.cwd();
    let turns = 0;
    let closed = false;
    let active: AgyTurnController | undefined;
    /** Aborts the in-flight agy child process when the runtime closes. */
    let activeTurnAbort: AbortController | undefined;
    let generation = 0;
    let restoreHistoryOnNextConversation = false;
    let restoredConversationPending = false;
    let lastBootstrappedSkillsSuffix: string | undefined;

    const invalidateActiveTurn = () => {
      generation += 1;
      activeTurnAbort?.abort();
      activeTurnAbort = undefined;
      active = undefined;
    };

    const ensureOpen: Effect.Effect<void, AntigravityRuntimeClosedError> = Effect.suspend(() =>
      closed
        ? Effect.fail(
            new AntigravityRuntimeClosedError({
              message: "antigravity runtime is shut down.",
            }),
          )
        : Effect.void,
    );

    return AntigravityRuntime.of({
      setSession: (sessionCwd, modelId, restoreFromPiContext = false) =>
        ensureOpen.pipe(
          Effect.andThen(
            Effect.sync(() => {
              cwd = sessionCwd;
              if (modelId !== undefined) model = modelId;
              if (restoreFromPiContext) {
                invalidateActiveTurn();
                conversationId = undefined;
                conversationUsage = {};
                conversationCwd = undefined;
                turns = 0;
                restoreHistoryOnNextConversation = true;
                restoredConversationPending = false;
                lastBootstrappedSkillsSuffix = undefined;
              }
            }),
          ),
        ),

      restoreConversation: (state) =>
        ensureOpen.pipe(
          Effect.andThen(
            Effect.sync(() => {
              invalidateActiveTurn();
              conversationId = state.conversationId;
              conversationUsage = { ...state.usage };
              conversationCwd = state.cwd;
              model = state.modelId;
              cwd = state.cwd;
              turns = state.turns;
              restoreHistoryOnNextConversation = false;
              restoredConversationPending = true;
              lastBootstrappedSkillsSuffix = undefined;
            }),
          ),
        ),

      beginStreamTurn: (request) =>
        ensureOpen.pipe(
          Effect.andThen(
            Effect.sync(() => {
              if (
                active &&
                active.prompt === request.prompt &&
                (!active.isClosed() || active.hasPending())
              ) {
                return active;
              }
              if (active) invalidateActiveTurn();
              // agy pins a conversation to the workspace it was created in:
              // resuming it from another directory silently writes into the
              // OLD workspace (verified 2026-08-21) or rejects writes with
              // "not a valid artifact path". Start fresh when the project
              // changed instead of carrying a stale workspace binding.
              if (conversationId && conversationCwd !== cwd) {
                conversationId = undefined;
                conversationUsage = {};
                conversationCwd = undefined;
                restoreHistoryOnNextConversation = true;
                restoredConversationPending = false;
                lastBootstrappedSkillsSuffix = undefined;
              }
              if (model !== undefined && model !== request.modelId) {
                conversationId = undefined;
                conversationUsage = {};
                conversationCwd = undefined;
                restoreHistoryOnNextConversation = true;
                restoredConversationPending = false;
                lastBootstrappedSkillsSuffix = undefined;
              }
              model = request.modelId;
              const controller = new AgyTurnController(request.prompt, conversationUsage);
              active = controller;
              // Compose pi's request signal with our own so close() can kill
              // the agy child even when pi's signal never fires.
              const turnAbort = new AbortController();
              activeTurnAbort = turnAbort;
              const turnGeneration = generation;
              if (request.signal) {
                if (request.signal.aborted) turnAbort.abort();
                else
                  request.signal.addEventListener("abort", () => turnAbort.abort(), { once: true });
              }
              const resumingPersistedConversation =
                restoredConversationPending && conversationId !== undefined;
              const historyBootstrap =
                !conversationId && restoreHistoryOnNextConversation
                  ? request.historyBootstrap
                  : undefined;
              restoreHistoryOnNextConversation = false;
              // Direct-mode skill paths ride the prompt when the bridge is
              // disabled or registration failed. If the bridge was active
              // initially and later fails mid-conversation, or if the skill
              // catalog changes, the new suffix is appended even when an agy
              // conversation already exists. Suffixes already sent to the
              // current conversation are not duplicated on every turn.
              const bootstrapSuffix =
                request.bootstrapSuffix && request.bootstrapSuffix !== lastBootstrappedSkillsSuffix
                  ? request.bootstrapSuffix
                  : undefined;
              let restoredAttemptActive = resumingPersistedConversation;
              let restoredResultMissing = false;
              const freshRestorePrompt = [request.historyBootstrap, request.prompt, bootstrapSuffix]
                .filter((part): part is string => Boolean(part))
                .join("\n\n");
              const spawnRequest: AgyTurnRequest = {
                prompt: [historyBootstrap, request.prompt, bootstrapSuffix]
                  .filter((part): part is string => Boolean(part))
                  .join("\n\n"),
                conversationId,
                model: request.modelId,
                effort: request.effort,
                cwd,
                timeoutMs: envInt("AGY_TURN_TIMEOUT_MS", 600_000),
                inactivityTimeoutMs: envInt("AGY_STALL_TIMEOUT_MS", 120_000),
                toolInactivityTimeoutMs: envInt("AGY_TOOL_STALL_TIMEOUT_MS", 300_000),
                signal: turnAbort.signal,
                onConversation: (id) => {
                  if (turnGeneration !== generation) return;
                  // Track eagerly — a turn hung on a background task may never
                  // resolve, and /agy-tasks needs the id meanwhile.
                  conversationId = id;
                  conversationCwd = cwd;
                  // Prompt reached the conversation: commit the bootstrap suffix.
                  if (bootstrapSuffix) {
                    lastBootstrappedSkillsSuffix = bootstrapSuffix;
                  }
                },
                onActivity: (activity) => {
                  if (turnGeneration !== generation) return;
                  if (
                    restoredAttemptActive &&
                    activity.type === "result" &&
                    activity.status === "ERROR" &&
                    isMissingConversationFailure(activity.error)
                  ) {
                    // Do not expose a recoverable stale-resume error to Pi; the
                    // runner retries below with bounded branch history.
                    restoredResultMissing = true;
                    return;
                  }
                  controller.push(activity);
                },
              };
              /**
               * A stalled stream is recoverable: agy still holds the full
               * conversation server-side, so each retry resumes it with a
               * continuation prompt instead of re-bootstrapping pi history.
               * If no resumable conversation id exists (e.g. stalled before
               * init), retry with the original prompt instead of sending a
               * continuation-only prompt to a blank conversation.
               * Only AgyStallError retries — spawn/auth failures would just
               * fail identically again. Aborts are left to the signal path.
               */
              const runTurnWithStallRetries = async (): Promise<AgyTurnOutcome> => {
                let retry = 0;
                let freshFallback = false;
                for (;;) {
                  if (turnAbort.signal.aborted) throw new Error("agy turn was aborted.");
                  const resumableConversationId = conversationId ?? spawnRequest.conversationId;
                  const attempt: AgyTurnRequest =
                    freshFallback && retry === 0
                      ? {
                          ...spawnRequest,
                          prompt: freshRestorePrompt,
                          conversationId: undefined,
                        }
                      : retry === 0
                        ? spawnRequest
                        : {
                            ...spawnRequest,
                            prompt: resumableConversationId
                              ? stallContinuationPrompt()
                              : spawnRequest.prompt,
                            conversationId: resumableConversationId,
                          };
                  try {
                    const outcome = await turnRunner(attempt);
                    if (resumingPersistedConversation && !freshFallback && restoredResultMissing) {
                      restoredAttemptActive = false;
                      controller.push({ type: "conversation_fallback" });
                      conversationId = undefined;
                      conversationUsage = {};
                      conversationCwd = undefined;
                      restoredConversationPending = false;
                      freshFallback = true;
                      retry = 0;
                      continue;
                    }
                    return outcome;
                  } catch (error) {
                    if (turnAbort.signal.aborted) throw new Error("agy turn was aborted.");
                    if (
                      resumingPersistedConversation &&
                      !freshFallback &&
                      isMissingConversationFailure(error)
                    ) {
                      restoredAttemptActive = false;
                      controller.push({ type: "conversation_fallback" });
                      conversationId = undefined;
                      conversationUsage = {};
                      conversationCwd = undefined;
                      restoredConversationPending = false;
                      freshFallback = true;
                      retry = 0;
                      continue;
                    }
                    if (!(error instanceof AgyStallError) || retry >= STALL_MAX_RETRIES) {
                      throw error;
                    }
                    retry += 1;
                    controller.push({
                      type: "stall",
                      retry,
                      maxRetries: STALL_MAX_RETRIES,
                      stalledMs: error.stalledMs,
                      toolActive: error.toolActive,
                    });
                    const backoffMs = envInt("AGY_STALL_RETRY_BACKOFF_MS", 3_000);
                    if (!(await waitForRetryBackoff(backoffMs, turnAbort.signal))) {
                      throw new Error("agy turn was aborted.");
                    }
                  }
                }
              };
              void runTurnWithStallRetries()
                .then((outcome: AgyTurnOutcome) => {
                  if (turnGeneration !== generation) {
                    controller.close();
                    return;
                  }
                  turns += 1;
                  if (outcome.conversationId) conversationId = outcome.conversationId;
                  if (outcome.usage) conversationUsage = { ...outcome.usage };
                  restoredConversationPending = false;
                  if (bootstrapSuffix) {
                    lastBootstrappedSkillsSuffix = bootstrapSuffix;
                  }
                  controller.close();
                })
                .catch((cause: unknown) => {
                  if (turnGeneration !== generation) {
                    controller.close();
                    return;
                  }
                  controller.fail(cause instanceof Error ? cause : new Error(String(cause)));
                });
              return controller;
            }),
          ),
        ),

      finishTurn: Effect.sync(() => {
        if (active?.isClosed()) active = undefined;
      }),

      pushBridgeCall: (call) => {
        if (closed || !active || active.isClosed()) return false;
        active.push({ type: "bridge_call", id: call.id, name: call.tool, args: call.args });
        return true;
      },

      reset: ensureOpen.pipe(
        Effect.andThen(
          Effect.sync(() => {
            invalidateActiveTurn();
            conversationId = undefined;
            conversationUsage = {};
            conversationCwd = undefined;
            turns = 0;
            restoreHistoryOnNextConversation = false;
            restoredConversationPending = false;
            lastBootstrappedSkillsSuffix = undefined;
          }),
        ),
      ),

      snapshot: Effect.suspend(() =>
        ensureOpen.pipe(
          Effect.map(() => ({
            conversationId,
            model,
            cwd,
            turns,
            conversationUsage: { ...conversationUsage },
          })),
        ),
      ),

      close: Effect.suspend(() =>
        ensureOpen.pipe(
          Effect.andThen(
            Effect.sync(() => {
              closed = true;
              conversationId = undefined;
              conversationUsage = {};
              conversationCwd = undefined;
              restoredConversationPending = false;
              lastBootstrappedSkillsSuffix = undefined;
              // Kill any in-flight agy child process immediately.
              invalidateActiveTurn();
            }),
          ),
        ),
      ),
    });
  });

const runtimeLayer = (turnRunner: AgyTurnRunner): Layer.Layer<AntigravityRuntime> =>
  Layer.effect(AntigravityRuntime, makeRuntime(turnRunner));

export const AntigravityRuntimeLive: Layer.Layer<AntigravityRuntime> = runtimeLayer(runAgyTurn);

export function createAntigravityRuntime(turnRunner: AgyTurnRunner = runAgyTurn) {
  return ManagedRuntime.make(runtimeLayer(turnRunner));
}

export type AntigravityRuntimeInstance = ReturnType<typeof createAntigravityRuntime>;

export async function runAntigravity<A, E>(
  runtime: AntigravityRuntimeInstance,
  effect: Effect.Effect<A, E>,
  options: { signal?: AbortSignal } = {},
): Promise<A> {
  const exit = await runtime.runPromiseExit(
    effect,
    options.signal ? { signal: options.signal } : undefined,
  );
  if (Exit.isSuccess(exit)) return exit.value;
  if (Cause.hasInterruptsOnly(exit.cause)) {
    throw new Error("antigravity operation was aborted.");
  }
  const failure = Cause.findFail(exit.cause);
  if (Result.isSuccess(failure)) throw failure.success.error;
  const [first] = Cause.prettyErrors(exit.cause);
  throw new Error(first?.message ?? Cause.pretty(exit.cause));
}
