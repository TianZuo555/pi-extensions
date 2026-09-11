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
