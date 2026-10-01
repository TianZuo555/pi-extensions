import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { hidePiAuthFile, isolateProviderEnv } from "./helpers.ts";
import {
  availableSearchProviders,
  getProviderStatuses,
} from "../lib/config.ts";
import {
  isOpenAIResponsesModel,
  resolveGitHubCopilotBaseUrl,
  resolveOpenAIResponsesUrl,
  getOpenCodeSessionHeaders,
} from "../lib/openai-models.ts";
import { resolveOpenAISearchRequest } from "../lib/openai-session.ts";
import { searchOpenAI } from "../lib/openai.ts";
import {
  applyIndexCitations,
  isLikelyJunkSearchUrl,
  normalizeSearchUrl,
} from "../lib/openai-urls.ts";

isolateProviderEnv();

function fakeJwt(authClaim: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64({ "https://api.openai.com/auth": authClaim })}.sig`;
}

function responsesModel(
  overrides: Partial<Model<Api>> & Pick<Model<Api>, "id" | "provider" | "api" | "baseUrl">,
): Model<Api> {
  return {
    name: overrides.id,
    input: ["text"],
    reasoning: true,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
    ...overrides,
  } as Model<Api>;
}

function sessionCtx(options: {
  model: Model<Api>;
  apiKey?: string;
  headers?: Record<string, string>;
  baseUrl?: string;
  ok?: boolean;
  sessionId?: string;
  thinkingLevel?: string;
}): ExtensionContext {
  return {
    model: options.model,
    thinkingLevel: options.thinkingLevel,
    sessionManager: {
      getSessionId: () => options.sessionId ?? "sess-test",
    },
    modelRegistry: {
      getApiKeyAndHeaders: async () =>
        options.ok === false
          ? { ok: false, error: "no auth" }
          : {
              ok: true,
              apiKey: options.apiKey,
              headers: options.headers,
              baseUrl: options.baseUrl,
            },
    },
  } as unknown as ExtensionContext;
}

test("normalizeSearchUrl strips tracking params but keeps YouTube queries", () => {
  assert.equal(
    normalizeSearchUrl("https://example.com/doc?utm_source=openai&utm_medium=web&ref=1#frag"),
    "https://example.com/doc",
  );
  assert.equal(
    normalizeSearchUrl("https://www.youtube.com/watch?v=abcdefghijk&utm_source=share"),
    "https://www.youtube.com/watch?v=abcdefghijk&utm_source=share",
  );
});

test("isLikelyJunkSearchUrl drops archives and fonts", () => {
  assert.equal(isLikelyJunkSearchUrl("https://cdn.example.com/font.woff2"), true);
  assert.equal(isLikelyJunkSearchUrl("https://example.com/docs/guide"), false);
});

test("applyIndexCitations inserts markers that match result order", () => {
  const text = "Node 26 is out.";
  const cited = applyIndexCitations(
    text,
    [{ url: "https://nodejs.org/v26", title: "Node", endIndex: 15 }],
    ["https://nodejs.org/v26"],
  );
  assert.equal(cited, "Node 26 is out.[1]");
});

test("isOpenAIResponsesModel accepts Copilot, Azure, Codex, OpenCode, and xAI", () => {
  assert.equal(
    isOpenAIResponsesModel(
      responsesModel({
        id: "gpt-5.6-sol",
        provider: "github-copilot",
        api: "openai-responses",
        baseUrl: "https://api.individual.githubcopilot.com",
      }),
    ),
    true,
  );
  assert.equal(
    isOpenAIResponsesModel(
      responsesModel({
        id: "gpt-5.6-terra",
        provider: "azure-openai-responses",
        api: "azure-openai-responses",
        baseUrl: "https://example.cognitiveservices.azure.com/openai/v1",
      }),
    ),
    true,
  );
  assert.equal(
    isOpenAIResponsesModel(
      responsesModel({
        id: "grok-4.6",
        provider: "xai",
        api: "openai-responses",
        baseUrl: "https://api.x.ai/v1",
      }),
    ),
    true,
  );
  assert.equal(
    isOpenAIResponsesModel(
      responsesModel({
        id: "claude-sonnet",
        provider: "anthropic",
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
      }),
    ),
    false,
  );
});

test("resolveGitHubCopilotBaseUrl prefers pi's credential URL and sanitizes proxy-ep", () => {
  const model = responsesModel({
    id: "gpt-5.6-sol",
    provider: "github-copilot",
    api: "openai-responses",
    baseUrl: "https://api.individual.githubcopilot.com",
  });
  assert.equal(
    resolveGitHubCopilotBaseUrl(model, "https://api.business.githubcopilot.com", "token"),
    "https://api.business.githubcopilot.com",
  );
  assert.equal(
    resolveGitHubCopilotBaseUrl(
      model,
      undefined,
      "tid=test;proxy-ep=proxy.business.githubcopilot.com;exp=9",
    ),
    "https://api.business.githubcopilot.com",
  );
  assert.equal(
    resolveGitHubCopilotBaseUrl(model, undefined, "tid=test;proxy-ep=evil.example.com;exp=9"),
    model.baseUrl,
  );
});

test("resolveOpenAIResponsesUrl appends /responses and Codex /codex/responses", () => {
  assert.equal(
    resolveOpenAIResponsesUrl(
      responsesModel({
        id: "gpt-5.6",
        provider: "openai",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
      }),
    ),
    "https://api.openai.com/v1/responses",
  );
  assert.equal(
    resolveOpenAIResponsesUrl(
      responsesModel({
        id: "gpt-5.5",
        provider: "openai-codex",
        api: "openai-codex-responses",
        baseUrl: "https://chatgpt.com/backend-api",
      }),
    ),
    "https://chatgpt.com/backend-api/codex/responses",
  );
});

test("getOpenCodeSessionHeaders mirrors pi's session id", () => {
  const model = responsesModel({
    id: "gpt-5.6-luna",
    provider: "opencode-go",
    api: "openai-responses",
    baseUrl: "https://opencode.ai/zen/go/v1",
  });
  assert.deepEqual(getOpenCodeSessionHeaders(model, sessionCtx({ model, sessionId: "abc" })), {
    "x-opencode-session": "abc",
    "x-opencode-client": "pi",
  });
});

test("availableSearchProviders includes openai for a Responses session model without OPENAI_API_KEY", (t) => {
  t.after(hidePiAuthFile());
  const ctx = sessionCtx({
    model: responsesModel({
      id: "gpt-5.6-sol",
      provider: "github-copilot",
      api: "openai-responses",
      baseUrl: "https://api.individual.githubcopilot.com",
    }),
    apiKey: "copilot-token",
  });
  assert.ok(availableSearchProviders({}, ctx).includes("openai"));
  assert.equal(availableSearchProviders({}).includes("openai"), false);
});

test("getProviderStatuses attributes openai to the session Responses model", () => {
  const ctx = sessionCtx({
    model: responsesModel({
      id: "gpt-5.6-sol",
      provider: "github-copilot",
      api: "openai-responses",
      baseUrl: "https://api.individual.githubcopilot.com",
    }),
    apiKey: "copilot-token",
  });
  const openai = getProviderStatuses(ctx).find((status) => status.name === "openai");
  assert.equal(openai?.configured, true);
  assert.equal(openai?.source, "session model (github-copilot/gpt-5.6-sol)");
  assert.equal(openai?.model, "gpt-5.6-sol");
});

test("resolveOpenAISearchRequest uses Copilot's credential-specific endpoint", async (t) => {
  t.after(hidePiAuthFile());
  const model = responsesModel({
    id: "gpt-5.6-sol",
    provider: "github-copilot",
    api: "openai-responses",
    baseUrl: "https://api.individual.githubcopilot.com",
  });
  const request = await resolveOpenAISearchRequest(
    sessionCtx({
      model,
      apiKey: "copilot-token",
      baseUrl: "https://api.business.githubcopilot.com",
      thinkingLevel: "low",
    }),
  );
  assert.ok(request);
  assert.equal(request.url, "https://api.business.githubcopilot.com/responses");
  assert.equal(request.model, "gpt-5.6-sol");
  assert.equal(request.headers.Authorization, "Bearer copilot-token");
  assert.equal(request.reasoning, "low");
  assert.equal(request.includeResults, true);
});

test("resolveOpenAISearchRequest adds OpenCode session headers", async (t) => {
  t.after(hidePiAuthFile());
  const model = responsesModel({
    id: "gpt-5.6-luna",
    provider: "opencode",
    api: "openai-responses",
    baseUrl: "https://opencode.ai/zen/v1",
  });
  const request = await resolveOpenAISearchRequest(
    sessionCtx({ model, apiKey: "oc-key", sessionId: "sess-9" }),
  );
  assert.ok(request);
  assert.equal(request.headers["x-opencode-session"], "sess-9");
  assert.equal(request.headers["x-opencode-client"], "pi");
});

test("resolveOpenAISearchRequest adds Codex originator and account id", async (t) => {
  t.after(hidePiAuthFile());
  const token = fakeJwt({ chatgpt_account_id: "acct_123" });
  const model = responsesModel({
    id: "gpt-5.5",
    provider: "openai-codex",
    api: "openai-codex-responses",
    baseUrl: "https://chatgpt.com/backend-api",
  });
  const request = await resolveOpenAISearchRequest(sessionCtx({ model, apiKey: token }));
  assert.ok(request);
  assert.equal(request.variant, "codex");
  assert.equal(request.url, "https://chatgpt.com/backend-api/codex/responses");
  assert.equal(request.headers.originator, "codex_cli_rs");
  assert.equal(request.headers["chatgpt-account-id"], "acct_123");
  assert.equal(request.includeResults, false);
});

test("searchOpenAI uses the Copilot session model instead of the dedicated OpenAI key", async (t) => {
  t.after(hidePiAuthFile());
  process.env.OPENAI_API_KEY = "sk-should-not-be-used";
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    delete process.env.OPENAI_API_KEY;
  });

  const model = responsesModel({
    id: "gpt-5.6-sol",
    provider: "github-copilot",
    api: "openai-responses",
    baseUrl: "https://api.individual.githubcopilot.com",
  });
  let sentUrl = "";
  let sentModel = "";
  globalThis.fetch = async (input, init) => {
    sentUrl = String(input);
    sentModel = (JSON.parse(String(init?.body)) as { model: string }).model;
    return new Response(
      JSON.stringify({
        output: [
          {
            type: "message",
            content: [
              {
                type: "text",
                text: "Copilot answer.",
                annotations: [
                  {
                    type: "url_citation",
                    url: "https://example.com/a?utm_source=openai",
                    title: "A",
                    start_index: 0,
                    end_index: 15,
                  },
                ],
              },
            ],
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  const res = await searchOpenAI(
    "q",
    {},
    sessionCtx({
      model,
      apiKey: "copilot-token",
      baseUrl: "https://api.business.githubcopilot.com",
    }),
  );
  assert.equal(sentUrl, "https://api.business.githubcopilot.com/responses");
  assert.equal(sentModel, "gpt-5.6-sol");
  assert.equal(res.results[0]?.url, "https://example.com/a");
  assert.equal(res.answer, "Copilot answer.[1]");
});

test("searchOpenAI streams SSE deltas through onUpdate", async (t) => {
  t.after(hidePiAuthFile());
  process.env.OPENAI_API_KEY = "sk-test";
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    delete process.env.OPENAI_API_KEY;
  });

  const sse = [
    "data: " + JSON.stringify({ type: "response.web_search_call.searching", item_id: "ws_1" }),
    "",
    "data: " + JSON.stringify({ type: "response.output_text.delta", delta: "Hello " }),
    "",
    "data: " + JSON.stringify({ type: "response.output_text.delta", delta: "world." }),
    "",
    "data: " +
      JSON.stringify({
        type: "response.completed",
        response: {
          output: [
            {
              type: "message",
              content: [{ type: "text", text: "Hello world.", annotations: [] }],
            },
          ],
        },
      }),
    "",
  ].join("\n");

  globalThis.fetch = async () =>
    new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });

  const updates: string[] = [];
  const res = await searchOpenAI("q", {
    onUpdate: (update) => {
      const text = update.content[0]?.text;
      if (text) updates.push(text);
    },
  });
  assert.ok(updates.some((text) => text.includes("Searching the web with OpenAI")));
  assert.ok(updates.includes("Hello world."));
  assert.equal(res.answer, "Hello world.");
});

test("searchOpenAI drops junk result URLs", async (t) => {
  t.after(hidePiAuthFile());
  process.env.OPENAI_API_KEY = "sk-test";
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    delete process.env.OPENAI_API_KEY;
  });

  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        output: [
          {
            type: "web_search_call",
            action: {
              sources: [
                { url: "https://cdn.example.com/font.woff2", title: "Font" },
                { url: "https://example.com/doc", title: "Doc" },
              ],
            },
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );

  const res = await searchOpenAI("q");
  assert.deepEqual(
    res.results.map((result) => result.url),
    ["https://example.com/doc"],
  );
});
