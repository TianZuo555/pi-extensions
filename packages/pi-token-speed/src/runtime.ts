/**
 * TokenSpeedRuntime — Effect v4 service for measuring and formatting
 * generation token speeds, sliding-window rate tracking, and display mode persistence.
 */

import path from "node:path";
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
import { piConfigDir, readJson, writeJson } from "../lib/config.ts";
import { TokenSpeedConfigError } from "./errors.ts";

export type DisplayMode = "live" | "final" | "off";
export const MODES: DisplayMode[] = ["live", "final", "off"];

export const CONFIG_FILE = path.join(piConfigDir("token-speed"), "config.json");
export const STATUS_KEY = "token-speed";

export const WINDOW_MS = 5_000;
export const MIN_SPAN_MS = 250;
export const CHARS_PER_TOKEN = 4;
export const RENDER_INTERVAL_MS = 100;

export interface Sample {
  t: number;
  tokens: number;
}

export interface StreamState {
  samples: Sample[];
  head: number;
  startedAt: number;
  firstTokenAt?: number;
  estimatedTokens: number;
  streaming: boolean;
}

export interface MeterState {
  mode: DisplayMode;
  lastRender: number;
  lastSummary: string;
  stream: StreamState;
}

export function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${Math.round(n)}`;
}

export function formatRate(tps: number): string {
  return tps >= 100 ? `${Math.round(tps)}` : tps.toFixed(1);
}

export function formatDuration(ms: number): string {
  return ms >= 1_000 ? `${(ms / 1_000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

export function computeRate(stream: StreamState, now: number): number {
  const cutoff = now - WINDOW_MS;
  let head = stream.head;
  while (head < stream.samples.length && stream.samples[head].t < cutoff) {
    head++;
  }
  if (head >= stream.samples.length) return 0;

  let tokens = 0;
  for (let i = head; i < stream.samples.length; i++) {
    tokens += stream.samples[i].tokens;
  }
  if (tokens === 0) return 0;

  const span = Math.max(now - stream.samples[head].t, MIN_SPAN_MS);
  return (1000 * tokens) / span;
}

export function computeAverageRate(
  stream: StreamState,
  totalTokens: number,
  now: number,
): number {
  const from = stream.firstTokenAt ?? stream.startedAt;
  const span = Math.max(now - from, MIN_SPAN_MS);
  return (1000 * totalTokens) / span;
}

export interface TokenSpeedRuntimeShape {
  readonly getMode: Effect.Effect<DisplayMode>;
  readonly setMode: (
    mode: DisplayMode,
  ) => Effect.Effect<DisplayMode, TokenSpeedConfigError>;
  readonly cycleMode: Effect.Effect<DisplayMode, TokenSpeedConfigError>;
  readonly beginStream: (now: number) => Effect.Effect<void>;
  readonly recordDelta: (
    delta: string,
    now: number,
  ) => Effect.Effect<{ shouldRender: boolean; statusText?: string }>;
  readonly endStream: (
    totalTokens: number | undefined,
    now: number,
  ) => Effect.Effect<{ shouldRender: boolean; summary: string }>;
  readonly getLastSummary: Effect.Effect<string>;
  readonly clear: Effect.Effect<void>;
}

export class TokenSpeedRuntime extends Context.Service<
  TokenSpeedRuntime,
  TokenSpeedRuntimeShape
>()("pi-tian-token-speed/TokenSpeedRuntime") {}

const makeTokenSpeedRuntime = Effect.gen(function* () {
  const initialMode = (() => {
    const cfg = readJson<{ mode: DisplayMode }>(CONFIG_FILE, { mode: "live" });
    return MODES.includes(cfg.mode) ? cfg.mode : "live";
  })();

  const ref = yield* SynchronizedRef.make<MeterState>({
    mode: initialMode,
    lastRender: 0,
    lastSummary: "",
    stream: {
      samples: [],
      head: 0,
      startedAt: 0,
      estimatedTokens: 0,
      streaming: false,
    },
  });

  const saveConfig = (mode: DisplayMode): Effect.Effect<void, TokenSpeedConfigError> =>
    Effect.try({
      try: () => writeJson(CONFIG_FILE, { mode }),
      catch: (err) =>
        new TokenSpeedConfigError({
          message: `Failed to save token speed mode: ${err instanceof Error ? err.message : String(err)}`,
        }),
    });

  const getMode: Effect.Effect<DisplayMode> = SynchronizedRef.get(ref).pipe(
    Effect.map((s) => s.mode),
  );

  const setMode = (mode: DisplayMode): Effect.Effect<DisplayMode, TokenSpeedConfigError> =>
    Effect.gen(function* () {
      yield* SynchronizedRef.update(ref, (s) => ({ ...s, mode }));
      yield* saveConfig(mode);
      return mode;
    });

  const cycleMode: Effect.Effect<DisplayMode, TokenSpeedConfigError> = Effect.gen(
    function* () {
      const current = yield* getMode;
      const next = MODES[(MODES.indexOf(current) + 1) % MODES.length];
      return yield* setMode(next);
    },
  );

  const beginStream = (now: number): Effect.Effect<void> =>
    SynchronizedRef.update(ref, (s) => ({
      ...s,
      lastRender: 0,
      stream: {
        samples: [],
        head: 0,
        startedAt: now,
        firstTokenAt: undefined,
        estimatedTokens: 0,
        streaming: true,
      },
    }));

  const recordDelta = (
    delta: string,
    now: number,
  ): Effect.Effect<{ shouldRender: boolean; statusText?: string }> =>
    SynchronizedRef.modify(
      ref,
      (s): [{ shouldRender: boolean; statusText?: string }, MeterState] => {
        if (!s.stream.streaming || s.mode !== "live") {
          return [{ shouldRender: false }, s];
        }

        const stream = { ...s.stream };
        if (stream.firstTokenAt === undefined) stream.firstTokenAt = now;
        const tokens = Math.max(1, Math.round(delta.length / CHARS_PER_TOKEN));
        stream.estimatedTokens += tokens;
        stream.samples = [...stream.samples, { t: now, tokens }];

        if (stream.head > 512) {
          stream.samples = stream.samples.slice(stream.head);
          stream.head = 0;
        }

        if (now - s.lastRender < RENDER_INTERVAL_MS) {
          return [{ shouldRender: false }, { ...s, stream }];
        }

        const rate = computeRate(stream, now);
        const statusText = `⚡ ${formatRate(rate)} tok/s`;
        return [{ shouldRender: true, statusText }, { ...s, lastRender: now, stream }];
      },
    );

  const endStream = (
    totalTokens: number | undefined,
    now: number,
  ): Effect.Effect<{ shouldRender: boolean; summary: string }> =>
    SynchronizedRef.modify(
      ref,
      (s): [{ shouldRender: boolean; summary: string }, MeterState] => {
        const stream = { ...s.stream, streaming: false };
        const tokens = totalTokens ?? stream.estimatedTokens;

        if (s.mode === "off") {
          return [{ shouldRender: false, summary: "" }, { ...s, stream }];
        }

        const avgRate = computeAverageRate(stream, tokens, now);
        const parts = [`⚡ ${formatRate(avgRate)} tok/s avg`, `${formatCount(tokens)} tok`];
        if (stream.firstTokenAt !== undefined) {
          const ttft = stream.firstTokenAt - stream.startedAt;
          parts.push(`TTFT ${formatDuration(ttft)}`);
        }
        const summary = parts.join(" · ");
        return [{ shouldRender: true, summary }, { ...s, lastSummary: summary, stream }];
      },
    );

  const getLastSummary: Effect.Effect<string> = SynchronizedRef.get(ref).pipe(
    Effect.map((s) => s.lastSummary),
  );

  const clear: Effect.Effect<void> = SynchronizedRef.update(ref, (s) => ({
    ...s,
    lastSummary: "",
  }));

  return TokenSpeedRuntime.of({
    getMode,
    setMode,
    cycleMode,
    beginStream,
    recordDelta,
    endStream,
    getLastSummary,
    clear,
  });
});

export const TokenSpeedRuntimeLive: Layer.Layer<TokenSpeedRuntime> = Layer.effect(
  TokenSpeedRuntime,
  makeTokenSpeedRuntime,
);

export function createTokenSpeedRuntime() {
  return ManagedRuntime.make(TokenSpeedRuntimeLive);
}

export type TokenSpeedRuntimeInstance = ReturnType<
  typeof createTokenSpeedRuntime
>;

/** Run an async token-speed effect program safely */
export async function runTokenSpeed<A, E>(
  runtime: TokenSpeedRuntimeInstance,
  effect: Effect.Effect<A, E>,
  options: { signal?: AbortSignal } = {},
): Promise<A> {
  const exit = await runtime.runPromiseExit(
    effect,
    options.signal ? { signal: options.signal } : undefined,
  );
  if (Exit.isSuccess(exit)) return exit.value;
  if (Cause.hasInterruptsOnly(exit.cause)) {
    const error = new Error("token-speed operation aborted");
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
