/**
 * UsageRuntime — Effect v4-owned cache, in-flight dedup, and provider queries.
 *
 * HTTP fetch, normalization, cache, and same-provider dedup all run inside one
 * ManagedRuntime graph. Promise wrappers exist only at the pi adapter boundary
 * (auth resolution) and public test helpers.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  Cause,
  Context,
  Data,
  Deferred,
  Effect,
  Exit,
  FiberSet,
  Layer,
  ManagedRuntime,
  MutableRef,
  Result,
  SynchronizedRef,
} from "effect";
import type { ResolvedToken } from "../lib/auth.ts";
import type { ProviderState } from "../lib/format.ts";
import type { ProviderReport } from "../lib/providers.ts";
import type { ProviderQueryError } from "./fetch.ts";

export const CACHE_TTL_MS = 5 * 60 * 1000;

export interface ProviderQuerySpec {
  id: string;
  name: string;
  configureHint: string;
  hasLoginInfo: (ctx: ExtensionContext) => boolean;
  resolve: (ctx: ExtensionContext) => Promise<ResolvedToken | undefined>;
  queryEffect: (
    token: string,
    signal?: AbortSignal,
  ) => Effect.Effect<ProviderReport, ProviderQueryError | Error>;
}

interface CacheEntry {
  at: number;
  report: ProviderReport;
}

interface UsageRuntimeState {
  cache: Map<string, CacheEntry>;
  inFlight: Map<string, Deferred.Deferred<ProviderState>>;
}

type InFlightAction =
  | { kind: "join"; deferred: Deferred.Deferred<ProviderState> }
  | { kind: "start"; deferred: Deferred.Deferred<ProviderState> };

export class UsageRuntimeClosedError extends Data.TaggedError("UsageRuntimeClosedError")<{
  readonly message: string;
}> {}

class ProviderResolveError extends Data.TaggedError("ProviderResolveError")<{
  readonly cause: unknown;
}> {}

export interface UsageRuntimeShape {
  readonly queryProvider: (
    ctx: ExtensionContext,
    provider: ProviderQuerySpec,
    force: boolean,
    signal?: AbortSignal,
  ) => Effect.Effect<ProviderState, UsageRuntimeClosedError | Error>;
  readonly collectStates: (
    ctx: ExtensionContext,
    providers: readonly ProviderQuerySpec[],
    force: boolean,
    signal?: AbortSignal,
  ) => Effect.Effect<ProviderState[], UsageRuntimeClosedError | Error>;
  readonly close: Effect.Effect<void, UsageRuntimeClosedError>;
}

export class UsageRuntime extends Context.Service<UsageRuntime, UsageRuntimeShape>()(
  "pi-usage/UsageRuntime",
) {}

const makeUsageRuntime = Effect.gen(function* () {
  const ref = yield* SynchronizedRef.make<UsageRuntimeState>({
    cache: new Map(),
    inFlight: new Map(),
  });
  const workers = yield* FiberSet.make();
  const closed = MutableRef.make(false);

  const ensureOpen: Effect.Effect<void, UsageRuntimeClosedError> = Effect.suspend(() =>
    MutableRef.get(closed)
      ? Effect.fail(
          new UsageRuntimeClosedError({
            message: "Usage runtime is shut down; no further usage queries are accepted.",
          }),
        )
      : Effect.void,
  );

  const resolveToken = (
    ctx: ExtensionContext,
    provider: ProviderQuerySpec,
  ): Effect.Effect<ResolvedToken | undefined, ProviderResolveError> =>
    Effect.tryPromise({
      try: () => provider.resolve(ctx),
      catch: (cause) => new ProviderResolveError({ cause }),
    });

  const executeQuery = (
    ctx: ExtensionContext,
    provider: ProviderQuerySpec,
  ): Effect.Effect<ProviderState> =>
    Effect.gen(function* () {
      const resolved = yield* resolveToken(ctx, provider);
      if (!resolved) return unconfiguredState(provider);
      const report = yield* provider.queryEffect(resolved.token);
      return readyState(provider, report);
    }).pipe(
      Effect.catch((error) => Effect.succeed(errorState(provider, errorMessage(error)))),
      Effect.catchDefect((defect) =>
        Effect.succeed(errorState(provider, errorMessage(defect))),
      ),
    );

  /** Wait on a shared in-flight result; caller abort cancels only this wait. */
  const awaitInFlight = (
    deferred: Deferred.Deferred<ProviderState>,
    signal?: AbortSignal,
  ): Effect.Effect<ProviderState, Error> => {
    const wait = Deferred.await(deferred);
    if (!signal) return wait;
    if (signal.aborted) return Effect.fail(abortError());
    return Effect.race(
      wait,
      Effect.callback<ProviderState, Error>((resume, effectSignal) => {
        const abort = () => resume(Effect.fail(abortError()));
        if (signal.aborted || effectSignal.aborted) {
          abort();
          return;
        }
        signal.addEventListener("abort", abort, { once: true });
        effectSignal.addEventListener("abort", abort, { once: true });
        return Effect.sync(() => {
          signal.removeEventListener("abort", abort);
          effectSignal.removeEventListener("abort", abort);
        });
      }),
    );
  };

  const clearInFlight = (providerId: string, deferred: Deferred.Deferred<ProviderState>) =>
    SynchronizedRef.update(ref, (state) => {
      if (state.inFlight.get(providerId) === deferred) state.inFlight.delete(providerId);
      return state;
    });

  const queryProvider = (
    ctx: ExtensionContext,
    provider: ProviderQuerySpec,
    force: boolean,
    signal?: AbortSignal,
  ): Effect.Effect<ProviderState, UsageRuntimeClosedError | Error> =>
    ensureOpen.pipe(
      Effect.andThen(
        Effect.gen(function* () {
          if (!provider.hasLoginInfo(ctx)) {
            return unconfiguredState(provider);
          }

          const snapshot = yield* SynchronizedRef.get(ref);
          const cached = snapshot.cache.get(provider.id);
          if (!force && cached && Date.now() - cached.at < CACHE_TTL_MS) {
            return readyState(provider, cached.report);
          }

          const pending = snapshot.inFlight.get(provider.id);
          if (pending) return yield* awaitInFlight(pending, signal);

          const joinOrStart = yield* SynchronizedRef.modify(ref, (state): [InFlightAction, UsageRuntimeState] => {
            const existing = state.inFlight.get(provider.id);
            if (existing) {
              return [{ kind: "join", deferred: existing }, state];
            }
            const nextDeferred = Deferred.makeUnsafe<ProviderState>();
            state.inFlight.set(provider.id, nextDeferred);
            return [{ kind: "start", deferred: nextDeferred }, state];
          });

          if (joinOrStart.kind === "join") {
            return yield* awaitInFlight(joinOrStart.deferred, signal);
          }

          const deferred = joinOrStart.deferred;

          const worker = Effect.gen(function* () {
            const result = yield* executeQuery(ctx, provider);
            if (result.status === "ready") {
              yield* SynchronizedRef.update(ref, (state) => {
                state.cache.set(provider.id, { at: Date.now(), report: result.report });
                return state;
              });
            }
            yield* Deferred.succeed(deferred, result);
          }).pipe(
            Effect.catchDefect((defect) =>
              Deferred.succeed(deferred, errorState(provider, errorMessage(defect))).pipe(
                Effect.asVoid,
              ),
            ),
            Effect.ensuring(
              Effect.gen(function* () {
                if (yield* Deferred.isDone(deferred)) {
                  yield* clearInFlight(provider.id, deferred);
                }
              }),
            ),
          );

          yield* FiberSet.run(workers, worker);
          return yield* awaitInFlight(deferred, signal);
        }),
      ),
    );

  const collectStates = (
    ctx: ExtensionContext,
    providers: readonly ProviderQuerySpec[],
    force: boolean,
    signal?: AbortSignal,
  ): Effect.Effect<ProviderState[], UsageRuntimeClosedError | Error> =>
    ensureOpen.pipe(
      Effect.andThen(
        Effect.all(
          providers.map((provider) => queryProvider(ctx, provider, force, signal)),
          { concurrency: "unbounded" },
        ).pipe(
          Effect.map((states) => states.filter((state) => state.status !== "unconfigured")),
        ),
      ),
    );

  const close = ensureOpen.pipe(
    Effect.andThen(
      Effect.gen(function* () {
        MutableRef.set(closed, true);
        const snapshot = yield* SynchronizedRef.get(ref);
        const pending = [...snapshot.inFlight.values()];
        for (const deferred of pending) {
          if (!(yield* Deferred.isDone(deferred))) {
            yield* Deferred.interrupt(deferred);
          }
        }
        yield* FiberSet.clear(workers);
        yield* SynchronizedRef.update(ref, (state) => {
          state.cache.clear();
          state.inFlight.clear();
          return state;
        });
      }),
    ),
  );

  return UsageRuntime.of({ queryProvider, collectStates, close });
});

export const UsageRuntimeLive: Layer.Layer<UsageRuntime> = Layer.effect(
  UsageRuntime,
  makeUsageRuntime,
);

export function createUsageRuntime() {
  return ManagedRuntime.make(UsageRuntimeLive);
}

export type UsageRuntimeInstance = ReturnType<typeof createUsageRuntime>;

/** Run an async usage program from pi event/command handlers. */
export async function runUsage<A, E>(
  runtime: UsageRuntimeInstance,
  effect: Effect.Effect<A, E>,
  options: { signal?: AbortSignal } = {},
): Promise<A> {
  const exit = await runtime.runPromiseExit(
    effect,
    options.signal ? { signal: options.signal } : undefined,
  );
  if (Exit.isSuccess(exit)) return exit.value;
  if (Cause.hasInterruptsOnly(exit.cause)) {
    throw abortError();
  }
  const failure = Cause.findFail(exit.cause);
  if (Result.isSuccess(failure)) throw failure.success.error;
  const [first] = Cause.prettyErrors(exit.cause);
  throw new Error(first?.message ?? Cause.pretty(exit.cause));
}

function unconfiguredState(provider: ProviderQuerySpec): ProviderState {
  return {
    id: provider.id,
    name: provider.name,
    status: "unconfigured",
    message: provider.configureHint,
  };
}

function readyState(provider: ProviderQuerySpec, report: ProviderReport): ProviderState {
  return { id: provider.id, name: provider.name, status: "ready", report };
}

function errorState(provider: ProviderQuerySpec, message: string): ProviderState {
  return { id: provider.id, name: provider.name, status: "error", message };
}

function errorMessage(error: unknown): string {
  if (error instanceof ProviderResolveError) {
    return errorMessage(error.cause);
  }
  if (Cause.isUnknownError(error)) {
    return errorMessage(error.cause ?? error);
  }
  if (typeof error === "object" && error !== null && "cause" in error) {
    const cause = (error as { cause: unknown }).cause;
    if (cause !== undefined && cause !== error) {
      const fromCause = errorMessage(cause);
      if (fromCause.length > 0) return fromCause;
    }
  }
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

function abortError(): Error {
  const error = new Error("usage query aborted");
  error.name = "AbortError";
  return error;
}
