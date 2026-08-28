import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Effect } from "effect";
import {
  CommitRuntime,
  createCommitRuntime,
  GenerationError,
  ModelUnavailableError,
  runCommit,
  type ResolvedModel,
} from "../src/runtime.ts";
import { parseModelReference } from "../lib/config.ts";

function mockResolvedModel(responseText: string): ResolvedModel {
  return {
    model: { provider: "openai", id: "test" } as ResolvedModel["model"],
    reference: { provider: "openai", id: "test", value: "openai/test" },
    auth: {},
    providerInvoker: {
      streamSimple: () => ({
        result: async () =>
          ({
            stopReason: "stop",
            content: [{ type: "text", text: responseText }],
          }) as AssistantMessage,
      }),
    },
  };
}

const mockSnapshot = {
  branch: "main",
  fingerprint: { head: "abc", tree: "def" },
  paths: ["file.ts"],
  nameStatus: "M\tfile.ts",
  stat: " file.ts | 1 +",
  patch: "diff",
  patchBytes: 4,
  omittedPatchBytes: 0,
  recentCommitSubjects: "init",
};

test("runCommit throws AbortError on runtime interruption", async () => {
  const runtime = createCommitRuntime();
  const _commit = runtime.runSync(CommitRuntime);

  const hang = Effect.never;
  const runPromise = runCommit(runtime, hang);
  // Attach the rejection handler before dispose(): the AbortError lands
  // during disposal, and a late assert.rejects would leave the rejection
  // momentarily unhandled (unhandledRejection → flaky CI failure).
  const rejected = assert.rejects(runPromise, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.name, "AbortError");
    return true;
  });
  await runtime.dispose();
  await rejected;
});

test("runCommit throws GenerationError for invalid generated commit message normalization", async () => {
  const runtime = createCommitRuntime();
  const commit = runtime.runSync(CommitRuntime);

  await assert.rejects(
    () =>
      runCommit(runtime, commit.requestCommitMessage(mockResolvedModel("   "), mockSnapshot, "")),
    (error: unknown) => error instanceof GenerationError,
  );

  await runtime.dispose();
});

test("runCommit throws GenerationError for invalid generated commit plan normalization", async () => {
  const runtime = createCommitRuntime();
  const commit = runtime.runSync(CommitRuntime);

  await assert.rejects(
    () =>
      runCommit(runtime, commit.requestCommitPlan(mockResolvedModel("not json"), mockSnapshot, "")),
    (error: unknown) => error instanceof GenerationError,
  );

  await runtime.dispose();
});

function mockCommandContext(models: Record<string, { ok: boolean; error?: string }>) {
  return {
    modelRegistry: {
      find: (provider: string, id: string) => {
        const key = `${provider}/${id}`;
        return models[key] ? { provider, id } : undefined;
      },
      getApiKeyAndHeaders: async (model: { provider: string; id: string }) => {
        const key = `${model.provider}/${model.id}`;
        const entry = models[key];
        if (!entry) return { ok: false, error: "missing" };
        return entry.ok
          ? { ok: true as const, apiKey: "test-key" }
          : { ok: false as const, error: entry.error ?? "unavailable" };
      },
    },
  };
}

test("resolveCommitModels uses fallback when the primary model is unavailable", async () => {
  const runtime = createCommitRuntime();
  const commit = runtime.runSync(CommitRuntime);
  const ctx = mockCommandContext({
    "openai/primary": { ok: false, error: "no auth" },
    "deepseek/fallback": { ok: true },
  });

  const models = await runCommit(
    runtime,
    commit.resolveCommitModels(ctx as never, {
      model: parseModelReference("openai/primary"),
      fallbackModel: parseModelReference("deepseek/fallback"),
      warnings: [],
    }),
  );

  assert.equal(models.active.reference.value, "deepseek/fallback");
  assert.equal(models.primary, undefined);
  assert.equal(models.fallback?.reference.value, "deepseek/fallback");

  await runtime.dispose();
});

test("resolveCommitModels keeps primary when both models resolve", async () => {
  const runtime = createCommitRuntime();
  const commit = runtime.runSync(CommitRuntime);
  const ctx = mockCommandContext({
    "openai/primary": { ok: true },
    "deepseek/fallback": { ok: true },
  });

  const models = await runCommit(
    runtime,
    commit.resolveCommitModels(ctx as never, {
      model: parseModelReference("openai/primary"),
      fallbackModel: parseModelReference("deepseek/fallback"),
      warnings: [],
    }),
  );

  assert.equal(models.active.reference.value, "openai/primary");
  assert.equal(models.primary?.reference.value, "openai/primary");
  assert.equal(models.fallback?.reference.value, "deepseek/fallback");

  await runtime.dispose();
});

test("resolveCommitModels fails when neither primary nor fallback resolves", async () => {
  const runtime = createCommitRuntime();
  const commit = runtime.runSync(CommitRuntime);
  const ctx = mockCommandContext({
    "openai/primary": { ok: false, error: "no auth" },
    "deepseek/fallback": { ok: false, error: "no auth" },
  });

  await assert.rejects(
    () =>
      runCommit(
        runtime,
        commit.resolveCommitModels(ctx as never, {
          model: parseModelReference("openai/primary"),
          fallbackModel: parseModelReference("deepseek/fallback"),
          warnings: [],
        }),
      ),
    (error: unknown) => error instanceof ModelUnavailableError,
  );

  await runtime.dispose();
});
