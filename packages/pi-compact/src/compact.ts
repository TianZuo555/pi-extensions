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
  CHECKPOINT_KIND,
  type CodexCheckpointDetails,
  createCheckpointDetails,
  latestCheckpoint,
  projectCheckpointContext,
} from "./checkpoint.ts";
import {
  resolveCompactionRoute,
  sameResponsesBackend,
  usesResponsesCompactionApi,
} from "./model-api.ts";
import { checkpointMarker, compactionSystemPrompt, fallbackSummary } from "./prompt.ts";
import { rewriteCheckpointMarkerIfPresent } from "./protocol.ts";
import { requestRemoteCompaction } from "./remote.ts";
import { routeFailureStatus } from "./remote-types.ts";
import {
  type CompactSettings,
  type CompactSettingsRuntime,
  type CompactSettingsState,
  createCompactSettingsRuntime,
  parseCompactionModelRef,
} from "./settings.ts";
import { terminalText } from "./terminal.ts";

const STATUS_KEY = "remote-compact";
/** Give up on a route for the session after this many consecutive failures of any kind. */
const MAX_ROUTE_FAILURES = 3;
const PERMANENT_ROUTE_STATUSES = [404, 405, 410, 501];

type FailedRoute = {
  /** Consecutive failures on this route since its last success. */
  failures: number;
  /** Set once the route is abandoned for this session. */
  disabled: boolean;
  /** One native-fallback reminder per disabled route. */
  reminderShown: boolean;
};

type SessionState = {
  modelWarnings: Set<string>;
  failedRoutes: Map<string, FailedRoute>;
  /** Notification texts already shown; repeating the same warning every turn is noise. */
  notices: Set<string>;
};

function createSessionState(): SessionState {
  return { modelWarnings: new Set(), failedRoutes: new Map(), notices: new Set() };
}

function activeCheckpoint(ctx: ExtensionContext) {
  return latestCheckpoint(ctx.sessionManager.getBranch());
}

function isCheckpointCompatible(
  details: CodexCheckpointDetails,
  model: Model<Api> | undefined,
  ctx: ExtensionContext,
): boolean {
  if (
    !usesResponsesCompactionApi(model) ||
    model.provider !== "openai-codex" ||
    details.provider !== "openai-codex" ||
    model.api !== details.api
  )
    return false;
  const originalModel = ctx.modelRegistry.find(details.provider, details.modelId);
  // Do not infer backend compatibility when the original model has left the catalogue.
  return originalModel ? sameResponsesBackend(originalModel, model) : model.id === details.modelId;
}

/** A malformed opaque checkpoint must not silently become an ordinary native summary either. */
function hasOpaqueCheckpoint(event: SessionBeforeCompactEvent): boolean {
  for (let index = event.branchEntries.length - 1; index >= 0; index--) {
    const entry = event.branchEntries[index];
    if (entry.type !== "compaction") continue;
    const details: unknown = entry.details;
    return (
      typeof details === "object" &&
      details !== null &&
      "kind" in details &&
      details.kind === CHECKPOINT_KIND
    );
  }
  return false;
}

function notifyOnce(state: SessionState, ctx: ExtensionContext, message: string): void {
  if (!ctx.hasUI || state.notices.has(message)) return;
  ctx.ui.notify(message, "warning");
  // Only a delivered notification counts; a throwing UI must be retried next time.
  state.notices.add(message);
}

function nativeFallbackOrCancel(
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
  settings: CompactSettings,
  state: SessionState,
  reason: string,
): { cancel: true } | undefined {
  if (!hasOpaqueCheckpoint(event)) return undefined;
  const detail = terminalText(reason);
  if (settings.allowLossyNativeFallback) {
    notifyOnce(
      state,
      ctx,
      `Opaque checkpoint history will be dropped. ${detail} Pi's native summary cannot read the older history stored in the checkpoint.`,
    );
    return undefined;
  }
  notifyOnce(
    state,
    ctx,
    `Compaction cancelled; preserving the existing opaque checkpoint. ${detail} Native compaction cannot read its older history.`,
  );
  return { cancel: true };
}

/** True when a native fallback is allowed only because the user opted into dropping the checkpoint. */
function allowsLossyFallback(event: SessionBeforeCompactEvent, settings: CompactSettings): boolean {
  return settings.allowLossyNativeFallback && hasOpaqueCheckpoint(event);
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

/** These user messages are covered by the opaque checkpoint; omit their extra plaintext copies. */
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
  ctx: ExtensionContext,
): { messages: AgentMessage[]; prior?: CodexCheckpointDetails } {
  const leafId = event.branchEntries.at(-1)?.id ?? null;
  const session = buildSessionContext(event.branchEntries, leafId);
  const prior = latestCheckpoint(event.branchEntries);
  if (!prior) return { messages: session.messages };
  if (!isCheckpointCompatible(prior.details, model, ctx)) {
    throw new Error("The active opaque checkpoint belongs to a different Responses backend");
  }
  const projected = projectCheckpointContext(session.messages, prior.details, prior.entry.summary);
  if (!projected) {
    throw new Error("The previous opaque checkpoint could not be projected safely");
  }
  return { messages: projected, prior: prior.details };
}

function notifyFailure(
  ctx: ExtensionContext,
  settings: CompactSettings,
  state: SessionState,
  error: unknown,
): void {
  if (!settings.notifyOnFallback) return;
  const message = terminalText(error instanceof Error ? error.message : String(error));
  notifyOnce(state, ctx, `Responses compaction failed; using Pi compaction. ${message}`);
}

function sessionStillOwned(ctx: ExtensionContext, sessionId: string, signal: AbortSignal): boolean {
  return !signal.aborted && ctx.sessionManager.getSessionId() === sessionId;
}

/** Heuristic for invalid/missing routes; auth, timeouts and rate limits can recover. */
export function isPermanentRouteFailure(message: string, status?: number): boolean {
  // The provider reports the status directly whenever it reached an endpoint.
  if (status !== undefined && PERMANENT_ROUTE_STATUSES.includes(status)) return true;
  // Otherwise require HTTP/status context, not a bare number embedded in an arbitrary message.
  const explicitStatus =
    /\b(?:HTTP(?:\/[\d.]+)?(?:\s+status(?:\s+code)?)?|(?:HTTP|API)\s+error|status(?:\s+code)?)\s*[:=(]?\s*(?:404|405|410|501)\b/i;
  const statusLine =
    /^\s*(?:404\s+(?:page\s+)?not found|405\s+method not allowed|410\s+gone|501\s+not implemented)\b/i;
  const invalidRoute =
    /\binvalid URL\b|\b(?:unknown|unsupported) (?:endpoint|route)\b|\b(?:endpoint|route) (?:is )?(?:not found|unsupported|does not exist)\b/i;
  // Providers surface the raw error body or status text, so accept unambiguous whole-message forms.
  const bareStatus =
    /^\s*(?:404|405|410|501)(?:\s+(?:page\s+)?not found| method not allowed| gone| not implemented)?\s*$/i;
  const bareNotFound = /^\s*(?:\{\s*"detail"\s*:\s*)?"?not found"?\s*\}?\s*$/i;
  const trailingStatus = /[(:]\s*(?:404|405|410|501)\s*[)\]}]?\s*$/;
  return (
    explicitStatus.test(message) ||
    statusLine.test(message) ||
    invalidRoute.test(message) ||
    bareStatus.test(message) ||
    bareNotFound.test(message) ||
    trailingStatus.test(message)
  );
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
  if (found && usesResponsesCompactionApi(found) && sameResponsesBackend(found, sessionModel)) {
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
  state: SessionState,
) {
  const sessionModel = ctx.model;
  // Remote compaction is hard-gated to the OpenAI Codex provider; every other
  // provider (github-copilot's /responses/compact is a verified 404, azure,
  // generic openai-responses backends) goes straight to Pi native compaction.
  if (event.signal.aborted || ownerSignal.aborted) return { cancel: true };
  if (!settings.enabled) {
    return nativeFallbackOrCancel(
      event,
      ctx,
      settings,
      state,
      "Enable remote compaction before retrying /compact.",
    );
  }
  if (sessionModel?.provider !== "openai-codex") {
    return nativeFallbackOrCancel(
      event,
      ctx,
      settings,
      state,
      "Switch back to the original Codex provider to compact.",
    );
  }
  const model = pickCompactionModel(ctx, sessionModel, settings, state.modelWarnings);
  const route = resolveCompactionRoute(model, settings);
  if (route.kind === "native" || !usesResponsesCompactionApi(model)) {
    const reason =
      route.kind === "native" ? route.reason : "No compatible Responses model is available.";
    const cancelled = nativeFallbackOrCancel(event, ctx, settings, state, reason);
    if (
      !cancelled &&
      !allowsLossyFallback(event, settings) &&
      settings.protocol === "responses-compact"
    ) {
      notifyFailure(ctx, settings, state, new Error(reason));
    }
    return cancelled;
  }
  const routeKey = `${model.provider}/${model.baseUrl}/${model.id}/${route.protocol}`;
  const failedRoute = state.failedRoutes.get(routeKey);
  if (failedRoute?.disabled) {
    const reason = "This remote route is unavailable; reload after correcting its configuration.";
    const cancelled = nativeFallbackOrCancel(event, ctx, settings, state, reason);
    if (!cancelled && ctx.hasUI && settings.notifyOnFallback && !failedRoute.reminderShown) {
      ctx.ui.notify(
        `Remote compaction remains disabled for this route; using Pi compaction. ${reason}`,
        "warning",
      );
      failedRoute.reminderShown = true;
    }
    return cancelled;
  }
  if (!usesResponsesCompactionApi(sessionModel)) {
    return nativeFallbackOrCancel(
      event,
      ctx,
      settings,
      state,
      "The session model cannot replay Responses checkpoints.",
    );
  }
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
    if (hasOpaqueCheckpoint(event) && !latestCheckpoint(event.branchEntries)) {
      throw new Error("The existing opaque checkpoint is invalid and cannot be replayed safely");
    }
    const current = projectedCurrentMessages(event, sessionModel, ctx);
    const context: Context = {
      systemPrompt: compactionSystemPrompt(ctx.getSystemPrompt(), event.customInstructions),
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
    // Keep the session model as provenance; replay is gated by backend, not model identity.
    const details = createCheckpointDetails({
      provider: sessionModel.provider,
      api: sessionModel.api,
      modelId: sessionModel.id,
      protocol: route.protocol,
      replacementHistory,
      keptMessages: kept,
    });
    state.failedRoutes.delete(routeKey);
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
    const permanent = isPermanentRouteFailure(message, routeFailureStatus(error));
    const failure = state.failedRoutes.get(routeKey) ?? {
      failures: 0,
      disabled: false,
      reminderShown: false,
    };
    failure.failures += 1;
    failure.disabled = permanent || failure.failures >= MAX_ROUTE_FAILURES;
    state.failedRoutes.set(routeKey, failure);
    const reason = failure.disabled
      ? `${message} This route is disabled for the session; /reload to retry.`
      : message;
    const cancelled = nativeFallbackOrCancel(event, ctx, settings, state, reason);
    if (!cancelled && !allowsLossyFallback(event, settings)) {
      notifyFailure(ctx, settings, state, error);
    }
    return cancelled;
  } finally {
    if (ctx.sessionManager.getSessionId() === sessionId) ctx.ui.setStatus(STATUS_KEY, undefined);
  }
}

export function createCompactExtension(
  options: { fetch?: typeof globalThis.fetch; settingsRuntime?: CompactSettingsRuntime } = {},
): (pi: ExtensionAPI) => void {
  return (pi) => {
    const state = createSessionState();
    const settingsRuntime = options.settingsRuntime ?? createCompactSettingsRuntime();
    let sessionController = new AbortController();
    let generation = 0;

    pi.on("session_start", async (_event, ctx) => {
      sessionController.abort();
      sessionController = new AbortController();
      generation += 1;
      const ownerGeneration = generation;
      const sessionId = ctx.sessionManager.getSessionId();
      state.modelWarnings.clear();
      state.failedRoutes.clear();
      state.notices.clear();
      let loaded: Readonly<CompactSettingsState>;
      try {
        loaded = await settingsRuntime.reload(sessionController.signal);
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
      if (ctx.hasUI && loaded.kind === "invalid") {
        ctx.ui.notify(
          `Invalid pi-compact.json; using defaults without overwriting it. ${terminalText(loaded.issue ?? "unknown validation error")}`,
          "warning",
        );
      }
    });

    pi.on("session_before_compact", async (event, ctx) => {
      try {
        return await compactRemotely(
          pi,
          event,
          ctx,
          settingsRuntime.get().settings,
          sessionController.signal,
          options.fetch,
          state,
        );
      } catch (error) {
        // Pi's runner turns a thrown handler error into undefined, enabling native compaction.
        // Cover settings/model selection, UI callbacks and finally blocks too. Reporting is best
        // effort and must never replace the cancellation itself.
        if (!hasOpaqueCheckpoint(event)) throw error;
        try {
          notifyOnce(
            state,
            ctx,
            `Compaction cancelled after an unexpected failure; preserving the existing opaque checkpoint. ${terminalText(error instanceof Error ? error.message : String(error))}`,
          );
        } catch {
          // A broken notification must not turn cancellation into a thrown error.
        }
        try {
          ctx.ui.setStatus(STATUS_KEY, undefined);
        } catch {
          // A broken status update must not turn cancellation into a thrown error.
        }
        return { cancel: true };
      }
    });

    pi.on("context", (event, ctx) => {
      const checkpoint = activeCheckpoint(ctx);
      if (!checkpoint || !isCheckpointCompatible(checkpoint.details, ctx.model, ctx))
        return undefined;
      const messages = projectCheckpointContext(
        event.messages,
        checkpoint.details,
        checkpoint.entry.summary,
      );
      return messages ? { messages } : undefined;
    });

    pi.on("before_provider_request", (event, ctx) => {
      const checkpoint = activeCheckpoint(ctx);
      if (!checkpoint || !isCheckpointCompatible(checkpoint.details, ctx.model, ctx))
        return undefined;
      return rewriteCheckpointMarkerIfPresent(
        event.payload,
        checkpointMarker(checkpoint.details.checkpointId),
        checkpoint.details.replacementHistory,
      );
    });

    pi.on("model_select", (event, ctx) => {
      const checkpoint = activeCheckpoint(ctx);
      if (!checkpoint || isCheckpointCompatible(checkpoint.details, event.model, ctx)) return;
      const key = `${ctx.sessionManager.getSessionId()}:${event.model.provider}:${event.model.id}`;
      if (state.modelWarnings.has(key)) return;
      state.modelWarnings.add(key);
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
      state.modelWarnings.clear();
      state.failedRoutes.clear();
      state.notices.clear();
      ctx.ui.setStatus(STATUS_KEY, undefined);
      await settingsRuntime.flush();
    });
  };
}

export default createCompactExtension();
