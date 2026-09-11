import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Context, Model, Tool } from "@earendil-works/pi-ai";
import {
  buildContextEntries,
  buildSessionContext,
  convertToLlm,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionBeforeCompactEvent,
  sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import {
  buildReplacementHistory,
  type CodexCheckpointDetails,
  checkpointMarker,
  createCheckpointDetails,
  fallbackSummary,
  latestCheckpoint,
  projectCheckpointContext,
} from "./checkpoint.ts";
import { resolveCompactionRoute, usesResponsesCompactionApi } from "./model-api.ts";
import { rewriteCheckpointMarkerIfPresent } from "./protocol.ts";
import { requestRemoteCompaction } from "./remote.ts";
import {
  type CompactSettings,
  type CompactSettingsRuntime,
  type CompactSettingsState,
  createCompactSettingsRuntime,
  parseCompactionModelRef,
} from "./settings.ts";
import { terminalText } from "./terminal.ts";

const STATUS_KEY = "remote-compact";

function activeCheckpoint(ctx: ExtensionContext) {
  return latestCheckpoint(ctx.sessionManager.getBranch());
}

function isCheckpointCompatible(
  details: CodexCheckpointDetails,
  model: Model<Api> | undefined,
): boolean {
  return (
    usesResponsesCompactionApi(model) && model.api === details.api && model.id === details.modelId
  );
}

function keptMessages(event: SessionBeforeCompactEvent): AgentMessage[] {
  const leafId = event.branchEntries.at(-1)?.id ?? null;
  const contextEntries = buildContextEntries(event.branchEntries, leafId);
  const keptIndex = contextEntries.findIndex(
    (entry) => entry.id === event.preparation.firstKeptEntryId,
  );
  if (keptIndex < 0) {
    throw new Error("Pi compaction cut point is not present in the active context");
  }
  return contextEntries.slice(keptIndex).flatMap(sessionEntryToContextMessages);
}

/** Texts of user messages Pi keeps verbatim — excluding them from retained history avoids replaying them twice per turn. */
function keptUserTexts(kept: readonly AgentMessage[]): Set<string> {
  const texts = new Set<string>();
  for (const message of kept) {
    if (message.role !== "user") continue;
    const content = message.content;
    const text =
      typeof content === "string"
        ? content
        : content
            .flatMap((part) =>
              part.type === "text" && typeof part.text === "string" ? [part.text] : [],
            )
            .join("\n");
    if (text) texts.add(text);
  }
  return texts;
}

function activeTools(pi: ExtensionAPI): Tool[] {
  const available = new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
  return pi.getActiveTools().flatMap((name) => {
    const tool = available.get(name);
    return tool
      ? [
          {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          },
        ]
      : [];
  });
}

function projectedCurrentMessages(
  event: SessionBeforeCompactEvent,
  model: Model<Api>,
): { messages: AgentMessage[]; prior?: CodexCheckpointDetails } {
  const leafId = event.branchEntries.at(-1)?.id ?? null;
  const session = buildSessionContext(event.branchEntries, leafId);
  const prior = latestCheckpoint(event.branchEntries);
  if (!prior) return { messages: session.messages };
  if (prior.details.api !== model.api || prior.details.modelId !== model.id) {
    throw new Error("The active opaque checkpoint belongs to a different Responses model");
  }
  const projected = projectCheckpointContext(session.messages, prior.details, prior.entry.summary);
  if (!projected) {
    throw new Error("The previous opaque checkpoint could not be projected safely");
  }
  return { messages: projected, prior: prior.details };
}

function notifyFailure(ctx: ExtensionContext, error: unknown, settings: CompactSettings): void {
  if (!ctx.hasUI || !settings.notifyOnFallback) return;
  const message = terminalText(error instanceof Error ? error.message : String(error));
  ctx.ui.notify(`Responses compaction failed; using Pi compaction. ${message}`, "warning");
}

function sessionStillOwned(ctx: ExtensionContext, sessionId: string, signal: AbortSignal): boolean {
  return !signal.aborted && ctx.sessionManager.getSessionId() === sessionId;
}

/** 4xx-style "endpoint does not exist" failures will never succeed on retry. */
export function isPermanentRouteFailure(message: string): boolean {
  return /\(4\d\d\)|\b404\b|not found|does not exist|unsupported/i.test(message);
}

/**
 * Pick the model that performs the remote compaction call. The opaque
 * checkpoint it produces is not bound to the producing model on the Codex
 * backend (verified empirically: a luna-produced item replays correctly on
 * sol, terra, and astra), so a cheaper model can compact for the session.
 * Falls back to the session model when the configured model is missing or
 * belongs to a different provider/backend.
 */
export function pickCompactionModel(
  ctx: ExtensionContext,
  sessionModel: Model<Api> | undefined,
  settings: CompactSettings,
  warned?: Set<string>,
): Model<Api> | undefined {
  const ref = settings.compactionModel.trim();
  if (!ref || !sessionModel) return sessionModel;
  const parsed = parseCompactionModelRef(ref);
  const found = parsed ? ctx.modelRegistry.find(parsed.provider, parsed.modelId) : undefined;
  if (found && found.provider === sessionModel.provider && usesResponsesCompactionApi(found)) {
    return found;
  }
  const key = `${sessionModel.provider}/${sessionModel.id}->${ref}`;
  if (ctx.hasUI && warned && !warned.has(key)) {
    warned.add(key);
    ctx.ui.notify(
      `Compaction model "${terminalText(ref)}" is unavailable for this session; using the session model.`,
      "warning",
    );
  }
  return sessionModel;
}

async function compactRemotely(
  pi: ExtensionAPI,
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
  settings: CompactSettings,
  ownerSignal: AbortSignal,
  fetch: typeof globalThis.fetch | undefined,
  modelWarnings: Set<string>,
  failedRoutes: Map<string, number>,
) {
  const sessionModel = ctx.model;
  // Remote compaction is hard-gated to the OpenAI Codex provider; every other
  // provider (github-copilot's /responses/compact is a verified 404, azure,
  // generic openai-responses backends) goes straight to Pi native compaction.
  if (sessionModel?.provider !== "openai-codex") return undefined;
  const model = pickCompactionModel(ctx, sessionModel, settings, modelWarnings);
  const route = resolveCompactionRoute(model, settings);
  if (route.kind === "native" || !usesResponsesCompactionApi(model)) return undefined;
  // Definitive failures blacklist the route for this session immediately;
  // transient errors get one more chance next time.
  const routeKey = `${model.provider}/${model.id}/${route.protocol}`;
  if ((failedRoutes.get(routeKey) ?? 0) >= 2) return undefined;
  // The checkpoint can only replay on a Responses model; when the session model
  // cannot replay it, remote compaction is strictly worse than Pi's summary.
  if (!usesResponsesCompactionApi(sessionModel)) return undefined;
  const signal = AbortSignal.any([event.signal, ownerSignal]);
  if (signal.aborted) return { cancel: true };
  const sessionId = ctx.sessionManager.getSessionId();
  const label = route.protocol === "remote-v2" ? "Responses Remote V2" : "Responses Compact API";
  ctx.ui.setStatus(
    STATUS_KEY,
    model.id === sessionModel.id ? `${label}…` : `${label} via ${model.id}…`,
  );
  try {
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!sessionStillOwned(ctx, sessionId, signal)) return { cancel: true };
    if (!auth.ok) throw new Error(auth.error);
    const provider = ctx.modelRegistry.getProvider(model.provider);
    if (!provider) throw new Error("The active Responses provider is unavailable");
    const current = projectedCurrentMessages(event, sessionModel);
    const context: Context = {
      systemPrompt: ctx.getSystemPrompt(),
      messages: convertToLlm(current.messages),
      tools: activeTools(pi),
    };
    const response = await requestRemoteCompaction({
      provider,
      model,
      context,
      protocol: route.protocol,
      apiKey: auth.apiKey,
      headers: auth.headers,
      env: auth.env,
      signal,
      sessionId,
      reasoningEffort: ctx.thinkingLevel === "off" ? undefined : ctx.thinkingLevel,
      priorCheckpoint: current.prior
        ? {
            marker: checkpointMarker(current.prior.checkpointId),
            replacementHistory: current.prior.replacementHistory,
          }
        : undefined,
      requestTimeoutMs: settings.requestTimeoutMs,
      maxRetries: settings.maxRetries,
      fetch,
    });
    if (!sessionStillOwned(ctx, sessionId, signal)) return { cancel: true };
    const kept = keptMessages(event);
    const replacementHistory = buildReplacementHistory(
      response.compactedOutput?.slice(0, -1) ?? response.promptInput,
      response.item,
      {
        tokenBudget: settings.replacementTokenBudget,
        excludeTexts: keptUserTexts(kept),
      },
    );
    // The checkpoint records the session model, not the compaction model:
    // replay compatibility is gated on the model that will consume it.
    const details = createCheckpointDetails({
      provider: sessionModel.provider,
      api: sessionModel.api,
      modelId: sessionModel.id,
      protocol: route.protocol,
      replacementHistory,
      keptMessages: kept,
    });
    return {
      compaction: {
        summary: fallbackSummary(details.checkpointId),
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
        usage: response.usage,
        details,
      },
    };
  } catch (error) {
    if (signal.aborted || ctx.sessionManager.getSessionId() !== sessionId) {
      return { cancel: true };
    }
    const message = error instanceof Error ? error.message : String(error);
    failedRoutes.set(
      routeKey,
      (failedRoutes.get(routeKey) ?? 0) + (isPermanentRouteFailure(message) ? 2 : 1),
    );
    notifyFailure(ctx, error, settings);
    return undefined;
  } finally {
    if (ctx.sessionManager.getSessionId() === sessionId) ctx.ui.setStatus(STATUS_KEY, undefined);
  }
}

export function createCompactExtension(
  options: { fetch?: typeof globalThis.fetch; settingsRuntime?: CompactSettingsRuntime } = {},
): (pi: ExtensionAPI) => void {
  return (pi) => {
    const providerWarnings = new Set<string>();
    const failedRoutes = new Map<string, number>();
    const settingsRuntime = options.settingsRuntime ?? createCompactSettingsRuntime();
    let sessionController = new AbortController();
    let generation = 0;

    const notify = (
      ctx: ExtensionContext,
      message: string,
      level: "info" | "warning" | "error",
    ) => {
      if (ctx.hasUI) ctx.ui.notify(message, level);
    };

    pi.registerCommand("remote-compact", {
      description:
        "Responses compaction. Usage: /remote-compact [now|status|on|off|model <provider/id>|model session]",
      handler: async (args, ctx) => {
        const [sub, ...rest] = args.trim().split(/\s+/).filter(Boolean);
        const state = settingsRuntime.get();
        if (sub === undefined || sub === "status") {
          const sessionModel = ctx.model;
          const compactModel = pickCompactionModel(
            ctx,
            sessionModel,
            state.settings,
            providerWarnings,
          );
          const route = resolveCompactionRoute(compactModel, state.settings);
          notify(
            ctx,
            [
              `Remote compaction: ${state.settings.enabled ? "on" : "off"}`,
              `Protocol: ${state.settings.protocol} → ${route.kind === "native" ? `Pi native (${route.reason})` : route.protocol}`,
              `Session model: ${sessionModel ? `${sessionModel.provider}/${sessionModel.id}` : "none"}`,
              `Compaction model: ${state.settings.compactionModel || "(session model)"} → ${compactModel ? `${compactModel.provider}/${compactModel.id}` : "none"}`,
              `Settings: ${state.path}`,
            ].join("\n"),
            "info",
          );
          return;
        }
        if (sub === "now") {
          ctx.compact({
            onError: (error) =>
              notify(ctx, `Compaction failed: ${terminalText(error.message)}`, "error"),
          });
          return;
        }
        if (sub === "on" || sub === "off") {
          await settingsRuntime.update({ enabled: sub === "on" }, sessionController.signal);
          notify(ctx, `Remote compaction ${sub === "on" ? "enabled" : "disabled"}.`, "info");
          return;
        }
        if (sub === "model") {
          const ref = rest.join(" ").trim();
          if (!ref) {
            notify(
              ctx,
              `Compaction model: ${state.settings.compactionModel || "(session model)"}`,
              "info",
            );
            return;
          }
          const value = ref === "session" ? "" : ref;
          const parsed = value ? parseCompactionModelRef(value) : undefined;
          if (value && !parsed) {
            throw new Error("Usage: /remote-compact model <provider/model-id> | session");
          }
          await settingsRuntime.update({ compactionModel: value }, sessionController.signal);
          if (value && parsed && !ctx.modelRegistry.find(parsed.provider, parsed.modelId)) {
            notify(
              ctx,
              `Saved "${terminalText(value)}" (not in the model registry yet).`,
              "warning",
            );
          } else {
            notify(
              ctx,
              value
                ? `Compaction model set to ${terminalText(value)}.`
                : "Compaction model reset to the session model.",
              "info",
            );
          }
          return;
        }
        throw new Error(
          "Usage: /remote-compact [now|status|on|off|model <provider/id>|model session]",
        );
      },
    });

    pi.on("session_start", async (_event, ctx) => {
      sessionController.abort();
      sessionController = new AbortController();
      generation += 1;
      const ownerGeneration = generation;
      const sessionId = ctx.sessionManager.getSessionId();
      providerWarnings.clear();
      failedRoutes.clear();
      let state: Readonly<CompactSettingsState>;
      try {
        state = await settingsRuntime.reload(sessionController.signal);
      } catch (error) {
        if (sessionController.signal.aborted || ownerGeneration !== generation) return;
        if (ctx.hasUI) {
          ctx.ui.notify(
            `Could not load pi-compact.json; using defaults. ${terminalText(error instanceof Error ? error.message : String(error))}`,
            "warning",
          );
        }
        return;
      }
      if (
        sessionController.signal.aborted ||
        ownerGeneration !== generation ||
        ctx.sessionManager.getSessionId() !== sessionId
      ) {
        return;
      }
      if (ctx.hasUI && state.kind === "invalid") {
        ctx.ui.notify(
          `Invalid pi-compact.json; using defaults without overwriting it. ${terminalText(state.issue ?? "unknown validation error")}`,
          "warning",
        );
      }
    });

    pi.on("session_before_compact", (event, ctx) =>
      compactRemotely(
        pi,
        event,
        ctx,
        settingsRuntime.get().settings,
        sessionController.signal,
        options.fetch,
        providerWarnings,
        failedRoutes,
      ),
    );

    pi.on("context", (event, ctx) => {
      if (!settingsRuntime.get().settings.enabled) return undefined;
      const checkpoint = activeCheckpoint(ctx);
      if (!checkpoint || !isCheckpointCompatible(checkpoint.details, ctx.model)) return undefined;
      const messages = projectCheckpointContext(
        event.messages,
        checkpoint.details,
        checkpoint.entry.summary,
      );
      return messages ? { messages } : undefined;
    });

    pi.on("before_provider_request", (event, ctx) => {
      if (!settingsRuntime.get().settings.enabled) return undefined;
      const checkpoint = activeCheckpoint(ctx);
      if (!checkpoint || !isCheckpointCompatible(checkpoint.details, ctx.model)) return undefined;
      return rewriteCheckpointMarkerIfPresent(
        event.payload,
        checkpointMarker(checkpoint.details.checkpointId),
        checkpoint.details.replacementHistory,
      );
    });

    pi.on("model_select", (event, ctx) => {
      if (!settingsRuntime.get().settings.enabled) return;
      const checkpoint = activeCheckpoint(ctx);
      if (!checkpoint || isCheckpointCompatible(checkpoint.details, event.model)) return;
      const key = `${ctx.sessionManager.getSessionId()}:${event.model.provider}:${event.model.id}`;
      if (providerWarnings.has(key)) return;
      providerWarnings.add(key);
      if (ctx.hasUI) {
        ctx.ui.notify(
          "The active Responses checkpoint cannot replay on this model; Pi will expose only its fallback marker and retained recent messages.",
          "warning",
        );
      }
    });

    pi.on("session_shutdown", async (_event, ctx) => {
      generation += 1;
      sessionController.abort();
      providerWarnings.clear();
      failedRoutes.clear();
      ctx.ui.setStatus(STATUS_KEY, undefined);
      await settingsRuntime.flush();
    });
  };
}

export default createCompactExtension();
