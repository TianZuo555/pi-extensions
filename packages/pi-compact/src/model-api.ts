import type { Api, Model } from "@earendil-works/pi-ai";
import { hasApi } from "@earendil-works/pi-ai";

export const RESPONSES_COMPACTION_APIS = [
  "openai-codex-responses",
  "openai-responses",
  "azure-openai-responses",
] as const;

export type ResponsesCompactionApi = (typeof RESPONSES_COMPACTION_APIS)[number];
export type RemoteCompactionProtocol = "remote-v2" | "responses-compact";
export type RemoteCompactionProtocolSetting = "auto" | RemoteCompactionProtocol;

export type CompactionRoute =
  | { kind: "remote"; protocol: RemoteCompactionProtocol; api: ResponsesCompactionApi }
  | { kind: "native"; reason: string };

export function usesResponsesCompactionApi(
  model: Model<Api> | undefined,
): model is Model<ResponsesCompactionApi> {
  return model !== undefined && RESPONSES_COMPACTION_APIS.some((api) => hasApi(model, api));
}

/** Models on one registered provider must also resolve to the same API and endpoint. */
export function sameResponsesBackend(left: Model<Api>, right: Model<Api>): boolean {
  return (
    left.provider === right.provider &&
    left.api === right.api &&
    left.baseUrl.replace(/\/+$/, "") === right.baseUrl.replace(/\/+$/, "")
  );
}

export function resolveCompactionRouteForApi(
  api: Api | undefined,
  options: { enabled: boolean; protocol: RemoteCompactionProtocolSetting },
): CompactionRoute {
  if (!options.enabled) return { kind: "native", reason: "remote compaction is disabled" };
  if (!api) return { kind: "native", reason: "no active model" };
  if (!RESPONSES_COMPACTION_APIS.includes(api as ResponsesCompactionApi)) {
    return { kind: "native", reason: `API ${api} does not support Responses compaction` };
  }
  if (api === "openai-codex-responses" && options.protocol === "responses-compact") {
    return {
      kind: "native",
      reason:
        "The Codex /responses/compact endpoint is unavailable. Set protocol to auto or remote-v2.",
    };
  }
  const supportedApi = api as ResponsesCompactionApi;
  const protocol =
    options.protocol === "auto"
      ? supportedApi === "openai-codex-responses"
        ? "remote-v2"
        : "responses-compact"
      : options.protocol;
  return { kind: "remote", protocol, api: supportedApi };
}

export function resolveCompactionRoute(
  model: Model<Api> | undefined,
  options: { enabled: boolean; protocol: RemoteCompactionProtocolSetting },
): CompactionRoute {
  return resolveCompactionRouteForApi(model?.api, options);
}
