/**
 * SubagentRuntime — Effect v4-owned supervisor lifecycle and run orchestration.
 *
 * The imperative `SubagentSupervisor` stays in `lib/supervisor.ts`; this service
 * wraps it with typed disposal and exposes run/cancel/apply as Effect programs.
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
} from "effect";
import type { SubagentRunResult } from "../lib/domain.ts";
import { SubagentBackendPool } from "../lib/backend-pool.ts";
import {
  SubagentSupervisor,
  type BackgroundCompleteHandler,
  type SubagentSupervisorOptions,
  type SupervisorRunInput,
} from "../lib/supervisor.ts";

export class SubagentRuntimeClosedError extends Data.TaggedError("SubagentRuntimeClosedError")<{
  readonly message: string;
}> {}

export class SubagentNotInitializedError extends Data.TaggedError("SubagentNotInitializedError")<{
  readonly message: string;
}> {}

export class SubagentRunError extends Data.TaggedError("SubagentRunError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

export type SubagentRuntimeError =
  | SubagentRuntimeClosedError
  | SubagentNotInitializedError
  | SubagentRunError;

export interface SubagentRuntimeShape {
  readonly init: (
    cwd: string,
    options?: SubagentSupervisorOptions,
    onBackgroundComplete?: BackgroundCompleteHandler,
  ) => Effect.Effect<void, SubagentRuntimeClosedError>;
  readonly run: (
    input: SupervisorRunInput,
  ) => Effect.Effect<SubagentRunResult, SubagentRuntimeError>;
  readonly cancelRun: (
    runId: string,
    reason?: string,
  ) => Effect.Effect<boolean, SubagentRuntimeError>;
  readonly applyPatch: (runId: string) => Effect.Effect<SubagentRunResult, SubagentRuntimeError>;
  readonly drainPendingResults: Effect.Effect<void, SubagentRuntimeError>;
  readonly supervisor: Effect.Effect<
    SubagentSupervisor,
    SubagentNotInitializedError | SubagentRuntimeClosedError
  >;
  readonly close: Effect.Effect<void, SubagentRuntimeClosedError>;
}

export class SubagentRuntime extends Context.Service<SubagentRuntime, SubagentRuntimeShape>()(
  "pi-subagents/SubagentRuntime",
) {}

const makeSubagentRuntime = Effect.gen(function* () {
  let supervisor: SubagentSupervisor | undefined;
  const closed = MutableRef.make(false);

  const ensureOpen: Effect.Effect<void, SubagentRuntimeClosedError> = Effect.suspend(() =>
    MutableRef.get(closed)
      ? Effect.fail(
          new SubagentRuntimeClosedError({
            message: "Subagent runtime is shut down; no further subagent operations are accepted.",
          }),
        )
      : Effect.void,
  );

  const requireSupervisor = ensureOpen.pipe(
    Effect.flatMap(() =>
      supervisor
        ? Effect.succeed(supervisor)
        : Effect.fail(
            new SubagentNotInitializedError({
              message: "Subagent supervisor is not initialized for this session.",
            }),
          ),
    ),
  );

  return SubagentRuntime.of({
    init: (cwd, options, onBackgroundComplete) =>
      ensureOpen.pipe(
        Effect.andThen(
          Effect.promise(async () => {
            if (supervisor) await supervisor.dispose();
            const artifactRoot = options?.artifactRoot;
            const backendPool = options?.backendPool ?? new SubagentBackendPool({ artifactRoot });
            supervisor = new SubagentSupervisor(cwd, undefined, {
              artifactRoot,
              backendPool,
            });
            supervisor.setBackgroundCompleteHandler(onBackgroundComplete);
          }),
        ),
      ),

    run: (input) =>
      requireSupervisor.pipe(
        Effect.flatMap((sv) =>
          Effect.tryPromise({
            try: () => sv.run(input),
            catch: (cause) =>
              new SubagentRunError({
                message: cause instanceof Error ? cause.message : String(cause),
                cause,
              }),
          }),
        ),
      ),

    cancelRun: (runId, reason) =>
      requireSupervisor.pipe(
        Effect.flatMap((sv) => Effect.sync(() => sv.cancelRun(runId, reason))),
      ),

    applyPatch: (runId) =>
      requireSupervisor.pipe(
        Effect.flatMap((sv) =>
          Effect.tryPromise({
            try: () => sv.applyPatch(runId),
            catch: (cause) =>
              new SubagentRunError({
                message: cause instanceof Error ? cause.message : String(cause),
                cause,
              }),
          }),
        ),
      ),

    drainPendingResults: requireSupervisor.pipe(
      Effect.flatMap((sv) =>
        Effect.sync(() => {
          sv.drainPendingResults();
        }),
      ),
    ),

    supervisor: requireSupervisor,

    close: ensureOpen.pipe(
      Effect.andThen(
        Effect.promise(async () => {
          MutableRef.set(closed, true);
          if (supervisor) await supervisor.dispose();
          supervisor = undefined;
        }),
      ),
    ),
  });
});

export const SubagentRuntimeLive: Layer.Layer<SubagentRuntime> = Layer.effect(
  SubagentRuntime,
  makeSubagentRuntime,
);

export function createSubagentRuntime() {
  return ManagedRuntime.make(SubagentRuntimeLive);
}

export type SubagentRuntimeInstance = ReturnType<typeof createSubagentRuntime>;

export async function runSubagent<A, E>(
  runtime: SubagentRuntimeInstance,
  effect: Effect.Effect<A, E>,
  options: { signal?: AbortSignal } = {},
): Promise<A> {
  const exit = await runtime.runPromiseExit(
    effect,
    options.signal ? { signal: options.signal } : undefined,
  );
  if (Exit.isSuccess(exit)) return exit.value;
  if (Cause.hasInterruptsOnly(exit.cause)) {
    throw new Error("Subagent operation was aborted.");
  }
  const failure = Cause.findFail(exit.cause);
  if (Result.isSuccess(failure)) throw failure.success.error;
  const [first] = Cause.prettyErrors(exit.cause);
  throw new Error(first?.message ?? Cause.pretty(exit.cause));
}

/** Convenience: resolve supervisor for imperative UI helpers. */
export async function getSupervisor(
  runtime: SubagentRuntimeInstance,
  service: SubagentRuntimeShape,
): Promise<SubagentSupervisor> {
  return runSubagent(runtime, service.supervisor);
}
