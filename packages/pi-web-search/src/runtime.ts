/**
 * WebSearchRuntime — Effect v4 service for live web search and document fetching.
 *
 * Dispatches to OpenAI (Codex / Responses API), Exa AI, Firecrawl, or Ollama,
 * and falls back gracefully to direct HTTP fetch with HTML-to-Markdown conversion.
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
} from "effect";
import {
  resolveFetchProvider,
  resolveSearchProvider,
} from "../lib/config.ts";
import { fetchDirect } from "../lib/direct-fetch.ts";
import { fetchExa, searchExa } from "../lib/exa.ts";
import { fetchFirecrawl, searchFirecrawl } from "../lib/firecrawl.ts";
import { fetchOllama, searchOllama } from "../lib/ollama.ts";
import { searchOpenAI } from "../lib/openai.ts";
import type {
  FetchOptions,
  FetchProviderName,
  FetchResponse,
  SearchOptions,
  SearchProviderName,
  SearchResponse,
} from "../lib/types.ts";
import {
  WebSearchApiError,
  WebSearchConfigError,
  type WebSearchError,
} from "./errors.ts";

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
}

export class WebSearchRuntime extends Context.Service<
  WebSearchRuntime,
  WebSearchRuntimeShape
>()("pi-tian-web-search/WebSearchRuntime") {}

const makeWebSearchRuntime = Effect.sync(() => {
  const search = (
    query: string,
    options: SearchOptions = {},
    requestedProvider?: SearchProviderName,
    ctx?: ExtensionContext,
  ): Effect.Effect<SearchResponse, WebSearchError> =>
    Effect.gen(function* () {
      const provider = resolveSearchProvider(ctx, requestedProvider);

      return yield* Effect.tryPromise({
        try: async (signal) => {
          const combinedSignal = options.signal
            ? signal
              ? AbortSignal.any([options.signal, signal])
              : options.signal
            : signal;

          const searchOpts: SearchOptions = {
            ...options,
            signal: combinedSignal,
          };

          switch (provider) {
            case "openai":
              return await searchOpenAI(query, searchOpts, ctx);
            case "exa":
              return await searchExa(query, searchOpts);
            case "firecrawl":
              return await searchFirecrawl(query, searchOpts);
            case "ollama":
              return await searchOllama(query, searchOpts);
            default:
              throw new Error(`Unsupported search provider: ${provider as string}`);
          }
        },
        catch: (err) => {
          const message = err instanceof Error ? err.message : String(err);
          if (message.includes("not found") || message.includes("credentials")) {
            return new WebSearchConfigError({ message, provider });
          }
          return new WebSearchApiError({ message, provider });
        },
      });
    });

  const fetch = (
    url: string,
    options: FetchOptions = {},
    requestedProvider?: FetchProviderName,
  ): Effect.Effect<FetchResponse, WebSearchError> =>
    Effect.gen(function* () {
      const provider = resolveFetchProvider(requestedProvider);

      return yield* Effect.tryPromise({
        try: async (signal) => {
          const combinedSignal = options.signal
            ? signal
              ? AbortSignal.any([options.signal, signal])
              : options.signal
            : signal;

          const fetchOpts: FetchOptions = {
            ...options,
            signal: combinedSignal,
          };

          try {
            switch (provider) {
              case "firecrawl":
                return await fetchFirecrawl(url, fetchOpts);
              case "exa":
                return await fetchExa(url, fetchOpts);
              case "ollama":
                return await fetchOllama(url, fetchOpts);
              case "direct":
              default:
                return await fetchDirect(url, fetchOpts);
            }
          } catch (err) {
            // If a dedicated scraper fails and direct fetch wasn't tried, fallback to direct fetch
            if (provider !== "direct") {
              try {
                return await fetchDirect(url, fetchOpts);
              } catch {
                throw err;
              }
            }
            throw err;
          }
        },
        catch: (err) => {
          const message = err instanceof Error ? err.message : String(err);
          return new WebSearchApiError({ message, provider });
        },
      });
    });

  return WebSearchRuntime.of({ search, fetch });
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
  if (Result.isSuccess(failure)) throw failure.success.error;
  const [first] = Cause.prettyErrors(exit.cause);
  throw new Error(first?.message ?? Cause.pretty(exit.cause));
}
