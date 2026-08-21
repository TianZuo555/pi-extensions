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
  readonly beginTurn: (
    modelId: string,
  ) => Effect.Effect<
    { resumeConversationId: string | undefined },
    AntigravityRuntimeClosedError
  >;
  readonly runTurn: (
    request: AgyTurnRequest,
  ) => Effect.Effect<AgyTurnOutcome, AntigravityRuntimeError>;
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
  let cwd: string | undefined;
  let turns = 0;
  let closed = false;

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

    beginTurn: (modelId) =>
      ensureOpen.pipe(
        Effect.andThen(
          Effect.sync(() => {
            if (model !== modelId) {
              conversationId = undefined;
              model = modelId;
            }
            return { resumeConversationId: conversationId };
          }),
        ),
      ),

    runTurn: (request) =>
      ensureOpen.pipe(
        Effect.flatMap(() =>
          Effect.tryPromise({
            try: () =>
              runAgyTurn({
                ...request,
                cwd: request.cwd ?? cwd,
                conversationId: request.conversationId ?? conversationId,
              }),
            catch: (cause) =>
              cause instanceof AgySpawnError
                ? new AntigravitySpawnError({ message: cause.message, stderr: cause.stderr })
                : new AntigravitySpawnError({
                    message: cause instanceof Error ? cause.message : String(cause),
                    stderr: "",
                  }),
          }),
        ),
        Effect.tap((outcome) =>
          Effect.sync(() => {
            turns += 1;
            if (outcome.conversationId) conversationId = outcome.conversationId;
          }),
        ),
      ),

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
