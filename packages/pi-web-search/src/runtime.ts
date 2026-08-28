/**
 * WebSearchRuntime — Effect v4 service for live web search and document fetching.
 *
 * Dispatches to OpenAI (Codex / Responses API), Exa AI, Tavily, Firecrawl, or
 * Ollama.
 * Every call walks an ordered fallback chain: the requested/configured provider
 * is tried first, and on failure the next available provider takes over.
 * Quota-class failures (402/403, out of credits, usage limits) block the
 * provider for the rest of the session, so subsequent calls skip straight to
 * the next healthy provider; plain rate limits (429) only apply a short
 * cooldown.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  Cause,
  Context,
  Effect,
  Exit,
  Layer,
  ManagedRuntime,
  Result,
  SynchronizedRef,
} from "effect";
import { resolveFetchChain, resolveSearchChain } from "../lib/config.ts";
import { fetchDirect } from "../lib/direct-fetch.ts";
import { fetchExa, searchExa } from "../lib/exa.ts";
import { fetchFirecrawl, searchFirecrawl } from "../lib/firecrawl.ts";
import { fetchMonid, searchMonid } from "../lib/monid.ts";
import { fetchOllama, searchOllama } from "../lib/ollama.ts";
import { searchOpenAI } from "../lib/openai.ts";
import { fetchTavily, searchTavily } from "../lib/tavily.ts";
import type {
  FetchOptions,
  FetchProviderName,
  FetchResponse,
  ProviderFallback,
  SearchOptions,
  SearchProviderName,
  SearchResponse,
} from "../lib/types.ts";
import {
  WebSearchApiError,
  type WebSearchError,
} from "./errors.ts";

/** How long a rate-limited (429) provider is skipped before retrying it. */
export const RATE_LIMIT_COOLDOWN_MS = 120_000;

/** Failure classes that temporarily remove a provider from the fallback chain. */
export type ProviderFailureClass = "session" | "cooldown";

const SESSION_FAILURE_MARKERS = [
  "payment required",
  "insufficient",
  "quota",
  "credit",
  "usage limit",
  "plan limit",
];

/**
 * Classify a provider error message. "session" failures (out of credits,
 * invalid key, plan limits) disable the provider for the whole session;
 * "cooldown" failures (429 rate limits) only disable it briefly.
 */
export function classifyProviderFailure(
  message: string,
): ProviderFailureClass | null {
  const m = message.toLowerCase();
  if (/\b429\b/.test(m) || m.includes("rate limit") || m.includes("too many requests")) {
    return "cooldown";
  }
  if (/\b40[23]\b/.test(m)) return "session";
  if (SESSION_FAILURE_MARKERS.some((marker) => m.includes(marker))) {
    return "session";
  }
  return null;
}

interface ProviderBlock {
  readonly reason: string;
  /** Epoch ms after which the provider may be retried; Infinity = session. */
  readonly until: number;
}

export interface ProviderHealthEntry {
  readonly provider: string;
  readonly reason: string;
  /** Milliseconds until the provider is retried; null = rest of session. */
  readonly msLeft: number | null;
}

/** Per-provider session usage counters, surfaced by /websearch-usage. */
export interface ProviderUsageEntry {
  readonly kind: "search" | "fetch";
  readonly provider: string;
  readonly ok: number;
  readonly fail: number;
  readonly totalMs: number;
}

interface ProviderAttemptFailure {
  readonly provider: string;
  readonly message: string;
  readonly userAborted: boolean;
}

function combineSignals(
  outer: AbortSignal | undefined,
  inner: AbortSignal | undefined,
): AbortSignal | undefined {
  if (outer && inner) return AbortSignal.any([outer, inner]);
  return outer ?? inner;
}

function isUserAbort(err: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return true;
  return err instanceof Error && err.name === "AbortError";
}

export interface WebSearchRuntimeShape {
  readonly search: (
    query: string,
    options?: SearchOptions,
    provider?: SearchProviderName,
    ctx?: ExtensionContext,
  ) => Effect.Effect<SearchResponse, WebSearchError>;

  readonly fetch: (
    url: string,
    options?: FetchOptions,
    provider?: FetchProviderName,
  ) => Effect.Effect<FetchResponse, WebSearchError>;

  /** Providers currently skipped by the session fallback, with reasons. */
  readonly providerHealth: Effect.Effect<
    ReadonlyArray<ProviderHealthEntry>
  >;

  /** Per-provider session usage counters (see /websearch-usage). */
  readonly usage: Effect.Effect<ReadonlyArray<ProviderUsageEntry>>;
}

export class WebSearchRuntime extends Context.Service<
  WebSearchRuntime,
  WebSearchRuntimeShape
>()("pi-web-search/WebSearchRuntime") {}

const makeWebSearchRuntime = Effect.gen(function* () {
  const healthRef = yield* SynchronizedRef.make(
    new Map<string, ProviderBlock>(),
  );

  /** Session usage counters keyed by `${kind}:${provider}`. */
  const usage = new Map<string, ProviderUsageEntry>();

  const recordUsage = (
    kind: "search" | "fetch",
    provider: string,
    ok: boolean,
    ms: number,
  ): void => {
    const key = `${kind}:${provider}`;
    const current = usage.get(key) ?? {
      kind,
      provider,
      ok: 0,
      fail: 0,
      totalMs: 0,
    };
    usage.set(key, {
      ...current,
      ok: current.ok + (ok ? 1 : 0),
      fail: current.fail + (ok ? 0 : 1),
      totalMs: current.totalMs + ms,
    });
  };

  const usageSnapshot = (): ReadonlyArray<ProviderUsageEntry> =>
    [...usage.values()].sort((a, b) =>
      a.kind === b.kind
        ? a.provider.localeCompare(b.provider)
        : a.kind.localeCompare(b.kind),
    );

  const recordBlock = (provider: string, failure: ProviderAttemptFailure) =>
    SynchronizedRef.update(healthRef, (health) => {
      const failureClass = classifyProviderFailure(failure.message);
      if (!failureClass) return health;
      const until =
        failureClass === "session"
          ? Number.POSITIVE_INFINITY
          : Date.now() + RATE_LIMIT_COOLDOWN_MS;
      const next = new Map(health);
      next.set(provider, { reason: failure.message.slice(0, 160), until });
      return next;
    });

  const clearBlock = (provider: string) =>
    SynchronizedRef.update(healthRef, (health) => {
      if (!health.has(provider)) return health;
      const next = new Map(health);
      next.delete(provider);
      return next;
    });

  const providerHealth: Effect.Effect<
    ReadonlyArray<ProviderHealthEntry>
  > = SynchronizedRef.get(healthRef).pipe(
    Effect.map((health) => {
      const now = Date.now();
      return [...health.entries()]
        .filter(([, entry]) => entry.until > now)
        .map(([provider, entry]) => ({
          provider,
          reason: entry.reason,
          msLeft: Number.isFinite(entry.until) ? entry.until - now : null,
        }));
    }),
  );

  /**
   * Run `attempt` across the fallback chain. Failures are recorded in the
   * session health map (when they look like quota/rate-limit errors) and the
   * next provider is tried; the first success wins and reports which
   * providers it fell back from.
   */
  const runProviderChain = <P extends string, R extends { fallbacks?: ProviderFallback[] }>(
    kind: "search" | "fetch",
    chain: readonly P[],
    attempt: (provider: P) => Effect.Effect<R, ProviderAttemptFailure>,
  ): Effect.Effect<R, WebSearchError> => {
    const go = (
      remaining: readonly P[],
      failures: ReadonlyArray<ProviderAttemptFailure>,
    ): Effect.Effect<R, WebSearchError> => {
      const [head, ...tail] = remaining;
      if (head === undefined) {
        return Effect.fail(
          new WebSearchApiError({
            message: `All ${kind} providers failed:${failures
              .map((f) => `\n  • ${f.provider}: ${f.message}`)
              .join("")}`,
            provider: failures[0]?.provider ?? "none",
          }),
        );
      }

      const t0 = Date.now();
      return attempt(head).pipe(
        Effect.flatMap((result) => {
          recordUsage(kind, head, true, Date.now() - t0);
          const withFallbacks: R =
            failures.length > 0
              ? {
                  ...result,
                  fallbacks: failures.map((f) => ({
                    provider: f.provider,
                    reason: f.message,
                  })),
                }
              : result;
          return clearBlock(head).pipe(Effect.as(withFallbacks));
        }),
        Effect.catch((failure: ProviderAttemptFailure) => {
          if (!failure.userAborted) {
            recordUsage(kind, head, false, Date.now() - t0);
          }
          if (failure.userAborted) {
            return Effect.fail(
              new WebSearchApiError({
                message: failure.message,
                provider: failure.provider,
              }),
            );
          }
          return recordBlock(head, failure).pipe(
            Effect.flatMap(() => go(tail, [...failures, failure])),
          );
        }),
      );
    };

    return SynchronizedRef.get(healthRef).pipe(
      Effect.flatMap((health) => {
        const now = Date.now();
        const usable = chain.filter((provider) => {
          const entry = health.get(provider);
          return !entry || entry.until <= now;
        });
        if (usable.length > 0) return go(usable, []);

        const details = chain
          .map((provider) => {
            const entry = health.get(provider);
            if (!entry) return "";
            const scope = Number.isFinite(entry.until)
              ? `retry in ~${Math.ceil((entry.until - now) / 1000)}s`
              : "blocked for this session";
            return `\n  • ${provider}: ${entry.reason} (${scope})`;
          })
          .join("");
        return Effect.fail(
          new WebSearchApiError({
            message: `All ${kind} providers are unavailable:${details}\nProviders that run out of usage are skipped until the session ends. Use /web-search to review provider configuration.`,
            provider: "none",
          }),
        );
      }),
    );
  };

  const search = (
    query: string,
    options: SearchOptions = {},
    requestedProvider?: SearchProviderName,
    ctx?: ExtensionContext,
  ): Effect.Effect<SearchResponse, WebSearchError> =>
    runProviderChain(
      "search",
      resolveSearchChain(requestedProvider),
      (provider: SearchProviderName) =>
        Effect.tryPromise({
          try: async (signal) => {
            const searchOpts: SearchOptions = {
              ...options,
              signal: combineSignals(options.signal, signal),
            };
            switch (provider) {
              case "openai":
                return await searchOpenAI(query, searchOpts, ctx);
              case "exa":
                return await searchExa(query, searchOpts);
              case "tavily":
                return await searchTavily(query, searchOpts);
              case "firecrawl":
                return await searchFirecrawl(query, searchOpts);
              case "monid":
                return await searchMonid(query, searchOpts);
              case "ollama":
                return await searchOllama(query, searchOpts);
              default:
                throw new Error(
                  `Unsupported search provider: ${provider as string}`,
                );
            }
          },
          catch: (err): ProviderAttemptFailure => ({
            provider,
            message: err instanceof Error ? err.message : String(err),
            userAborted: isUserAbort(err, options.signal),
          }),
        }),
    );

  const fetchUrl = (
    url: string,
    options: FetchOptions = {},
    requestedProvider?: FetchProviderName,
  ): Effect.Effect<FetchResponse, WebSearchError> =>
    runProviderChain(
      "fetch",
      resolveFetchChain(requestedProvider),
      (provider: FetchProviderName) =>
        Effect.tryPromise({
          try: async (signal) => {
            const fetchOpts: FetchOptions = {
              ...options,
              signal: combineSignals(options.signal, signal),
            };
            switch (provider) {
              case "firecrawl":
                return await fetchFirecrawl(url, fetchOpts);
              case "exa":
                return await fetchExa(url, fetchOpts);
              case "tavily":
                return await fetchTavily(url, fetchOpts);
              case "monid":
                return await fetchMonid(url, fetchOpts);
              case "ollama":
                return await fetchOllama(url, fetchOpts);
              case "direct":
                return await fetchDirect(url, fetchOpts);
              default:
                throw new Error(
                  `Unsupported fetch provider: ${provider as string}`,
                );
            }
          },
          catch: (err): ProviderAttemptFailure => ({
            provider,
            message: err instanceof Error ? err.message : String(err),
            userAborted: isUserAbort(err, options.signal),
          }),
        }),
    );

  return WebSearchRuntime.of({
    search,
    fetch: fetchUrl,
    providerHealth,
    usage: Effect.sync(usageSnapshot),
  });
});

export const WebSearchRuntimeLive: Layer.Layer<WebSearchRuntime> = Layer.effect(
  WebSearchRuntime,
  makeWebSearchRuntime,
);

export function createWebSearchRuntime() {
  return ManagedRuntime.make(WebSearchRuntimeLive);
}

export type WebSearchRuntimeInstance = ReturnType<typeof createWebSearchRuntime>;

/** Run an async web search effect program safely */
export async function runWebSearch<A, E>(
  runtime: WebSearchRuntimeInstance,
  effect: Effect.Effect<A, E>,
  options: { signal?: AbortSignal } = {},
): Promise<A> {
  const exit = await runtime.runPromiseExit(
    effect,
    options.signal ? { signal: options.signal } : undefined,
  );
  if (Exit.isSuccess(exit)) return exit.value;
  if (Cause.hasInterruptsOnly(exit.cause)) {
    const error = new Error("web search request aborted");
    error.name = "AbortError";
    throw error;
  }
  const failure = Cause.findFail(exit.cause);
  if (Result.isSuccess(failure)) {
    const err = failure.success.error;
    if (err instanceof Error) throw err;
    if (typeof err === "object" && err !== null && "message" in err) {
      throw new Error(String((err as { message: unknown }).message));
    }
    throw new Error(String(err));
  }
  const [first] = Cause.prettyErrors(exit.cause);
  throw new Error(first?.message ?? Cause.pretty(exit.cause));
}
