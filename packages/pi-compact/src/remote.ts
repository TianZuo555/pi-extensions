import { requestResponsesCompact } from "./remote-compact.ts";
import type { RemoteCompactionRequest, RemoteCompactionResponse } from "./remote-types.ts";
import { requestRemoteCompactionV2 } from "./remote-v2.ts";

export type {
  PriorCheckpointPayload,
  RemoteCompactionRequest,
  RemoteCompactionResponse,
} from "./remote-types.ts";

export async function requestRemoteCompaction(
  request: RemoteCompactionRequest,
): Promise<RemoteCompactionResponse> {
  const controller = new AbortController();
  const timeoutMs = request.requestTimeoutMs ?? 300_000;
  const timeout = new Error(`Remote compaction timed out after ${timeoutMs}ms`);
  const timer = setTimeout(() => controller.abort(timeout), timeoutMs);
  timer.unref();
  const signal = AbortSignal.any([request.signal, controller.signal]);
  try {
    const bounded = { ...request, signal };
    return await (request.protocol === "responses-compact"
      ? requestResponsesCompact(bounded)
      : requestRemoteCompactionV2(bounded));
  } catch (error) {
    if (!request.signal.aborted && controller.signal.reason === timeout) throw timeout;
    throw error;
  } finally {
    clearTimeout(timer);
    // Close both SSE tee readers, including when the provider fails before inspection finishes.
    controller.abort();
  }
}
