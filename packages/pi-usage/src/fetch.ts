/**
 * Effect v4 HTTP fetch layer for provider usage endpoints.
 *
 * Retries retryable failures with a fixed delay; honors caller and effect
 * interruption via AbortSignal. Listener and timeout cleanup runs exactly once
 * on success, failure, and fiber interruption.
 */

import { Data, Duration, Effect, Schedule } from "effect";

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_RETRY_COUNT = 1;
const RETRY_DELAY_MS = 300;
const MAX_BODY_BYTES = 128 * 1024;

export class ProviderQueryError extends Data.TaggedError("ProviderQueryError")<{
  readonly message: string;
  readonly retryable: boolean;
  readonly status?: number;
}> {}

/** Promise boundary for repo-level provider tests and legacy callers. */
export async function fetchProviderJson(
  url: string,
  token: string,
  extraHeaders: Record<string, string>,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  retryCount: number,
  secret: string,
): Promise<Record<string, unknown>> {
  return Effect.runPromise(
    fetchProviderJsonEffect(url, token, extraHeaders, signal, timeoutMs, retryCount, secret),
    signal ? { signal } : undefined,
  );
}

export function fetchProviderJsonEffect(
  url: string,
  token: string,
  extraHeaders: Record<string, string>,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  retryCount: number,
  secret: string,
): Effect.Effect<Record<string, unknown>, ProviderQueryError | Error> {
  const once = fetchProviderJsonOnceEffect(
    url,
    token,
    extraHeaders,
    signal,
    timeoutMs,
    secret,
  );
  if (retryCount <= 0) return once;
  const policy = Schedule.addDelay(Schedule.recurs(retryCount), () =>
    Effect.succeed(Duration.millis(RETRY_DELAY_MS)),
  );
  return Effect.retry(once, {
    schedule: policy,
    while: (error) => {
      if (signal?.aborted) return false;
      return error instanceof ProviderQueryError && error.retryable;
    },
  });
}

function fetchProviderJsonOnceEffect(
  url: string,
  token: string,
  extraHeaders: Record<string, string>,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  secret: string,
): Effect.Effect<Record<string, unknown>, ProviderQueryError | Error> {
  return Effect.callback((resume, effectSignal) => {
    if (signal?.aborted || effectSignal.aborted) {
      resume(Effect.fail(abortError()));
      return;
    }

    const controller = new AbortController();
    const onExternalAbort = () => controller.abort();
    const onEffectAbort = () => controller.abort();
    signal?.addEventListener("abort", onExternalAbort, { once: true });
    effectSignal.addEventListener("abort", onEffectAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onExternalAbort);
      effectSignal.removeEventListener("abort", onEffectAbort);
    };

    const finish = (outcome: Effect.Effect<Record<string, unknown>, ProviderQueryError | Error>) => {
      if (settled) return;
      settled = true;
      cleanup();
      resume(outcome);
    };

    void (async () => {
      try {
        const response = await fetch(url, {
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${token}`,
            ...extraHeaders,
          },
          signal: controller.signal,
        });
        const text = redact(await readBounded(response), secret);
        if (!response.ok) {
          finish(
            Effect.fail(
              new ProviderQueryError({
                message: `${response.status} ${response.statusText}${text ? `: ${truncate(text, 200)}` : ""}`,
                retryable: isRetryableStatus(response.status),
                status: response.status,
              }),
            ),
          );
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(text) as unknown;
        } catch {
          finish(
            Effect.fail(
              new ProviderQueryError({
                message: "provider returned invalid JSON",
                retryable: false,
              }),
            ),
          );
          return;
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          finish(
            Effect.fail(
              new ProviderQueryError({
                message: "provider response was not an object",
                retryable: false,
              }),
            ),
          );
          return;
        }
        finish(Effect.succeed(parsed as Record<string, unknown>));
      } catch (error) {
        if (signal?.aborted || effectSignal.aborted) {
          finish(Effect.fail(abortError()));
          return;
        }
        if (error instanceof ProviderQueryError) {
          finish(Effect.fail(error));
          return;
        }
        if (error instanceof Error && error.name === "AbortError") {
          finish(
            Effect.fail(
              new ProviderQueryError({
                message: `timed out after ${Math.round(timeoutMs / 1000)}s`,
                retryable: true,
              }),
            ),
          );
          return;
        }
        const message = error instanceof Error ? redact(error.message, secret) : String(error);
        finish(
          Effect.fail(
            new ProviderQueryError({
              message,
              retryable: true,
            }),
          ),
        );
      }
    })();

    return Effect.sync(() => {
      if (settled) return;
      settled = true;
      cleanup();
      controller.abort();
    });
  });
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function abortError(): Error {
  const error = new Error("usage query aborted");
  error.name = "AbortError";
  return error;
}

async function readBounded(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        chunks.push(value.subarray(0, Math.max(0, value.byteLength - (total - MAX_BODY_BYTES))));
        await reader.cancel();
        break;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(concat(chunks));
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function redact(text: string, secret: string): string {
  return secret ? text.split(secret).join("[redacted]") : text;
}

function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}
