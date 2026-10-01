import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { clampThinkingLevel, type Api, type Model } from "@earendil-works/pi-ai";
import { getEnvApiKey } from "@earendil-works/pi-ai/compat";
import { resolveOpenAIConfig, type ResolvedOpenAIConfig } from "./config.ts";
import {
  getOpenCodeSessionHeaders,
  isOpenAIResponsesModel,
  openAISearchVariant,
  resolveGitHubCopilotBaseUrl,
  resolveOpenAIResponsesUrl,
  type OpenAISearchVariant,
} from "./openai-models.ts";
import { DEFAULT_OPENAI_SYSTEM_PROMPT } from "./prompt.ts";

export type { OpenAISearchVariant };

export interface OpenAISearchRequest {
  apiKey?: string;
  headers: Record<string, string>;
  /** Full Responses API URL, including `/responses` or `/codex/responses`. */
  url: string;
  model: string;
  systemPrompt: string;
  reasoning?: "low" | "medium" | "high";
  variant: OpenAISearchVariant;
  source: string;
  /** `web_search_call.results` is rejected by Codex and xAI. */
  includeResults: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function compactHeaders(
  headers: Record<string, string | null | undefined>,
): Record<string, string> {
  const compact: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === "string" && value) compact[name] = value;
  }
  return compact;
}

function hasAuthHeader(headers: Record<string, string>): boolean {
  return Object.entries(headers).some(([name, value]) => {
    if (!value) return false;
    const normalized = name.toLowerCase();
    return (
      normalized === "authorization" ||
      normalized === "x-api-key" ||
      normalized === "chatgpt-account-id"
    );
  });
}

function extractCodexAccountId(token: string): string | undefined {
  try {
    const parts = token.split(".");
    if (parts.length !== 3 || !parts[1]) return undefined;
    const padded = parts[1]
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(parts[1].length / 4) * 4, "=");
    const payload: unknown = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
    if (!isRecord(payload)) return undefined;
    const auth = payload["https://api.openai.com/auth"];
    if (!isRecord(auth)) return undefined;
    const accountId = auth.chatgpt_account_id;
    return typeof accountId === "string" && accountId.trim() ? accountId.trim() : undefined;
  } catch {
    return undefined;
  }
}

function sessionReasoning(
  model: Model<Api>,
  ctx: ExtensionContext | undefined,
): OpenAISearchRequest["reasoning"] {
  const thinkingLevel = ctx?.thinkingLevel;
  if (!model.reasoning || !thinkingLevel || thinkingLevel === "off") return undefined;
  const level = clampThinkingLevel(model, thinkingLevel);
  if (level === "off") return undefined;
  const mapped = model.thinkingLevelMap?.[level];
  if (mapped === null) return undefined;
  const effort = mapped ?? level;
  return effort === "low" || effort === "medium" || effort === "high" ? effort : undefined;
}

async function trySessionRequest(
  ctx: ExtensionContext | undefined,
): Promise<OpenAISearchRequest | null> {
  const model = ctx?.model;
  if (!model || !isOpenAIResponsesModel(model) || !ctx?.modelRegistry?.getApiKeyAndHeaders) {
    return null;
  }

  const resolved = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!resolved.ok) return null;

  const envKey =
    !resolved.apiKey && !hasAuthHeader(compactHeaders(resolved.headers ?? {}))
      ? getEnvApiKey(model.provider)
      : undefined;
  const apiKey = resolved.apiKey || envKey;
  const headers = compactHeaders({
    ...getOpenCodeSessionHeaders(model, ctx),
    ...(model.headers ?? {}),
    ...(resolved.headers ?? {}),
  });
  if (apiKey && !hasAuthHeader(headers)) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  if (!apiKey && !hasAuthHeader(headers)) return null;

  const variant = openAISearchVariant(model);
  if (variant === "codex") {
    const authorization = headers.Authorization ?? headers.authorization;
    const hasBearer = typeof authorization === "string" && /^Bearer\s+\S+/i.test(authorization);
    if (!apiKey && !hasBearer) return null;
    const hasAccount = Object.keys(headers).some(
      (name) => name.toLowerCase() === "chatgpt-account-id",
    );
    if (!hasAccount) {
      const accountId = apiKey ? extractCodexAccountId(apiKey) : undefined;
      if (!accountId) return null;
      headers["chatgpt-account-id"] = accountId;
    }
    if (!Object.keys(headers).some((name) => name.toLowerCase() === "originator")) {
      headers.originator = "codex_cli_rs";
    }
  }

  const baseUrl = resolveGitHubCopilotBaseUrl(model, resolved.baseUrl, apiKey);
  return {
    apiKey,
    headers,
    url: resolveOpenAIResponsesUrl(model, baseUrl),
    model: model.id,
    systemPrompt: DEFAULT_OPENAI_SYSTEM_PROMPT,
    reasoning: variant === "xai" ? undefined : sessionReasoning(model, ctx),
    variant,
    source: `session model (${model.provider}/${model.id})`,
    includeResults: variant === "openai",
  };
}

function dedicatedRequest(config: ResolvedOpenAIConfig): OpenAISearchRequest {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.apiKey}`,
  };
  if (config.accountId) headers["ChatGPT-Account-Id"] = config.accountId;
  if (config.isCodexOAuth) headers.originator = "codex_cli_rs";
  return {
    apiKey: config.apiKey,
    headers,
    url: config.baseUrl,
    model: config.model,
    systemPrompt: config.systemPrompt,
    reasoning: config.reasoning,
    variant: config.isCodexOAuth ? "codex" : "openai",
    source: config.source,
    includeResults: !config.isCodexOAuth,
  };
}

/** Prefer the current Responses-family session model; otherwise the dedicated OpenAI login. */
export async function resolveOpenAISearchRequest(
  ctx?: ExtensionContext,
): Promise<OpenAISearchRequest | null> {
  const session = await trySessionRequest(ctx);
  if (session) return session;
  const dedicated = resolveOpenAIConfig(ctx);
  return dedicated ? dedicatedRequest(dedicated) : null;
}
