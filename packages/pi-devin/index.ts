/**
 * pi-devin — use Devin models in pi via `devin acp` (Agent Client Protocol).
 *
 * One `devin acp` child process hosts ACP sessions; the current pi branch is
 * bound to one devin session id, persisted across reloads. devin's own agent
 * loop (tools, plans, compaction) runs server-side; pi renders streamed text,
 * thinking, tool cards, and usage.
 */

import { Type } from "typebox";
import type {
  ExtensionAPI,
  ExtensionContext,
  ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { DevinAcpClient } from "./lib/acp-client.ts";
import { piConfigDir, readJson, writeJson } from "./lib/config.ts";
import { checkDevinBinary, MIN_DEVIN_VERSION, runDevinCommand } from "./lib/diagnostics.ts";
import {
  devinGroups,
  groupThinkingLevelMap,
  parseDevinModels,
  type DevinModelFamily,
  modelCacheTtlMs,
} from "./lib/models.ts";
import { WRAPPER_TOOL_DESCRIPTION, WRAPPER_TOOL_NAME } from "./lib/prompt.ts";
import { DevinReplayStore, type RecordedDevinTool } from "./lib/replay.ts";
import { formatDevinCall, summarizeDevinResult } from "./lib/render.ts";
import {
  DEVIN_SESSION_STATE_ENTRY,
  restorableDevinSession,
  type PersistedDevinSession,
} from "./lib/session-state.ts";
import { streamDevin } from "./src/provider.ts";
import { createDevinRuntime, DevinRuntime, runDevin } from "./src/runtime.ts";
import { runDevinSessionsPicker } from "./src/sessions-ui.ts";

const DEVIN_PROVIDER = "devin";
const MODEL_CACHE_FILE = `${piConfigDir("devin")}/models.json`;
const DEFAULT_MODE = "accept-edits";

interface DevinModelCache {
  fetchedAt: number;
  source: "live" | "fallback";
  families: DevinModelFamily[];
}

/** Bundled snapshot of `devin models list` (devin 3000.10.x, 2026-09). */
const FALLBACK_FAMILIES: DevinModelFamily[] = [
  {
    id: "adaptive",
    name: "Adaptive",
    aliases: [],
    rows: [
      {
        id: "adaptive",
        name: "Adaptive",
        contextWindow: 262144,
        cost: { input: 0.5, output: 2, cacheRead: 0.1, cacheWrite: 0 },
      },
    ],
  },
  {
    id: "swe-2",
    name: "SWE-2",
    aliases: ["swe"],
    rows: [
      {
        id: "swe-2-high",
        name: "SWE-2 High",
        contextWindow: 262000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        effort: "high",
      },
      {
        id: "swe-2-medium",
        name: "SWE-2 Medium",
        contextWindow: 262000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        effort: "medium",
      },
      {
        id: "swe-2-max",
        name: "SWE-2 Max",
        contextWindow: 262000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        effort: "max",
      },
    ],
  },
  {
    id: "claude-opus-5",
    name: "Claude Opus 5",
    aliases: ["opus"],
    rows: [
      {
        id: "claude-opus-5-low",
        name: "Claude Opus 5 Low",
        contextWindow: 1000000,
        cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 0 },
        effort: "low",
      },
      {
        id: "claude-opus-5-low-fast",
        name: "Claude Opus 5 Low Fast",
        contextWindow: 1000000,
        cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 0 },
        effort: "low",
        fast: true,
      },
      {
        id: "claude-opus-5-medium",
        name: "Claude Opus 5 Medium",
        contextWindow: 1000000,
        cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 0 },
        effort: "medium",
      },
      {
        id: "claude-opus-5-medium-fast",
        name: "Claude Opus 5 Medium Fast",
        contextWindow: 1000000,
        cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 0 },
        effort: "medium",
        fast: true,
      },
      {
        id: "claude-opus-5-high",
        name: "Claude Opus 5 High",
        contextWindow: 1000000,
        cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 0 },
        effort: "high",
      },
      {
        id: "claude-opus-5-high-fast",
        name: "Claude Opus 5 High Fast",
        contextWindow: 1000000,
        cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 0 },
        effort: "high",
        fast: true,
      },
      {
        id: "claude-opus-5-xhigh",
        name: "Claude Opus 5 Xhigh",
        contextWindow: 1000000,
        cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 0 },
        effort: "xhigh",
      },
      {
        id: "claude-opus-5-xhigh-fast",
        name: "Claude Opus 5 Xhigh Fast",
        contextWindow: 1000000,
        cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 0 },
        effort: "xhigh",
        fast: true,
      },
      {
        id: "claude-opus-5-max",
        name: "Claude Opus 5 Max",
        contextWindow: 1000000,
        cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 0 },
        effort: "max",
      },
      {
        id: "claude-opus-5-max-fast",
        name: "Claude Opus 5 Max Fast",
        contextWindow: 1000000,
        cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 0 },
        effort: "max",
        fast: true,
      },
    ],
  },
  {
    id: "gpt-5.5",
    name: "GPT-5.5",
    aliases: [],
    rows: [
      {
        id: "gpt-5-5-none",
        name: "GPT-5.5 No Thinking",
        contextWindow: 272000,
        cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
        effort: "none",
      },
      {
        id: "gpt-5-5-none-priority",
        name: "GPT-5.5 No Thinking Fast",
        contextWindow: 272000,
        cost: { input: 12.5, output: 75, cacheRead: 1.25, cacheWrite: 0 },
        effort: "none",
        fast: true,
      },
      {
        id: "gpt-5-5-low",
        name: "GPT-5.5 Low Thinking",
        contextWindow: 272000,
        cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
        effort: "low",
      },
      {
        id: "gpt-5-5-low-priority",
        name: "GPT-5.5 Low Thinking Fast",
        contextWindow: 272000,
        cost: { input: 12.5, output: 75, cacheRead: 1.25, cacheWrite: 0 },
        effort: "low",
        fast: true,
      },
      {
        id: "gpt-5-5-medium",
        name: "GPT-5.5 Medium Thinking",
        contextWindow: 272000,
        cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
        effort: "medium",
      },
      {
        id: "gpt-5-5-medium-priority",
        name: "GPT-5.5 Medium Thinking Fast",
        contextWindow: 272000,
        cost: { input: 12.5, output: 75, cacheRead: 1.25, cacheWrite: 0 },
        effort: "medium",
        fast: true,
      },
      {
        id: "gpt-5-5-high",
        name: "GPT-5.5 High Thinking",
        contextWindow: 272000,
        cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
        effort: "high",
      },
      {
        id: "gpt-5-5-high-priority",
        name: "GPT-5.5 High Thinking Fast",
        contextWindow: 272000,
        cost: { input: 12.5, output: 75, cacheRead: 1.25, cacheWrite: 0 },
        effort: "high",
        fast: true,
      },
      {
        id: "gpt-5-5-xhigh",
        name: "GPT-5.5 XHigh Thinking",
        contextWindow: 272000,
        cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
        effort: "xhigh",
      },
      {
        id: "gpt-5-5-xhigh-priority",
        name: "GPT-5.5 XHigh Thinking Fast",
        contextWindow: 272000,
        cost: { input: 12.5, output: 75, cacheRead: 1.25, cacheWrite: 0 },
        effort: "xhigh",
        fast: true,
      },
    ],
  },
  {
    id: "claude-sonnet-4.6",
    name: "Claude Sonnet 4.6",
    aliases: ["sonnet"],
    rows: [
      {
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        contextWindow: 200000,
        cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
      },
      {
        id: "claude-sonnet-4-6-thinking",
        name: "Claude Sonnet 4.6 Thinking",
        contextWindow: 200000,
        cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
        thinking: true,
      },
      {
        id: "claude-sonnet-4-6-1m",
        name: "Claude Sonnet 4.6 1M",
        contextWindow: 1000000,
        cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
        contextVariant: "1m",
      },
      {
        id: "claude-sonnet-4-6-thinking-1m",
        name: "Claude Sonnet 4.6 Thinking 1M",
        contextWindow: 1000000,
        cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
        thinking: true,
        contextVariant: "1m",
      },
    ],
  },
  {
    id: "gemini-3.8-flash",
    name: "Gemini 3.8 Flash",
    aliases: ["flash"],
    rows: [
      {
        id: "gemini-3-8-flash-low",
        name: "Gemini 3.8 Flash Low",
        contextWindow: 1048576,
        cost: { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0 },
        effort: "low",
      },
      {
        id: "gemini-3-8-flash-medium",
        name: "Gemini 3.8 Flash Medium",
        contextWindow: 1048576,
        cost: { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0 },
        effort: "medium",
      },
      {
        id: "gemini-3-8-flash-high",
        name: "Gemini 3.8 Flash High",
        contextWindow: 1048576,
        cost: { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0 },
        effort: "high",
      },
      {
        id: "gemini-3-8-flash-xhigh",
        name: "Gemini 3.8 Flash Xhigh",
        contextWindow: 1048576,
        cost: { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0 },
        effort: "xhigh",
      },
    ],
  },
];

function loadModelCache(): DevinModelCache {
  const cached = readJson<DevinModelCache | undefined>(MODEL_CACHE_FILE, undefined);
  if (cached && Array.isArray(cached.families) && cached.families.length > 0) {
    return cached;
  }
  return { fetchedAt: 0, source: "fallback", families: FALLBACK_FAMILIES };
}

function buildProviderModels(families: DevinModelFamily[]): ProviderModelConfig[] {
  return devinGroups(families).map((group) => ({
    id: group.id,
    name: group.name,
    reasoning: group.reasoning,
    thinkingLevelMap: groupThinkingLevelMap(group),
    input: ["text", "image"],
    cost: {
      input: group.cost.input,
      output: group.cost.output,
      cacheRead: group.cost.cacheRead,
      cacheWrite: group.cost.cacheWrite,
    },
    contextWindow: group.contextWindow || 262_144,
    maxTokens: 64_000,
  }));
}

function oneLine(value: string, max = 120): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

function sessionStateKey(state: PersistedDevinSession): string {
  return `${state.acpSessionId}:${state.turns}:${state.contextTokens ?? 0}`;
}

export default function piDevinExtension(pi: ExtensionAPI): void {
  const replay = new DevinReplayStore();
  let cwd = process.cwd();
  let catalog = loadModelCache();
  let sessionCtx: ExtensionContext | undefined;
  let resolvedBinary: string | undefined;
  let selectedModelKey: string | undefined;
  let persistedSessionKey: string | undefined;
  let piSessionId = "";

  const runtime = createDevinRuntime(() => {
    const client = new DevinAcpClient({
      binary: resolvedBinary ?? process.env.DEVIN_BINARY?.trim() ?? "devin",
      onLog: (line) => {
        if (process.env.PI_DEVIN_DEBUG === "1") {
          process.stderr.write(`[devin-acp] ${line}\n`);
        }
      },
    });
    client.setPermissionHandler(async (params) => {
      const options = params.options ?? [];
      const ui = sessionCtx?.hasUI ? sessionCtx.ui : undefined;
      if (!ui) {
        // Headless: deny by default; PI_DEVIN_HEADLESS_PERMISSION=allow opts in.
        if (process.env.PI_DEVIN_HEADLESS_PERMISSION === "allow") {
          const allow = options.find((o) => o.kind === "allow_once" || /allow/i.test(o.optionId));
          if (allow) {
            return { outcome: { outcome: "selected" as const, optionId: allow.optionId } };
          }
        }
        return { outcome: { outcome: "cancelled" as const } };
      }
      const title = params.toolCall?.title ?? "tool call";
      const picked = await ui.select(
        `devin requests permission: ${oneLine(title, 80)}`,
        options.map((o) => o.name ?? o.optionId),
      );
      if (!picked) return { outcome: { outcome: "cancelled" as const } };
      const index = options.findIndex((o) => (o.name ?? o.optionId) === picked);
      return index >= 0
        ? { outcome: { outcome: "selected" as const, optionId: options[index].optionId } }
        : { outcome: { outcome: "cancelled" as const } };
    });
    return client;
  });
  const service = runtime.runSync(DevinRuntime);

  /** Append the current runtime binding to the pi session branch. */
  const persistSessionState = async (ctx: ExtensionContext, force = false): Promise<void> => {
    if (ctx.model?.provider !== DEVIN_PROVIDER) return;
    const snapshot = await runDevin(runtime, service.snapshot);
    if (!snapshot.sessionId || !snapshot.cwd) return;
    const state: PersistedDevinSession = {
      version: 1,
      kind: "session",
      sessionId: ctx.sessionManager.getSessionId(),
      acpSessionId: snapshot.sessionId,
      cwd: snapshot.cwd,
      modelId: snapshot.model ?? ctx.model.id,
      turns: snapshot.turns,
      contextTokens: snapshot.contextTokens,
    };
    const key = sessionStateKey(state);
    if (!force && key === persistedSessionKey) return;
    persistedSessionKey = key;
    pi.appendEntry(DEVIN_SESSION_STATE_ENTRY, state);
  };

  const appendSessionReset = (ctx: ExtensionContext) => {
    persistedSessionKey = undefined;
    pi.appendEntry(DEVIN_SESSION_STATE_ENTRY, {
      version: 1,
      kind: "reset",
      sessionId: ctx.sessionManager.getSessionId(),
      cwd: ctx.cwd,
    });
  };

  // Display-only wrapper: replays recorded ACP tool results when pi executes
  // the synthesized toolCalls. Never visible to models.
  pi.registerTool({
    name: WRAPPER_TOOL_NAME,
    label: "devin",
    description: WRAPPER_TOOL_DESCRIPTION,
    parameters: Type.Object({
      tool: Type.Optional(Type.String()),
      title: Type.Optional(Type.String()),
      kind: Type.Optional(Type.String()),
      summary: Type.Optional(Type.String()),
    }),
    async execute(toolCallId) {
      const recorded = replay.take(toolCallId);
      if (!recorded) {
        throw new Error("No recorded devin result for this tool call.");
      }
      if (recorded.error) {
        throw new Error(recorded.error);
      }
      const body = recorded.output ?? "";
      return {
        content: [{ type: "text", text: body ? body.slice(0, 16_000) : "(no output)" }],
        details: recorded,
      };
    },
    renderCall(args, theme) {
      return new Text(
        formatDevinCall(
          {
            title: String(args.title ?? args.tool ?? "tool call"),
            kind: typeof args.kind === "string" ? args.kind : undefined,
            summary: typeof args.summary === "string" ? args.summary : undefined,
          },
          theme,
        ),
        0,
        0,
      );
    },
    renderResult(result, { expanded }, theme, context) {
      const body = result.content[0]?.type === "text" ? result.content[0].text : "";
      const details = result.details as RecordedDevinTool | undefined;
      const title = details?.title ?? "tool";
      if (context.isError) {
        const message = body && body !== "(no output)" ? body.split("\n")[0] : "failed";
        return new Text(theme.fg("error", `✗ ${oneLine(title, 60)}: ${oneLine(message)}`), 0, 0);
      }
      const summary = details ? summarizeDevinResult(details) : { headline: title };
      let text = theme.fg("success", "✓ ") + theme.fg("toolTitle", oneLine(summary.headline, 140));
      if (body && body !== "(no output)") {
        const lines = body.split("\n");
        const shown = expanded ? lines : lines.slice(0, 3);
        text += `\n${shown.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
        if (!expanded && lines.length > 3) {
          text += theme.fg("muted", `\n… +${lines.length - 3} lines (ctrl+o to expand)`);
        }
      }
      return new Text(text, 0, 0);
    },
  });

  const registerDevinProvider = (families: DevinModelFamily[]) => {
    pi.registerProvider(DEVIN_PROVIDER, {
      name: "Devin (acp)",
      baseUrl: "devin://acp",
      apiKey: "devin-local",
      api: "devin-acp",
      models: buildProviderModels(families),
      streamSimple: streamDevin({
        runtime,
        service,
        replay,
        families: () => catalog.families,
        cwd: () => cwd,
      }),
    });
  };

  registerDevinProvider(catalog.families);

  const discoverModels = async (refresh = false): Promise<DevinModelCache> => {
    if (!refresh) {
      const cached = readJson<DevinModelCache | undefined>(MODEL_CACHE_FILE, undefined);
      if (
        cached?.families?.length &&
        cached.fetchedAt &&
        Date.now() - cached.fetchedAt < modelCacheTtlMs(cached.source)
      ) {
        catalog = cached;
        return catalog;
      }
    }
    const binary = await checkDevinBinary({ refresh });
    if (!binary.ok) {
      if (catalog.families.length) return catalog;
      throw new Error(binary.message);
    }
    resolvedBinary = binary.binary;
    const result = await runDevinCommand(binary.binary, ["models", "list"], {
      timeoutMs: 20_000,
    });
    const families = parseDevinModels(result.stdout);
    if (families.length === 0) {
      if (catalog.families.length) return catalog;
      throw new Error("devin models list returned no families");
    }
    catalog = { fetchedAt: Date.now(), source: "live", families };
    try {
      writeJson(MODEL_CACHE_FILE, catalog);
    } catch {
      // Cache is best-effort.
    }
    return catalog;
  };

  async function refreshModelsWhenSelected(): Promise<void> {
    if (catalog.fetchedAt && Date.now() - catalog.fetchedAt < modelCacheTtlMs(catalog.source)) {
      return;
    }
    try {
      const next = await discoverModels(true);
      registerDevinProvider(next.families);
    } catch {
      // Discovery failure keeps the cached/fallback catalog.
    }
  }

  const syncWrapperToolActivation = (provider: string | undefined) => {
    const want = provider === DEVIN_PROVIDER;
    const active = pi.getActiveTools();
    const has = active.includes(WRAPPER_TOOL_NAME);
    if (want === has) return;
    pi.setActiveTools(
      want ? [...active, WRAPPER_TOOL_NAME] : active.filter((name) => name !== WRAPPER_TOOL_NAME),
    );
  };

  pi.on("session_start", async (event, ctx: ExtensionContext) => {
    sessionCtx = ctx;
    cwd = ctx.cwd;
    piSessionId = ctx.sessionManager.getSessionId();
    syncWrapperToolActivation(ctx.model?.provider);
    selectedModelKey = ctx.model ? `${ctx.model.provider}:${ctx.model.id}` : undefined;
    const restored =
      event.reason !== "fork" && ctx.model?.provider === DEVIN_PROVIDER
        ? restorableDevinSession(ctx.sessionManager.getBranch(), piSessionId, ctx.cwd)
        : undefined;
    await runDevin(
      runtime,
      service.setSession(ctx.cwd, { rebootstrap: event.reason !== "new" && !restored }),
    );
    if (restored) {
      await runDevin(
        runtime,
        service.restoreSession({
          acpSessionId: restored.acpSessionId,
          cwd: restored.cwd,
          modelId: restored.modelId,
          turns: restored.turns,
          contextTokens: restored.contextTokens,
        }),
      );
      persistedSessionKey = sessionStateKey(restored);
    } else {
      persistedSessionKey = undefined;
    }
    if (ctx.model?.provider === DEVIN_PROVIDER) {
      await refreshModelsWhenSelected();
    }
  });

  pi.on("model_select", async (event, ctx) => {
    syncWrapperToolActivation(event.model?.provider);
    const nextKey = event.model ? `${event.model.provider}:${event.model.id}` : undefined;
    if (selectedModelKey?.startsWith(`${DEVIN_PROVIDER}:`) && selectedModelKey !== nextKey) {
      // Another provider/model can add context the devin session never saw;
      // re-bootstrap the next turn instead of resuming stale history.
      await runDevin(runtime, service.setSession(ctx.cwd, { rebootstrap: true }));
      persistedSessionKey = undefined;
    }
    selectedModelKey = nextKey;
    if (event.model?.provider === DEVIN_PROVIDER) {
      await refreshModelsWhenSelected();
    }
  });

  pi.on("session_tree", async (_event, ctx: ExtensionContext) => {
    // A devin session cannot be rewound to match a different pi branch.
    await runDevin(runtime, service.setSession(ctx.cwd, { rebootstrap: true }));
    appendSessionReset(ctx);
  });

  pi.on("agent_settled", async (_event, ctx: ExtensionContext) => {
    await persistSessionState(ctx);
  });

  pi.on("session_compact", async (_event, ctx: ExtensionContext) => {
    // Pi compaction changes the branch; re-anchor the same ACP session.
    await persistSessionState(ctx, true);
  });

  pi.on("session_shutdown", async () => {
    try {
      await runDevin(runtime, service.close);
    } catch {
      // Already closed.
    }
    try {
      await runtime.dispose();
    } catch {
      // Disposed gracefully.
    }
  });

  pi.registerCommand("devin", {
    description:
      "Manage the devin backend: status | reset | models | sessions | mode | login | doctor",
    handler: async (args, ctx) => {
      sessionCtx = ctx;
      const sub = args.trim().toLowerCase();

      if (sub === "reset") {
        await runDevin(runtime, service.reset);
        appendSessionReset(ctx);
        ctx.ui.notify("devin: session binding reset; next turn starts fresh.", "info");
        return;
      }

      if (sub === "models") {
        try {
          const next = await discoverModels(true);
          registerDevinProvider(next.families);
          ctx.ui.notify(
            `devin: ${devinGroups(next.families).length} models registered (${next.source}).`,
            "info",
          );
        } catch (error) {
          ctx.ui.notify(
            `devin: model refresh failed (${error instanceof Error ? error.message : error}).`,
            "error",
          );
        }
        return;
      }

      if (sub === "sessions") {
        try {
          await runDevinSessionsPicker(ctx, {
            listSessions: () => runDevin(runtime, service.listSessions),
            currentSessionId: () =>
              runtime
                .runPromise(service.snapshot)
                .then((s) => s.sessionId)
                .catch(() => undefined),
            loadSession: async (acpSessionId) => {
              await runDevin(
                runtime,
                service.restoreSession({
                  acpSessionId,
                  cwd: ctx.cwd,
                  modelId: ctx.model?.id ?? "adaptive",
                  turns: 0,
                }),
              );
              ctx.ui.notify("devin: session attached; it loads into the next turn.", "info");
            },
            deleteSession: async (acpSessionId) => {
              await runDevin(runtime, service.deleteSession(acpSessionId));
              appendSessionReset(ctx);
            },
          });
        } catch (error) {
          ctx.ui.notify(
            `devin: sessions failed (${error instanceof Error ? error.message : error}).`,
            "error",
          );
        }
        return;
      }

      const modeMatch = sub.match(/^mode(?:\s+(\S+))?$/);
      if (modeMatch) {
        const requested = modeMatch[1];
        if (!requested) {
          const snapshot = await runDevin(runtime, service.snapshot);
          const known = ["ask", "plan", DEFAULT_MODE, "bypass"];
          ctx.ui.notify(
            `devin mode: ${snapshot.modeId ?? "default"} — set with /devin mode ${known.join("|")}`,
            "info",
          );
          return;
        }
        try {
          await runDevin(runtime, service.setMode(requested));
          ctx.ui.notify(`devin mode: ${requested}`, "info");
        } catch (error) {
          ctx.ui.notify(
            `devin: set mode failed (${error instanceof Error ? error.message : error}).`,
            "error",
          );
        }
        return;
      }

      if (sub === "login") {
        try {
          await runDevin(runtime, service.authenticate("devin-browser"));
          ctx.ui.notify("devin: authentication request sent (check your browser).", "info");
        } catch (error) {
          ctx.ui.notify(
            `devin login failed (${error instanceof Error ? error.message : error}). Try \`devin auth login\` in a terminal.`,
            "error",
          );
        }
        return;
      }

      if (sub === "doctor") {
        const lines = ["devin doctor"];
        const binary = await checkDevinBinary({ refresh: true });
        if (binary.ok) {
          resolvedBinary = binary.binary;
          lines.push(
            `binary: ${binary.binary} (${binary.version}${binary.revision ? `, ${binary.revision}` : ""}, ${binary.source})`,
            `minimum: ${MIN_DEVIN_VERSION}`,
          );
        } else {
          lines.push(
            `binary: ERROR [${binary.category}] ${binary.message}`,
            `minimum: ${MIN_DEVIN_VERSION}`,
          );
        }
        try {
          const discovered = await discoverModels(true);
          registerDevinProvider(discovered.families);
          lines.push(`models: ${devinGroups(discovered.families).length} (live)`);
        } catch (error) {
          lines.push(
            `models: ERROR ${error instanceof Error ? error.message : error}; ${devinGroups(catalog.families).length} cached (${catalog.source})`,
          );
        }
        try {
          const snapshot = await runDevin(runtime, service.snapshot);
          lines.push(
            `session: ${snapshot.sessionId ?? "none"}${snapshot.title ? ` "${snapshot.title}"` : ""}`,
            `mode: ${snapshot.modeId ?? "default"} · model: ${snapshot.concreteModel ?? snapshot.model ?? "none"}`,
            `turns: ${snapshot.turns} · context: ${snapshot.contextTokens ?? "?"}/${snapshot.contextSize ?? "?"}`,
            `client: spawned=${snapshot.client.spawned} pid=${snapshot.client.pid ?? "none"} requests=${snapshot.client.requestsSent} notifications=${snapshot.client.notificationsReceived}`,
          );
        } catch (error) {
          lines.push(`runtime: ERROR ${error instanceof Error ? error.message : error}`);
        }
        ctx.ui.notify(lines.join("\n"), binary.ok ? "info" : "error");
        return;
      }

      if (sub) {
        ctx.ui.notify(
          `devin: unknown argument "${sub}". Use reset | models | sessions | mode | login | doctor.`,
          "error",
        );
        return;
      }

      const snapshot = await runDevin(runtime, service.snapshot);
      const details = [
        `model: ${snapshot.concreteModel ?? snapshot.model ?? "unselected"}`,
        `mode: ${snapshot.modeId ?? "default"}`,
        `turns: ${snapshot.turns}`,
        snapshot.contextTokens === undefined
          ? undefined
          : `context: ${snapshot.contextTokens}/${snapshot.contextSize ?? "?"}`,
        snapshot.lastTurnStats?.tokensPerSec === undefined
          ? undefined
          : `last turn: ${snapshot.lastTurnStats.tokensPerSec.toFixed(1)} tok/s`,
      ].filter((part): part is string => part !== undefined);
      ctx.ui.notify(
        `devin: ${snapshot.title ?? snapshot.sessionId ?? "no session yet"}\nsession: ${snapshot.sessionId ?? "none"}\n${details.join(" · ")}`,
        "info",
      );
    },
  });
}
