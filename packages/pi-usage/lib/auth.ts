// Credential resolution for the usage extension.
//
// Codex usage (https://chatgpt.com/backend-api/wham/usage) is authenticated with
// the ChatGPT OAuth *access* token. GitHub Copilot usage
// (https://api.github.com/copilot_internal/user) is authenticated with the GitHub
// OAuth token — the `refresh` credential pi stores for github-copilot — NOT the
// short-lived Copilot chat token that pi hands to model requests. Z.ai usage
// (https://api.z.ai/api/monitor/usage/quota/limit), Z.ai China usage
// (https://open.bigmodel.cn/api/monitor/usage/quota/limit), and DeepSeek balance
// (https://api.deepseek.com/user/balance) are authenticated with plain API keys.
//
// Pi persists both under ~/.pi/agent/auth.json. We read that file directly (it is
// the same store pi itself writes) so `/usage` reports every configured provider
// regardless of which provider the active model belongs to. For Codex we fall
// back to pi's registry only to refresh an expired access token; for Copilot we
// fall back to standard GitHub token environment variables and the VS Code
// Copilot credential file.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const AUTH_FILE = path.join(os.homedir(), ".pi", "agent", "auth.json");
const COPILOT_APPS_FILE = path.join(os.homedir(), ".config", "github-copilot", "apps.json");
const COPILOT_TOKEN_ENV = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GITHUB_COPILOT_TOKEN",
  "COPILOT_GITHUB_TOKEN",
];
const ZAI_TOKEN_ENV = ["ZAI_API_KEY"];
const ZAI_CN_TOKEN_ENV = ["ZAI_CODING_CN_API_KEY", "ZHIPU_API_KEY"];
const DEEPSEEK_TOKEN_ENV = ["DEEPSEEK_API_KEY"];
const AUTH_RESOLVE_TIMEOUT_MS = 30_000;

interface PiAuthEntry {
  type?: string;
  access?: string;
  refresh?: string;
  key?: string;
  expires?: number;
}

interface ProviderAuthResult {
  auth: {
    apiKey?: string;
    headers?: Record<string, string | null>;
  };
}

interface ProviderAuthRegistry {
  getProviderAuth?: (providerId: string) => Promise<ProviderAuthResult | undefined>;
}

/** A resolved bearer credential plus where it came from (for diagnostics). */
export interface ResolvedToken {
  token: string;
  source: string;
}

/**
 * Check whether a provider has login information without resolving OAuth.
 *
 * Pi's synchronous auth status covers stored, runtime, environment, and
 * models.json credentials. `hasLocalLoginInfo` preserves the extra credential
 * sources this extension supports directly (for example VS Code Copilot).
 */
export function hasProviderLoginInfo(
  ctx: ExtensionContext,
  providerId: string,
  hasLocalLoginInfo?: () => boolean,
): boolean {
  try {
    if (ctx.modelRegistry.getProviderAuthStatus(providerId).configured) return true;
  } catch {
    // Fall through to local sources for a stale session context or an older pi
    // without provider auth status.
  }
  try {
    return hasLocalLoginInfo?.() ?? false;
  } catch {
    // Never query a provider speculatively when its local auth check fails.
    return false;
  }
}

function readPiAuth(): Record<string, PiAuthEntry> {
  try {
    return JSON.parse(fs.readFileSync(AUTH_FILE, "utf-8")) as Record<string, PiAuthEntry>;
  } catch {
    return {};
  }
}

// Ask pi's model registry to resolve a fresh bearer token for a provider. Used
// only as a fallback when the stored Codex access token has expired, so pi can
// transparently refresh and persist it.
async function bearerFromRegistry(
  ctx: ExtensionContext,
  providerId: string,
): Promise<string | undefined> {
  try {
    const registry = ctx.modelRegistry as typeof ctx.modelRegistry & ProviderAuthRegistry;

    // Newer Pi versions expose provider-scoped auth, which avoids depending on
    // the model catalog being ready during session_start.
    if (registry.getProviderAuth) {
      const result = await withTimeout(
        registry.getProviderAuth(providerId),
        AUTH_RESOLVE_TIMEOUT_MS,
      );
      if (!result) return undefined;
      const authorization =
        result.auth.headers?.Authorization ?? result.auth.headers?.authorization ?? undefined;
      if (authorization) return stripBearer(authorization);
      return result.auth.apiKey || undefined;
    }

    // Compatibility fallback for older Pi releases.
    const models = [...registry.getAvailable(), ...registry.getAll()];
    const model = models.find((candidate) => candidate.provider === providerId);
    if (!model) return undefined;
    const result = await withTimeout(registry.getApiKeyAndHeaders(model), AUTH_RESOLVE_TIMEOUT_MS);
    if (!result?.ok) return undefined;
    const authorization =
      result.headers?.Authorization ?? result.headers?.authorization ?? undefined;
    if (authorization) return stripBearer(authorization);
    return result.apiKey || undefined;
  } catch {
    return undefined;
  }
}

function stripBearer(value: string): string {
  const match = /^bearer\s+(.+)$/i.exec(value.trim());
  return match ? match[1] : value.trim();
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Return whether pi has stored enough Codex OAuth data to resolve a token. */
export function hasCodexLoginInfo(): boolean {
  const entry = readPiAuth()["openai-codex"];
  return Boolean(entry?.access || entry?.refresh);
}

/**
 * Resolve the ChatGPT access token used for Codex usage.
 *
 * Reads the token pi persisted in auth.json directly so `/usage` works for Codex
 * regardless of which provider the active model belongs to. Only when the stored
 * access token is missing or expired do we ask pi's registry to refresh it (which
 * also persists the refreshed credential).
 */
export async function resolveCodexToken(ctx: ExtensionContext): Promise<ResolvedToken | undefined> {
  const entry = readPiAuth()["openai-codex"];
  const now = Date.now();

  if (entry?.access && (entry.expires === undefined || entry.expires > now + 60_000)) {
    return { token: entry.access, source: "~/.pi/agent/auth.json" };
  }

  const refreshed = await bearerFromRegistry(ctx, "openai-codex");
  if (refreshed) return { token: refreshed, source: "pi runtime auth" };

  // A token that is already expired only creates a predictable 401 and masks
  // the real refresh failure. Keep a still-valid near-expiry token as a final
  // fallback, but never send one whose recorded expiry has passed.
  if (entry?.access && (entry.expires === undefined || entry.expires > now)) {
    return { token: entry.access, source: "~/.pi/agent/auth.json (expires soon)" };
  }
  return undefined;
}

/** Return whether a supported Z.ai credential source is configured. */
export function hasZaiLoginInfo(): boolean {
  return resolveZaiToken() !== undefined;
}

/** Resolve the Z.ai API key used for the GLM Coding Plan usage endpoint. */
export function resolveZaiToken(): ResolvedToken | undefined {
  const key = readPiAuth().zai?.key;
  if (key) return { token: key, source: "~/.pi/agent/auth.json" };

  for (const name of ZAI_TOKEN_ENV) {
    const value = process.env[name];
    if (value) return { token: value, source: `$${name}` };
  }
  return undefined;
}

/** Return whether a supported Z.ai China credential source is configured. */
export function hasZaiCnLoginInfo(): boolean {
  return resolveZaiCnToken() !== undefined;
}

/** Resolve the API key used for the domestic BigModel.cn quota endpoint. */
export function resolveZaiCnToken(): ResolvedToken | undefined {
  const key = readPiAuth()["zai-coding-cn"]?.key;
  if (key) return { token: key, source: "~/.pi/agent/auth.json" };

  for (const name of ZAI_CN_TOKEN_ENV) {
    const value = process.env[name];
    if (value) return { token: value, source: `$${name}` };
  }
  return undefined;
}

/** Return whether a supported DeepSeek credential source is configured. */
export function hasDeepSeekLoginInfo(): boolean {
  return resolveDeepSeekToken() !== undefined;
}

/** Resolve the DeepSeek API key used for the balance endpoint. */
export function resolveDeepSeekToken(): ResolvedToken | undefined {
  const key = readPiAuth().deepseek?.key;
  if (key) return { token: key, source: "~/.pi/agent/auth.json" };

  for (const name of DEEPSEEK_TOKEN_ENV) {
    const value = process.env[name];
    if (value) return { token: value, source: `$${name}` };
  }
  return undefined;
}

/** Return whether a supported Copilot credential source is configured. */
export function hasCopilotLoginInfo(): boolean {
  return resolveCopilotToken() !== undefined;
}

/** Resolve the GitHub OAuth token used for Copilot usage. */
export function resolveCopilotToken(): ResolvedToken | undefined {
  const refresh = readPiAuth()["github-copilot"]?.refresh;
  if (refresh) return { token: refresh, source: "~/.pi/agent/auth.json" };

  for (const name of COPILOT_TOKEN_ENV) {
    const value = process.env[name];
    if (value) return { token: value, source: `$${name}` };
  }

  try {
    const apps = JSON.parse(fs.readFileSync(COPILOT_APPS_FILE, "utf-8")) as Record<string, unknown>;
    for (const entry of Object.values(apps)) {
      const token = (entry as { oauth_token?: unknown })?.oauth_token;
      if (typeof token === "string" && token) {
        return { token, source: "~/.config/github-copilot/apps.json" };
      }
    }
  } catch {
    // No VS Code Copilot credentials available.
  }
  return undefined;
}
