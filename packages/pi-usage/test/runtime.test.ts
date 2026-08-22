import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";
import type { ProviderReport } from "../lib/providers.ts";
import {
  CACHE_TTL_MS,
  createUsageRuntime,
  type ProviderQuerySpec,
  runUsage,
  UsageRuntime,
  UsageRuntimeClosedError,
} from "../src/runtime.ts";

const REPORT: ProviderReport = {
  id: "test-provider",
  name: "Test Provider",
  windows: [{ label: "Weekly limit", remainingPercent: 50 }],
  notes: [],
};

function mockCtx() {
  return {
    modelRegistry: {
      getProviderAuthStatus: () => ({ configured: true }),
    },
  } as any;
}

function provider(overrides: Partial<ProviderQuerySpec> = {}): ProviderQuerySpec & {
  counts: { resolve: number; query: number };
} {
  const counts = { resolve: 0, query: 0 };
  return {
    id: "test-provider",
    name: "Test Provider",
    configureHint: "configure me",
    hasLoginInfo: () => true,
    resolve: async () => {
      counts.resolve += 1;
      return { token: "token", source: "test" };
    },
    queryEffect: () =>
      Effect.sync(() => {
        counts.query += 1;
        return REPORT;
      }),
    counts,
    ...overrides,
  };
}

test("UsageRuntime caches provider reports until force refresh", async () => {
  const runtime = createUsageRuntime();
  const usage = runtime.runSync(UsageRuntime);
  const spec = provider();
  const ctx = mockCtx();

  const first = await runUsage(runtime, usage.queryProvider(ctx, spec, false));
  const second = await runUsage(runtime, usage.queryProvider(ctx, spec, false));
  assert.equal(first.status, "ready");
  assert.equal(second.status, "ready");
  assert.equal(spec.counts.query, 1);

  const refreshed = await runUsage(runtime, usage.queryProvider(ctx, spec, true));
  assert.equal(refreshed.status, "ready");
  assert.equal(spec.counts.query, 2);

  await runUsage(runtime, usage.close);
  await runtime.dispose();
});

test("UsageRuntime deduplicates same-provider in-flight queries", async () => {
  const runtime = createUsageRuntime();
  const usage = runtime.runSync(UsageRuntime);
  const gate = deferred<void>();
  const counts = { query: 0 };
  const spec = provider({
    queryEffect: () =>
      Effect.gen(function* () {
        counts.query += 1;
        yield* Effect.tryPromise(() => gate.promise);
        return REPORT;
      }),
  });
  const ctx = mockCtx();

  const first = runUsage(runtime, usage.queryProvider(ctx, spec, true));
  const second = runUsage(runtime, usage.queryProvider(ctx, spec, true));
  gate.resolve();
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a, b);
  assert.equal(counts.query, 1);

  await runUsage(runtime, usage.close);
  await runtime.dispose();
});

test("UsageRuntime shared in-flight query survives first caller cancellation", async () => {
  const runtime = createUsageRuntime();
  const usage = runtime.runSync(UsageRuntime);
  const gate = deferred<void>();
  const counts = { query: 0 };
  const spec = provider({
    queryEffect: () =>
      Effect.gen(function* () {
        counts.query += 1;
        yield* Effect.tryPromise(() => gate.promise);
        return REPORT;
      }),
  });
  const ctx = mockCtx();
  const controller = new AbortController();

  const first = runUsage(
    runtime,
    usage.queryProvider(ctx, spec, true, controller.signal),
    { signal: controller.signal },
  );

  while (counts.query === 0) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }

  const second = runUsage(runtime, usage.queryProvider(ctx, spec, true));
  controller.abort();
  await assert.rejects(first, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.name, "AbortError");
    return true;
  });

  gate.resolve();
  const result = await second;
  assert.equal(result.status, "ready");
  assert.equal(counts.query, 1);

  await runUsage(runtime, usage.close);
  await runtime.dispose();
});

test("UsageRuntime maps resolve failures to error state", async () => {
  const runtime = createUsageRuntime();
  const usage = runtime.runSync(UsageRuntime);
  const spec = provider({
    resolve: async () => {
      throw new Error("oauth refresh failed");
    },
  });
  const ctx = mockCtx();

  const state = await runUsage(runtime, usage.queryProvider(ctx, spec, true));
  assert.equal(state.status, "error");
  assert.match(state.message ?? "", /oauth refresh failed/);

  const collected = await runUsage(runtime, usage.collectStates(ctx, [spec], true));
  assert.equal(collected.length, 1);
  assert.equal(collected[0]?.status, "error");

  await runUsage(runtime, usage.close);
  await runtime.dispose();
});

test("UsageRuntime maps queryEffect failures to error state in collection", async () => {
  const runtime = createUsageRuntime();
  const usage = runtime.runSync(UsageRuntime);
  const counts = { query: 0 };
  const spec = provider({
    queryEffect: () =>
      Effect.gen(function* () {
        counts.query += 1;
        return yield* Effect.try(() => {
          throw new Error("no displayable data");
        });
      }),
  });
  const ctx = mockCtx();

  const collected = await runUsage(runtime, usage.collectStates(ctx, [spec], true));
  assert.equal(collected.length, 1);
  assert.equal(collected[0]?.status, "error");
  assert.match(collected[0]?.message ?? "", /no displayable data/);
  assert.equal(counts.query, 1);

  await runUsage(runtime, usage.close);
  await runtime.dispose();
});

test("UsageRuntime honors caller cancellation", async () => {
  const runtime = createUsageRuntime();
  const usage = runtime.runSync(UsageRuntime);
  const controller = new AbortController();
  const spec = provider({
    queryEffect: (_token, signal) =>
      Effect.gen(function* () {
        yield* Effect.tryPromise(
          () =>
            new Promise<void>((resolve, reject) => {
              signal?.addEventListener("abort", () => {
                const error = new Error("usage query aborted");
                error.name = "AbortError";
                reject(error);
              });
              setTimeout(resolve, 500);
            }),
        );
        return REPORT;
      }),
  });
  const ctx = mockCtx();
  const pending = runUsage(runtime, usage.queryProvider(ctx, spec, true, controller.signal), {
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.name, "AbortError");
    return true;
  });

  await runUsage(runtime, usage.close);
  await runtime.dispose();
});

test("UsageRuntime close rejects new queries and clears cache", async () => {
  const runtime = createUsageRuntime();
  const usage = runtime.runSync(UsageRuntime);
  const spec = provider();
  const ctx = mockCtx();

  await runUsage(runtime, usage.queryProvider(ctx, spec, false));
  await runUsage(runtime, usage.close);

  await assert.rejects(
    runUsage(runtime, usage.queryProvider(ctx, spec, false)),
    (error: unknown) => error instanceof UsageRuntimeClosedError,
  );

  await runtime.dispose();
});

test("UsageRuntime close interrupts outstanding queries", async () => {
  const runtime = createUsageRuntime();
  const usage = runtime.runSync(UsageRuntime);
  const gate = deferred<void>();
  const spec = provider({
    queryEffect: () =>
      Effect.gen(function* () {
        yield* Effect.tryPromise(() => gate.promise);
        return REPORT;
      }),
  });
  const ctx = mockCtx();

  const pending = runUsage(runtime, usage.queryProvider(ctx, spec, true));
  // Attach the rejection handler before close(): the interrupt lands while
  // close is still settling, and a late assert.rejects would leave the
  // rejection momentarily unhandled (unhandledRejection → flaky CI failure).
  const rejected = assert.rejects(pending);
  await runUsage(runtime, usage.close);
  await rejected;

  await runtime.dispose();
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
