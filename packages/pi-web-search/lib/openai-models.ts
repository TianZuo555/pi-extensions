import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";

const OPENCODE_HOST = "opencode.ai";
const RESPONSES_APIS = new Set([
  "openai-responses",
  "azure-openai-responses",
  "openai-codex-responses",
]);

export type OpenAISearchVariant = "openai" | "codex" | "xai";

export function isOpenAIResponsesModel(model: Model<Api> | undefined): model is Model<Api> {
  if (!model) return false;
  if (model.provider === "xai" && model.api === "openai-responses") return true;
  return RESPONSES_APIS.has(model.api);
}

export function openAISearchVariant(model: Model<Api>): OpenAISearchVariant {
  if (model.api === "openai-codex-responses") return "codex";
  if (model.provider === "xai" && model.api === "openai-responses") return "xai";
  return "openai";
}

function isOpenCodeModel(model: Model<Api>): boolean {
  if (model.provider === "opencode" || model.provider === "opencode-go") return true;
  try {
    return new URL(model.baseUrl).hostname === OPENCODE_HOST;
  } catch {
    return false;
  }
}

export function getOpenCodeSessionHeaders(
  model: Model<Api>,
  ctx: ExtensionContext | undefined,
): Record<string, string> | undefined {
  if (!isOpenCodeModel(model)) return undefined;
  const sessionId = ctx?.sessionManager?.getSessionId?.();
  if (!sessionId) return undefined;
  return { "x-opencode-session": sessionId, "x-opencode-client": "pi" };
}

export function resolveOpenAIResponsesUrl(model: Model<Api>, baseUrl = model.baseUrl): string {
  const base = baseUrl.replace(/\/+$/, "");
  if (model.api !== "openai-codex-responses") {
    return base.endsWith("/responses") ? base : `${base}/responses`;
  }
  if (base.endsWith("/codex/responses")) return base;
  if (base.endsWith("/codex")) return `${base}/responses`;
  return `${base}/codex/responses`;
}

export function resolveGitHubCopilotBaseUrl(
  model: Model<Api>,
  authBaseUrl: string | undefined,
  apiKey: string | undefined,
): string {
  if (model.provider !== "github-copilot") return model.baseUrl;
  if (typeof authBaseUrl === "string" && authBaseUrl.trim()) return authBaseUrl.trim();
  if (!apiKey) return model.baseUrl;

  const proxyEndpoints = apiKey
    .split(";")
    .filter((field) => field.startsWith("proxy-ep="))
    .map((field) => field.slice("proxy-ep=".length));
  if (proxyEndpoints.length !== 1 || !proxyEndpoints[0]) return model.baseUrl;

  const proxyHost = proxyEndpoints[0].toLowerCase();
  const labels = proxyHost.split(".");
  const isValidLabel = (label: string) =>
    label.length > 0 &&
    label.length <= 63 &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label);
  const isCopilotProxyHost =
    proxyHost.length <= 253 &&
    labels.length >= 4 &&
    labels[0] === "proxy" &&
    labels.at(-2) === "githubcopilot" &&
    labels.at(-1) === "com" &&
    labels.every(isValidLabel);
  if (!isCopilotProxyHost) return model.baseUrl;
  return `https://api.${labels.slice(1).join(".")}`;
}
