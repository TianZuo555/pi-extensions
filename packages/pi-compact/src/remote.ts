import { requestResponsesCompact } from "./remote-compact.ts";
import type { RemoteCompactionRequest, RemoteCompactionResponse } from "./remote-types.ts";
import { requestRemoteCompactionV2 } from "./remote-v2.ts";

export type {
  PriorCheckpointPayload,
  RemoteCompactionRequest,
  RemoteCompactionResponse,
} from "./remote-types.ts";

export function requestRemoteCompaction(
  request: RemoteCompactionRequest,
): Promise<RemoteCompactionResponse> {
  return request.protocol === "responses-compact"
    ? requestResponsesCompact(request)
    : requestRemoteCompactionV2(request);
}
