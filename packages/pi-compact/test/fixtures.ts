import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionBeforeCompactEvent,
  type CompactionResult,
} from "@earendil-works/pi-coding-agent";
import { zstdDecompressSync } from "node:zlib";
import { createCompactExtension } from "../src/compact.ts";
import { createCheckpointDetails } from "../src/checkpoint.ts";
import { fallbackSummary } from "../src/prompt.ts";
import type { JsonObject } from "../src/protocol.ts";
import {
  DEFAULT_CODEX_COMPACT_SETTINGS,
  type CompactSettings,
  type CompactSettingsRuntime,
} from "../src/settings.ts";

export const sol: Model<"openai-codex-responses"> = {
  id: "test-sol",
  name: "test-sol",
  provider: "openai-codex",
  api: "openai-codex-responses",
  baseUrl: "https://example.invalid/backend-api",
  reasoning: true,
  input: ["text"],
  contextWindow: 100000,
  maxTokens: 1000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
export const terra = { ...sol, id: "test-terra", name: "test-terra" };
export const fakeApiKey = `x.${Buffer.from(
  JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: "test-only" },
  }),
).toString("base64url")}.x`;
export const provider = openaiCodexProvider();
export const opaque = { type: "compaction", encrypted_content: "test-opaque" };
export const userItem = (text: string) => ({
  type: "message",
  role: "user",
  content: [{ type: "input_text", text }],
});

export function completedResponse(): Response {
  return new Response(
    `data: ${JSON.stringify({
      type: "response.completed",
      response: {
        id: "resp_test",
        status: "completed",
        output: [opaque],
        usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
      },
    })}\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );
}

export function requestPayload(init?: RequestInit): JsonObject {
  const body = init?.body;
  if (new Headers(init?.headers).get("content-encoding") === "zstd") {
    return JSON.parse(zstdDecompressSync(body as Uint8Array).toString());
  }
  return JSON.parse(String(body));
}

type Handler = (event: never, ctx: ExtensionContext) => unknown;

export function harness(
  options: { prior?: boolean; fetch?: typeof fetch; settings?: Partial<CompactSettings> } = {},
) {
  const handlers = new Map<string, Handler>();
  const notifications: string[] = [];
  const payloads: JsonObject[] = [];
  const sm = SessionManager.inMemory();
  const old: AgentMessage = { role: "user", content: "old-user-code: old-123", timestamp: 1 };
  const kept: AgentMessage = {
    role: "user",
    content: "recent-user-code: recent-456",
    timestamp: 2,
  };
  sm.appendMessage(old);
  const keptId = sm.appendMessage(kept);
  if (options.prior) {
    const details = createCheckpointDetails({
      provider: sol.provider,
      api: sol.api,
      modelId: sol.id,
      protocol: "remote-v2",
      replacementHistory: [userItem(old.content as string), opaque],
      keptMessages: [kept],
    });
    sm.appendCompaction(fallbackSummary(details.checkpointId), keptId, 100, details, true);
  }
  const settings: CompactSettings = {
    ...DEFAULT_CODEX_COMPACT_SETTINGS,
    compactionModel: "",
    maxRetries: 0,
    ...options.settings,
  };
  const state = () => ({ kind: "loaded" as const, path: "<memory>", settings: { ...settings } });
  const runtime: CompactSettingsRuntime = {
    get: state,
    reload: async () => state(),
    flush: async () => {},
    update: async (patch) => {
      Object.assign(settings, patch);
      return state();
    },
  };
  const fetch: typeof globalThis.fetch = async (input, init) => {
    payloads.push(requestPayload(init));
    return options.fetch ? options.fetch(input, init) : completedResponse();
  };
  const ctx = {
    model: sol,
    thinkingLevel: "off",
    sessionManager: sm,
    hasUI: true,
    ui: {
      setStatus() {},
      notify(message: string) {
        notifications.push(message);
      },
    },
    modelRegistry: {
      find: (providerId: string, id: string) =>
        [sol, terra].find((m) => m.provider === providerId && m.id === id),
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: fakeApiKey }),
      getProvider: () => provider,
    },
    getSystemPrompt: () => "Base system prompt",
  } as unknown as ExtensionContext;
  const pi = {
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    getAllTools: () => [],
    getActiveTools: () => [],
  } as unknown as ExtensionAPI;
  createCompactExtension({ fetch, settingsRuntime: runtime })(pi);
  function event(firstKeptEntryId = keptId): SessionBeforeCompactEvent {
    return {
      type: "session_before_compact",
      branchEntries: sm.getBranch(),
      reason: "manual",
      willRetry: false,
      signal: new AbortController().signal,
      preparation: {
        firstKeptEntryId,
        tokensBefore: 100,
        messagesToSummarize: [old],
        turnPrefixMessages: [],
        isSplitTurn: false,
        previousSummary: undefined,
        fileOps: { read: new Set(), written: new Set(), edited: new Set() },
        settings: { enabled: true, keepRecentTokens: 10, reserveTokens: 100 },
      },
    };
  }
  async function call<T>(name: string, event: unknown): Promise<T> {
    const handler = handlers.get(name);
    if (!handler) throw new Error(`Missing handler: ${name}`);
    return (await handler(event as never, ctx)) as T;
  }
  const compact = (input = event()) =>
    call<{ cancel?: boolean; compaction?: CompactionResult } | undefined>(
      "session_before_compact",
      input,
    );
  return {
    sm,
    ctx,
    kept,
    keptId,
    settings,
    runtime,
    payloads,
    notifications,
    event,
    call,
    compact,
  };
}
