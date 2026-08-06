/**
 * CommitRuntime — Effect v4-owned model resolution and commit-message generation.
 *
 * Git mutations and pi UI sequencing stay in `index.ts`; this service owns the
 * typed LLM boundary and converts pi SDK failures into Effect errors.
 */

import { randomUUID } from "node:crypto";
import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  Cause,
  Context as EffectContext,
  Data,
  Effect,
  Exit,
  Layer,
  ManagedRuntime,
  Result,
} from "effect";
import type { CommitThinkingLevel, ModelReference } from "../lib/config.ts";
import type { StagedSnapshot } from "../lib/git.ts";
import {
  buildCommitAllPrompt,
  buildCommitPrompt,
  COMMIT_ALL_SYSTEM_PROMPT,
  COMMIT_SYSTEM_PROMPT,
  normalizeGeneratedCommitMessage,
  normalizeGeneratedCommitPlan,
  type CommitPlan,
} from "../lib/prompt.ts";

export interface ResolvedAuth {
  apiKey?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
}

interface ProviderInvoker {
  streamSimple(
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
  ): { result(): Promise<AssistantMessage> };
}

interface ProviderRegistry {
  getProvider?: (provider: string) => ProviderInvoker | undefined;
}

export interface ResolvedModel {
  model: Model<Api>;
  reference: ModelReference;
  thinkingLevel?: CommitThinkingLevel;
  auth: ResolvedAuth;
  providerInvoker?: ProviderInvoker;
}

export class ModelNotFoundError extends Data.TaggedError("ModelNotFoundError")<{
  readonly message: string;
}> {}

export class ModelUnavailableError extends Data.TaggedError("ModelUnavailableError")<{
  readonly message: string;
}> {}

export class GenerationError extends Data.TaggedError("GenerationError")<{
  readonly message: string;
}> {}

export type CommitModelError = ModelNotFoundError | ModelUnavailableError | GenerationError;

function getProviderInvoker(
  registry: ExtensionCommandContext["modelRegistry"],
  provider: string,
): ProviderInvoker | undefined {
  const registryWithProvider = registry as ProviderRegistry;
  return registryWithProvider.getProvider?.(provider);
}

export interface CommitRuntimeShape {
  readonly resolveConfiguredModel: (
    ctx: ExtensionCommandContext,
    reference: ModelReference,
    thinkingLevel?: CommitThinkingLevel,
  ) => Effect.Effect<ResolvedModel, CommitModelError>;
  readonly requestCommitMessage: (
    resolved: ResolvedModel,
    snapshot: StagedSnapshot,
    guidance: string,
    signal?: AbortSignal,
  ) => Effect.Effect<string | void, CommitModelError>;
  readonly requestCommitPlan: (
    resolved: ResolvedModel,
    snapshot: StagedSnapshot,
    guidance: string,
    signal?: AbortSignal,
  ) => Effect.Effect<CommitPlan | void, CommitModelError>;
}

export class CommitRuntime extends EffectContext.Service<CommitRuntime, CommitRuntimeShape>()(
  "pi-tian-commit/CommitRuntime",
) {}

const makeCommitRuntime = Effect.succeed(
  CommitRuntime.of({
    resolveConfiguredModel: (ctx, reference, thinkingLevel) =>
      Effect.tryPromise({
        try: async () => {
          const model = ctx.modelRegistry.find(reference.provider, reference.id);
          if (!model) {
            throw new ModelNotFoundError({
              message: `Commit model ${reference.value} was not found. Check piCommit.model in settings.json or configure the model in models.json.`,
            });
          }
          const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
          if (!auth.ok) {
            throw new ModelUnavailableError({
              message: `Commit model ${reference.value} is unavailable: ${auth.error}`,
            });
          }
          return {
            model,
            reference,
            thinkingLevel,
            auth,
            providerInvoker: getProviderInvoker(ctx.modelRegistry, reference.provider),
          } satisfies ResolvedModel;
        },
        catch: (error) =>
          error instanceof ModelNotFoundError || error instanceof ModelUnavailableError
            ? error
            : new ModelUnavailableError({
                message: error instanceof Error ? error.message : String(error),
              }),
      }),

    requestCommitMessage: (resolved, snapshot, guidance, signal) =>
      requestModelText(resolved, COMMIT_SYSTEM_PROMPT, buildCommitPrompt(snapshot, guidance), 2048, signal).pipe(
        Effect.flatMap((text) =>
          text === undefined
            ? Effect.void
            : Effect.try({
                try: () => normalizeGeneratedCommitMessage(text),
                catch: (cause) =>
                  new GenerationError({
                    message: cause instanceof Error ? cause.message : String(cause),
                  }),
              }),
        ),
      ),

    requestCommitPlan: (resolved, snapshot, guidance, signal) =>
      requestModelText(
        resolved,
        COMMIT_ALL_SYSTEM_PROMPT,
        buildCommitAllPrompt(snapshot, guidance),
        8192,
        signal,
      ).pipe(
        Effect.flatMap((text) =>
          text === undefined
            ? Effect.void
            : Effect.try({
                try: () => normalizeGeneratedCommitPlan(text, snapshot.paths),
                catch: (cause) =>
                  new GenerationError({
                    message: cause instanceof Error ? cause.message : String(cause),
                  }),
              }),
        ),
      ),
  }),
);

function requestModelText(
  resolved: ResolvedModel,
  systemPrompt: string,
  userPrompt: string,
  maxTokens: number,
  signal?: AbortSignal,
): Effect.Effect<string | void, CommitModelError> {
  if (signal?.aborted) return Effect.void;

  return Effect.tryPromise({
    try: async () => {
      const context: Context = {
        systemPrompt,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: userPrompt }],
            timestamp: Date.now(),
          },
        ],
      };
      const options: SimpleStreamOptions = {
        apiKey: resolved.auth.apiKey,
        headers: resolved.auth.headers,
        env: resolved.auth.env,
        signal,
        cacheRetention: "none",
        maxTokens,
        reasoning: resolved.thinkingLevel === "off" ? undefined : resolved.thinkingLevel,
        timeoutMs: 120_000,
        maxRetries: 0,
        maxRetryDelayMs: 60_000,
        sessionId: randomUUID(),
      };
      const response = resolved.providerInvoker
        ? await resolved.providerInvoker.streamSimple(resolved.model, context, options).result()
        : await completeSimple(resolved.model, context, options);

      if (response.stopReason === "aborted") return undefined;
      if (response.stopReason !== "stop") {
        throw new GenerationError({
          message: response.errorMessage
            ? `${response.stopReason}: ${response.errorMessage}`
            : `model stopped with ${response.stopReason}`,
        });
      }

      return response.content
        .filter((part): part is { type: "text"; text: string } => part.type === "text")
        .map((part) => part.text)
        .join("\n");
    },
    catch: (error) =>
      error instanceof GenerationError
        ? error
        : new GenerationError({
            message: error instanceof Error ? error.message : String(error),
          }),
  });
}

export const CommitRuntimeLive: Layer.Layer<CommitRuntime> = Layer.effect(
  CommitRuntime,
  makeCommitRuntime,
);

export function createCommitRuntime() {
  return ManagedRuntime.make(CommitRuntimeLive);
}

export type CommitRuntimeInstance = ReturnType<typeof createCommitRuntime>;

/** Run an async commit program from pi command handlers. */
export async function runCommit<A, E>(
  runtime: CommitRuntimeInstance,
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

function abortError(): Error {
  const error = new Error("Commit operation was aborted");
  error.name = "AbortError";
  return error;
}

/** Translate typed CommitModelError failures into thrown Errors for pi UI. */
export function commitErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
