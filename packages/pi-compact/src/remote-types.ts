import type {
  Context,
  Model,
  Provider,
  ProviderHeaders,
  ThinkingLevel,
  Usage,
} from "@earendil-works/pi-ai";
import type { RemoteCompactionProtocol, ResponsesCompactionApi } from "./model-api.ts";
import type { JsonObject } from "./protocol.ts";

export interface PriorCheckpointPayload {
  marker: string;
  replacementHistory: readonly unknown[];
}

export interface RemoteCompactionRequest {
  provider: Provider;
  model: Model<ResponsesCompactionApi>;
  context: Context;
  protocol: RemoteCompactionProtocol;
  apiKey?: string;
  headers?: ProviderHeaders;
  env?: Record<string, string>;
  signal: AbortSignal;
  /** Session id forwarded as prompt_cache_key so the compaction call can hit the session's prompt cache. */
  sessionId?: string;
  /** Session thinking level; the reasoning field participates in the cache key, so it must match the session's requests. */
  reasoningEffort?: ThinkingLevel;
  priorCheckpoint?: PriorCheckpointPayload;
  requestTimeoutMs?: number;
  maxRetries?: number;
  fetch?: typeof globalThis.fetch;
}

export interface RemoteCompactionResponse {
  item: JsonObject;
  promptInput: JsonObject[];
  compactedOutput?: JsonObject[];
  usage: Usage;
}

/** HTTP status attached to a provider failure so route classification does not guess from text. */
export class RemoteRouteFailure extends Error {
  readonly status: number;

  constructor(message: string, status: number, cause?: unknown) {
    super(message, { cause });
    this.name = "RemoteRouteFailure";
    this.status = status;
  }
}

/** Decorate a provider failure with the last non-2xx status the provider reported. */
export function withRouteStatus(error: unknown, status: number | undefined): unknown {
  if (status === undefined || error instanceof RemoteRouteFailure) return error;
  return new RemoteRouteFailure(
    error instanceof Error ? error.message : String(error),
    status,
    error,
  );
}

export function routeFailureStatus(error: unknown): number | undefined {
  return error instanceof RemoteRouteFailure ? error.status : undefined;
}

/** Records the last non-2xx response status seen through a provider stream. */
export function createRouteStatusRecorder(): {
  onResponse: (response: { status: number }) => void;
  status: () => number | undefined;
} {
  let status: number | undefined;
  return {
    onResponse: (response) => {
      status = response.status >= 400 ? response.status : undefined;
    },
    status: () => status,
  };
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function abortError(): DOMException {
  return new DOMException("Compaction aborted", "AbortError");
}

export function assertPreparedInput(payload: JsonObject): JsonObject[] {
  if (!Array.isArray(payload.input) || !payload.input.every(isJsonObject)) {
    throw new Error("Prepared compaction payload has invalid input items");
  }
  return structuredClone(payload.input);
}
