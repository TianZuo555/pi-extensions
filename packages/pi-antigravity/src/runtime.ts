/**
 * AntigravityRuntime — Effect v4 service owning agy conversation continuity
 * and turn execution. The imperative spawn lives in lib/agy-client.ts; this
 * service adds typed errors, abort support, and mutable session state.
 *
 * Continuity policy: agy keeps its own authoritative conversation history
 * (`--conversation <id>`), so the conversation is reused across turns and
 * reset only when the selected model changes or the user asks (/agy reset).
 */

import {
  Context,
  Data,
  Effect,
  Layer,
  ManagedRuntime,
  Exit,
  Cause,
  Result,
} from "effect";
import {
  AgySpawnError,
  runAgyTurn,
  type AgyTurnRequest,
} from "../lib/agy-client.ts";
import type { AgyTurnOutcome } from "../lib/reducer.ts";
import { AgyTurnController } from "../lib/turn.ts";

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

export interface AntigravityStateSnapshot {
  conversationId: string | undefined;
  model: string | undefined;
  cwd: string | undefined;
  turns: number;
}

export interface AntigravityRuntimeShape {
  readonly setSession: (
    cwd: string,
    modelId: string | undefined,
  ) => Effect.Effect<void, AntigravityRuntimeClosedError>;
  /**
   * Start a new agy turn or re-attach to the active one. Re-attachment
   * happens when pi re-invokes the provider after a tool-use turn: the same
   * prompt maps to the still-running (or finished-but-unconsumed) controller.
   */
  readonly beginStreamTurn: (request: {
    readonly prompt: string;
    readonly modelId: string;
    readonly effort: "low" | "medium" | "high";
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

const makeRuntime = Effect.gen(function* () {
  let conversationId: string | undefined;
  let model: string | undefined;
  // pi loads extensions with the session directory as process cwd; session_start
  // refreshes this, but the default keeps print mode and early turns correct.
  let cwd: string | undefined = process.cwd();
  let turns = 0;
  let closed = false;
  let active: AgyTurnController | undefined;
  /** Aborts the in-flight agy child process when the runtime closes. */
  let activeTurnAbort: AbortController | undefined;

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
    setSession: (sessionCwd, modelId) =>
      ensureOpen.pipe(
        Effect.andThen(
          Effect.sync(() => {
            cwd = sessionCwd;
            if (modelId !== undefined) model = modelId;
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
            active = undefined;
            if (model !== request.modelId) conversationId = undefined;
            model = request.modelId;
            const controller = new AgyTurnController(request.prompt);
            active = controller;
            // Compose pi's request signal with our own so close() can kill
            // the agy child even when pi's signal never fires.
            const turnAbort = new AbortController();
            activeTurnAbort = turnAbort;
            if (request.signal) {
              if (request.signal.aborted) turnAbort.abort();
              else
                request.signal.addEventListener(
                  "abort",
                  () => turnAbort.abort(),
                  { once: true },
                );
            }
            const spawnRequest: AgyTurnRequest = {
              prompt: request.prompt,
              conversationId,
              model: request.modelId,
              effort: request.effort,
              cwd,
              timeoutMs: 600_000,
              signal: turnAbort.signal,
              onConversation: (id) => {
                // Track eagerly — a turn hung on a background task may never
                // resolve, and /agy-tasks needs the id meanwhile.
                conversationId = id;
              },
              onActivity: (activity) => controller.push(activity),
            };
            void runAgyTurn(spawnRequest)
              .then((outcome: AgyTurnOutcome) => {
                turns += 1;
                if (outcome.conversationId) conversationId = outcome.conversationId;
                controller.close();
              })
              .catch((cause: unknown) => {
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
          conversationId = undefined;
          turns = 0;
        }),
      ),
    ),

    snapshot: Effect.suspend(() =>
      ensureOpen.pipe(
        Effect.map(() => ({ conversationId, model, cwd, turns })),
      ),
    ),

    close: Effect.suspend(() =>
      ensureOpen.pipe(
        Effect.andThen(
          Effect.sync(() => {
            closed = true;
            conversationId = undefined;
            // Kill any in-flight agy child process immediately.
            activeTurnAbort?.abort();
            activeTurnAbort = undefined;
          }),
        ),
      ),
    ),
  });
});

export const AntigravityRuntimeLive: Layer.Layer<AntigravityRuntime> = Layer.effect(
  AntigravityRuntime,
  makeRuntime,
);

export function createAntigravityRuntime() {
  return ManagedRuntime.make(AntigravityRuntimeLive);
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
