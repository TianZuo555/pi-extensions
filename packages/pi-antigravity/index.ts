// antigravity — use Google Antigravity (agy) models inside the pi coding
// agent via the agy stream-json RPC. pi stays the UI: model picker, portable
// sessions, and rendering; agy owns native context and runs the selected model with
// --dangerously-skip-permissions always enabled (headless agy turns
// auto-deny tools that would need a permission prompt otherwise).
//
// Commands:
//   /agy            show agy conversation status (id, model, turns)
//   /agy reset      drop the current agy conversation (next turn starts fresh)
//   /agy models     re-discover models from `agy models` and re-register
//   /agy-usage      show Antigravity model quotas (weekly and 5-hour limits)

import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
  ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { piConfigDir, readJson, writeJson } from "./lib/config.ts";
import { AGY_BINARY } from "./lib/agy-client.ts";
import {
  installAgyDeathHooks,
  killAgyTree,
  killAllAgyTrees,
  trackAgyChild,
  untrackAgyChild,
} from "./lib/agy-children.ts";
import { pruneBridgeMcpCache, removeMcpCacheEntry } from "./lib/mcp-cache.ts";
import {
  AgyPiBridge,
  BRIDGE_SERVER_NAME,
  selectBridgedTools,
  type PiToolInfo,
} from "./lib/bridge.ts";
import { createBridgeLifecycleManager } from "./lib/bridge-lifecycle.ts";
import {
  ACTIVATE_SKILL_TOOL_NAME,
  activateSkillDescription,
  activateSkillParameters,
  handleActivateSkill,
  nonWorkspaceSkills,
  usableSkillCatalog,
  type SkillLite,
} from "./lib/skills.ts";
import {
  capabilitiesForModel,
  FALLBACK_MODELS,
  modelCacheTtlMs,
  normalizeAgyModelId,
  parseAgyModels,
  pricingForModel,
  type AgyModelInfo,
} from "./lib/models.ts";
import type { AgyActivity } from "./lib/reducer.ts";
import {
  AGY_COMPACTION_ENTRY,
  agyContextTokens,
  detectAgyCompaction,
  formatAgyContextTokens,
  type AgyCompactionMarker,
} from "./lib/agy-compaction.ts";
import {
  AGY_CONVERSATION_STATE_ENTRY,
  agyConversationExists,
  restorableAgyConversation,
  type PersistedAgyConversation,
  type PersistedAgyReset,
} from "./lib/conversation-state.ts";
import { AgyReplayStore, type RecordedAgyTool } from "./lib/replay.ts";
import { findAgyTask, listAgyTasks, stopAgyTask } from "./lib/tasks.ts";
import { findAgyArtifact, listAgyArtifacts } from "./lib/artifacts.ts";
import { fetchAgyUsage } from "./lib/usage.ts";
import { WRAPPER_TOOL_DESCRIPTION, WRAPPER_TOOL_NAME } from "./lib/prompt.ts";
import { wrapperToolActiveAfterModelSwitch } from "./lib/wrapper-activation.ts";
import { openAgyTasksPicker } from "./src/tasks-ui.ts";
import { openArtifact, openAgyArtifactsPicker } from "./src/artifacts-ui.ts";
import { openAgyUsagePicker } from "./src/usage-ui.ts";
import { agyToolLabel, formatAgyCall, summarizeAgyResult } from "./lib/render.ts";
import { streamAntigravity } from "./src/provider.ts";
import { AntigravityRuntime, createAntigravityRuntime, runAntigravity } from "./src/runtime.ts";

const MODEL_CACHE_FILE = path.join(piConfigDir("antigravity"), "model-list.json");
const DISCOVERY_TIMEOUT_MS = 15_000;

// --- Pi-tool bridge ---------------------------------------------------------

const BRIDGE_ENABLED = process.env.PI_ANTIGRAVITY_PI_TOOL_BRIDGE !== "0";

/** Timeout for shutdown-path agy calls — fast enough not to stall closing pi. */
const SHUTDOWN_AGY_TIMEOUT_MS = 5_000;

function execAgy(args: string[], timeoutMs = DISCOVERY_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let out = "";
    let errOut = "";
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn();
    };
    const child = spawn(AGY_BINARY, args, {
      stdio: ["ignore", "pipe", "pipe"],
      // Own process group so killAgyTree's negative-pid SIGKILL reaps the
      // whole tree on timeout. Raw spawn because execFile drops `detached`.
      detached: true,
    });
    trackAgyChild(child);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      out += chunk;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      errOut += chunk;
    });
    child.on("error", (err) => {
      settle(() => {
        untrackAgyChild(child);
        reject(new Error(err.message));
      });
    });
    child.on("close", (code) => {
      settle(() => {
        untrackAgyChild(child);
        if (code === 0) resolve(out);
        else {
          reject(new Error(errOut.trim() || `agy ${args[0]} exited with code ${code ?? "signal"}`));
        }
      });
    });
    timer = setTimeout(() => {
      settle(() => {
        killAgyTree(child);
        reject(new Error(`agy ${args[0]} timed out after ${Math.round(timeoutMs / 1000)}s`));
      });
    }, timeoutMs);
  });
}

/**
 * Remove `pi-bridge-*` MCP registrations whose loopback server is no longer
 * reachable. Registrations live in agy's GLOBAL config while bridge servers
 * are per-pi-session: crashed sessions leak registrations forever, and every
 * live session's tools are merged into every agy turn's tools/list. Pruning
 * dead entries on startup keeps cross-session pollution to live sessions.
 * agy also caches tool manifests on disk per server
 * (`~/.gemini/antigravity-cli/mcp/<name>/`) and never evicts them, so the
 * same sweep prunes cache entries with no live server left.
 */
async function pruneStaleBridgeRegistrations(): Promise<void> {
  let list: string;
  try {
    list = await execAgy(["mcp", "list"]);
  } catch {
    return; // agy unavailable — registration below will warn instead
  }
  const stale: string[] = [];
  const live: string[] = [];
  for (const line of list.split("\n").slice(1)) {
    const columns = line.trim().split(/\s+/);
    const name = columns[0] ?? "";
    const url = columns[columns.length - 1] ?? "";
    if (!name.startsWith(`${BRIDGE_SERVER_NAME}-`) || !/^http:\/\/127\.0\.0\.1:\d+\//.test(url)) {
      continue;
    }
    try {
      await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
        signal: AbortSignal.timeout(1_500),
      });
      // Any HTTP answer (even 403/404) means a server is still listening.
      live.push(name);
    } catch {
      stale.push(name);
    }
  }
  await Promise.all(stale.map((name) => execAgy(["mcp", "remove", name]).catch(() => {})));
  // `agy mcp remove` deregisters but leaves the on-disk manifest cache
  // behind; entries whose registration is already gone never reappear in
  // `agy mcp list`, so prune the cache against the live set here.
  await pruneBridgeMcpCache({ liveServers: live });
}

interface ModelCache {
  fetchedAt?: number;
  source?: "live" | "fallback";
  models: AgyModelInfo[];
}

/**
 * Default rates (USD per Mtok) feed pi's native cost calculation. Per-model
 * overrides belong in pi's own ~/.pi/agent/models.json under
 * providers.antigravity.modelOverrides — pi applies them over registered models.
 */
function toProviderModel(model: AgyModelInfo): ProviderModelConfig {
  const capabilities = capabilitiesForModel(model.id);
  return {
    id: model.id,
    name: model.name,
    reasoning: true,
    input: ["text"],
    cost: pricingForModel(model.id),
    contextWindow: capabilities.contextWindow,
    maxTokens: capabilities.maxTokens,
  };
}

/** Collapse effort variants and dedupe (also heals pre-0.2.0 caches). */
function normalizeModels(models: AgyModelInfo[]): AgyModelInfo[] {
  const out: AgyModelInfo[] = [];
  for (const m of models) {
    const n = normalizeAgyModelId(m.id, m.name);
    if (!out.some((x) => x.id === n.id)) out.push(n);
  }
  return out;
}

async function listAgyModels(): Promise<AgyModelInfo[]> {
  try {
    return parseAgyModels(await execAgy(["models"]));
  } catch {
    return [];
  }
}

function getInitialModelCache(): ModelCache {
  const cached = readJson<ModelCache | null>(MODEL_CACHE_FILE, null);
  if (cached?.models?.length) {
    return { ...cached, models: normalizeModels(cached.models) };
  }
  return {
    fetchedAt: 0,
    source: "fallback",
    models: FALLBACK_MODELS,
  };
}

async function discoverModels(refresh = false): Promise<ModelCache> {
  if (!refresh) {
    const cached = readJson<ModelCache | null>(MODEL_CACHE_FILE, null);
    if (
      cached?.models?.length &&
      cached.fetchedAt &&
      Date.now() - cached.fetchedAt < modelCacheTtlMs(cached.source)
    ) {
      return { ...cached, models: normalizeModels(cached.models) };
    }
  }
  const live = await listAgyModels();
  const cache: ModelCache = live.length
    ? { fetchedAt: Date.now(), source: "live", models: normalizeModels(live) }
    : { fetchedAt: Date.now(), source: "fallback", models: FALLBACK_MODELS };
  try {
    writeJson(MODEL_CACHE_FILE, cache);
  } catch {
    // Cache is best-effort; discovery still returns.
  }
  return cache;
}

export default function antigravityExtension(pi: ExtensionAPI): void {
  installAgyDeathHooks();
  const runtime = createAntigravityRuntime();
  const service = runtime.runSync(AntigravityRuntime);
  const replay = new AgyReplayStore();
  let currentCache = getInitialModelCache();
  let observedContextTokens: number | undefined;
  let persistedConversationKey: string | undefined;
  let selectedModelKey: string | undefined;

  pi.registerEntryRenderer(AGY_COMPACTION_ENTRY, (entry, _options, theme) => {
    const marker = entry.data as AgyCompactionMarker;
    const text =
      theme.fg("dim", "── ") +
      theme.fg("accent", "agy compacted context") +
      theme.fg(
        "dim",
        ` · ~${formatAgyContextTokens(marker.beforeTokens)} → ~${formatAgyContextTokens(marker.afterTokens)} ──`,
      );
    return {
      render: (width: number) => [truncateToWidth(text, width, "")],
      invalidate: () => {},
    };
  });

  const conversationStateKey = (state: {
    conversationId: string;
    modelId: string;
    turns: number;
  }): string => `${state.conversationId}:${state.modelId}:${state.turns}`;

  async function persistConversationState(ctx: ExtensionContext, force = false): Promise<void> {
    if (ctx.model?.provider !== "antigravity") return;
    const snapshot = await runAntigravity(runtime, service.snapshot);
    if (!snapshot.conversationId || !snapshot.model || snapshot.cwd !== ctx.cwd) return;
    const state: PersistedAgyConversation = {
      version: 1,
      kind: "conversation",
      sessionId: ctx.sessionManager.getSessionId(),
      conversationId: snapshot.conversationId,
      cwd: ctx.cwd,
      modelId: snapshot.model,
      turns: snapshot.turns,
      usage: snapshot.conversationUsage,
      contextTokens: observedContextTokens,
    };
    const key = conversationStateKey(state);
    if (!force && key === persistedConversationKey) return;
    pi.appendEntry(AGY_CONVERSATION_STATE_ENTRY, state);
    persistedConversationKey = key;
  }

  function appendConversationReset(ctx: ExtensionContext): void {
    const reset: PersistedAgyReset = {
      version: 1,
      kind: "reset",
      sessionId: ctx.sessionManager.getSessionId(),
      cwd: ctx.cwd,
    };
    pi.appendEntry(AGY_CONVERSATION_STATE_ENTRY, reset);
    observedContextTokens = undefined;
    persistedConversationKey = undefined;
  }

  // --- Pi-tool bridge setup -------------------------------------------------

  const bridge = new AgyPiBridge(`${BRIDGE_SERVER_NAME}-${process.pid}`);
  const bridgeToken = randomUUID();
  bridge.requireToken(bridgeToken);
  // Session-unique tool prefix: agy's MCP config is global, so concurrent pi
  // sessions' bridges all appear in every agy turn's tools/list. Namespacing
  // each session's tools makes tool→server routing unambiguous — a call can
  // only reach the session that advertised it.
  const bridgeToolPrefix = `pi__p${process.pid}__`;
  bridge.setToolPrefix(bridgeToolPrefix);
  bridge.setOnCall((call) => service.pushBridgeCall(call));

  const bridgeManager = createBridgeLifecycleManager({
    bridge,
    bridgeToken,
    enabled: BRIDGE_ENABLED,
    pruneStaleRegistrations: pruneStaleBridgeRegistrations,
    addMcpServer: async (serverName, url, token) => {
      await execAgy([
        "mcp",
        "add",
        "--type",
        "http",
        "--header",
        `x-pi-bridge-token: ${token}`,
        serverName,
        url,
      ]);
    },
    removeMcpServer: async (serverName) => {
      await execAgy(["mcp", "remove", serverName], SHUTDOWN_AGY_TIMEOUT_MS);
    },
    evictMcpCache: removeMcpCacheEntry,
  });

  /**
   * Register the pi-tool bridge with agy. Idempotent: no-op when disabled or
   * already registered. Registration must precede the first agy spawn of the
   * session — agy eagerly connects to MCP servers at startup (verified
   * 2026-08-21) — so this runs as soon as an Antigravity model is selected.
   */
  async function ensureBridgeRegistered(ui?: ExtensionUIContext): Promise<void> {
    await bridgeManager.ensureRegistered((warning) => ui?.notify(warning, "warning"));
  }

  /**
   * Deregister the pi-tool bridge and evict its manifest cache. No-op when
   * the bridge is not registered or running. Runs when the session leaves
   * Antigravity models and on shutdown.
   */
  async function teardownBridge(): Promise<void> {
    await bridgeManager.teardown();
  }

  // --- Skill passing (Phase 2) ----------------------------------------------
  // pi's loaded skills, refreshed per turn via before_agent_start so /reload
  // is respected. Model-invocation-disabled skills are excluded.
  let loadedSkills: SkillLite[] = [];

  function captureSkills(skills: unknown): void {
    if (!Array.isArray(skills)) return;
    loadedSkills = skills
      .map((skill) => skill as Partial<SkillLite> & { disableModelInvocation?: boolean })
      .filter(
        (skill) => skill.disableModelInvocation !== true && typeof skill.filePath === "string",
      )
      .map((skill) => ({
        name: String(skill.name),
        description: String(skill.description ?? ""),
        filePath: String(skill.filePath),
        baseDir: String(skill.baseDir ?? path.dirname(String(skill.filePath))),
      }));
  }

  const bridgedSkills = () => usableSkillCatalog(nonWorkspaceSkills(loadedSkills, tasksSessionCwd));

  /**
   * Bridge mode keeps the catalog in activate_skill's schema (refreshed on
   * every agy spawn), so nothing is appended to the prompt. When the bridge is
   * off OR failed to register with agy, fall back to the direct-mode path
   * catalog so skills never become silently invisible.
   */
  const getBootstrapSuffix = () => bridgeManager.getBootstrapSuffix(bridgedSkills());

  /** Publish one `pi__p<pid>__activate_skill` tool for global pi skills. */
  function refreshSkillTools(): void {
    if (!BRIDGE_ENABLED) return;
    const skills = bridgedSkills();
    if (skills.length === 0) {
      bridge.setDynamicTools([]);
      return;
    }
    bridge.setDynamicTools([
      {
        name: ACTIVATE_SKILL_TOOL_NAME,
        description: activateSkillDescription(skills),
        parameters: activateSkillParameters(skills),
        handler: (args) => handleActivateSkill(skills, args),
      },
    ]);
  }

  bridge.setToolSource(() => {
    if (!BRIDGE_ENABLED) return [];
    let activeNames: string[] = [];
    let allTools: PiToolInfo[] = [];
    try {
      activeNames = pi.getActiveTools();
      allTools = pi.getAllTools() as PiToolInfo[];
    } catch {
      return []; // API unavailable (print/RPC edge) — expose nothing.
    }
    return selectBridgedTools(allTools, activeNames);
  });

  // Per-skill tools are gone; one activate_skill tool is published on every
  // skills capture via refreshSkillTools().

  // --- Status-bar hint for live agy background tasks -----------------------

  const AGY_TASKS_WIDGET_KEY = "agy-tasks";
  const AGY_ARTIFACTS_WIDGET_KEY = "agy-artifacts";
  let tasksUi: ExtensionUIContext | undefined;
  let tasksSessionCwd: string | undefined;
  let widgetLiveCount = -1;
  let widgetArtifactCount = -1;
  let widgetScanInFlight = false;
  let widgetScanQueued = false;
  let agyAgentActive = false;
  let widgetPollTimer: ReturnType<typeof setInterval> | undefined;
  const WIDGET_POLL_MS = 2_000;

  /** Active-tool snapshot for the provider's native re-execution fallback. */
  const isActiveTool = (name: string): boolean => {
    try {
      return pi.getActiveTools().includes(name);
    } catch {
      return false; // API unavailable (print/RPC edge) — stay on the wrapper.
    }
  };

  function setAgyTasksWidget(live: number): void {
    if (!tasksUi || live === widgetLiveCount) return;
    widgetLiveCount = live;
    try {
      if (live === 0) {
        tasksUi.setWidget(AGY_TASKS_WIDGET_KEY, undefined);
        return;
      }
      tasksUi.setWidget(AGY_TASKS_WIDGET_KEY, (_tui, theme) => {
        const line =
          theme.fg("warning", "■ ") +
          theme.fg("text", `${live} agy background task${live === 1 ? "" : "s"}`) +
          theme.fg("dim", " • ") +
          theme.fg("accent", "/agy-tasks") +
          theme.fg("dim", " to view");
        return {
          render: (width: number) => [truncateToWidth(line, width, "")],
          invalidate: () => {},
        };
      });
    } catch {
      // UI may be unavailable (print/RPC modes or teardown).
    }
  }

  function setAgyArtifactsWidget(count: number): void {
    if (!tasksUi || count === widgetArtifactCount) return;
    widgetArtifactCount = count;
    try {
      if (count === 0) {
        tasksUi.setWidget(AGY_ARTIFACTS_WIDGET_KEY, undefined);
        return;
      }
      tasksUi.setWidget(AGY_ARTIFACTS_WIDGET_KEY, (_tui, theme) => {
        const line =
          theme.fg("success", "◆ ") +
          theme.fg("text", `${count} agy artifact${count === 1 ? "" : "s"}`) +
          theme.fg("dim", " • ") +
          theme.fg("accent", "/agy-artifacts") +
          theme.fg("dim", " to view");
        return {
          render: (width: number) => [truncateToWidth(line, width, "")],
          invalidate: () => {},
        };
      });
    } catch {
      // UI may be unavailable (print/RPC modes or teardown).
    }
  }

  function reconcileWidgetPolling(): void {
    const shouldPoll = Boolean(tasksUi && (agyAgentActive || widgetLiveCount > 0));
    if (shouldPoll && !widgetPollTimer) {
      widgetPollTimer = setInterval(updateAgyTasksWidget, WIDGET_POLL_MS);
      widgetPollTimer.unref?.();
    } else if (!shouldPoll && widgetPollTimer) {
      clearInterval(widgetPollTimer);
      widgetPollTimer = undefined;
    }
  }

  /** Rescan task state independently from agy's provider stream. */
  function updateAgyTasksWidget(): void {
    if (!tasksUi) return;
    if (widgetScanInFlight) {
      widgetScanQueued = true;
      return;
    }
    widgetScanInFlight = true;
    void (async () => {
      try {
        const snapshot = await runAntigravity(runtime, service.snapshot);
        if (!snapshot.conversationId) {
          setAgyTasksWidget(0);
          setAgyArtifactsWidget(0);
          return;
        }
        const [tasks, artifacts] = await Promise.all([
          listAgyTasks(snapshot.conversationId, {
            sessionCwd: tasksSessionCwd,
          }),
          listAgyArtifacts(snapshot.conversationId),
        ]);
        setAgyTasksWidget(
          tasks.filter((task) => task.pids.length > 0 || task.orphans.length > 0).length,
        );
        setAgyArtifactsWidget(artifacts.length);
      } catch {
        // Runtime closed or scan failed; leave the widget as-is.
      } finally {
        widgetScanInFlight = false;
        if (widgetScanQueued) {
          widgetScanQueued = false;
          queueMicrotask(updateAgyTasksWidget);
        } else {
          reconcileWidgetPolling();
        }
      }
    })();
  }

  function handleAgyActivity(activity: AgyActivity): void {
    if (activity.type === "conversation_fallback") {
      observedContextTokens = undefined;
      persistedConversationKey = undefined;
      return;
    }
    if (activity.type === "usage") {
      const nextContextTokens = agyContextTokens(activity.usage);
      const compaction = detectAgyCompaction(observedContextTokens, nextContextTokens);
      if (compaction) {
        const marker: AgyCompactionMarker = {
          version: 1,
          ...compaction,
          detectedAt: new Date().toISOString(),
        };
        pi.appendEntry(AGY_COMPACTION_ENTRY, marker);
      }
      observedContextTokens = nextContextTokens;
      return;
    }
    if (
      (activity.type === "tool_start" ||
        activity.type === "tool_done" ||
        activity.type === "tool_error") &&
      (activity.name === "run_command" || activity.name === "schedule")
    ) {
      // ACTIVE arrives before a sleeping command completes. Start the
      // independent filesystem scan now instead of waiting for onSettled,
      // then retry once in case the task log and holder fd are still racing.
      updateAgyTasksWidget();
      if (activity.type === "tool_start") {
        const retry = setTimeout(updateAgyTasksWidget, 500);
        retry.unref?.();
      }
    }
  }

  pi.registerTool({
    name: WRAPPER_TOOL_NAME,
    label: "antigravity",
    description: WRAPPER_TOOL_DESCRIPTION,
    parameters: Type.Object({
      tool: Type.String(),
      input: Type.Unknown(),
    }),
    async execute(toolCallId, params) {
      const recorded = replay.take(toolCallId);
      if (!recorded) {
        throw new Error(`No recorded antigravity result for "${params.tool}".`);
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
      return new Text(formatAgyCall(args.tool, args.input, theme), 0, 0);
    },
    renderResult(result, { expanded }, theme, context) {
      const body = result.content[0]?.type === "text" ? result.content[0].text : "";
      const details = result.details as RecordedAgyTool | undefined;
      const tool = details?.agyTool ?? "tool";
      if (context.isError) {
        const message = body && body !== "(no output)" ? body.split("\n")[0] : "failed";
        return new Text(theme.fg("error", `✗ ${agyToolLabel(tool)}: ${message}`), 0, 0);
      }
      const secs =
        typeof details?.durationSeconds === "number"
          ? theme.fg("muted", ` (${details.durationSeconds.toFixed(2)}s)`)
          : "";
      const { counts } = summarizeAgyResult(tool, details?.output);
      const parts = [theme.fg("success", "✓ "), counts ? theme.fg("muted", counts) : "", secs];
      let text = parts.join("");
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

  const registerAntigravityProvider = (models: AgyModelInfo[]) => {
    pi.registerProvider("antigravity", {
      name: "Google Antigravity (agy)",
      baseUrl: "agy://local-stream-json",
      apiKey: "agy-local-session",
      api: "antigravity-stream-json",
      models: models.map(toProviderModel),
      streamSimple: streamAntigravity(
        runtime,
        service,
        replay,
        bridge,
        updateAgyTasksWidget,
        getBootstrapSuffix,
        isActiveTool,
        handleAgyActivity,
      ),
    });
  };

  registerAntigravityProvider(currentCache.models);

  // Refresh model catalog non-blockingly in the background when stale or on fallback
  if (
    !currentCache.fetchedAt ||
    Date.now() - currentCache.fetchedAt >= modelCacheTtlMs(currentCache.source)
  ) {
    void discoverModels(true)
      .then((fresh) => {
        currentCache = fresh;
        registerAntigravityProvider(fresh.models);
      })
      .catch(() => {
        // Cache is best-effort
      });
  }

  pi.on("before_agent_start", (event) => {
    captureSkills(event.systemPromptOptions?.skills);
    refreshSkillTools();
  });

  // The agy stream reports tool starts immediately, but its DONE event can be
  // delayed by a sleeping command. Poll the independent filesystem task
  // source while the agent or any discovered task is live, then stop when
  // both are idle. This keeps the widget current without a permanent timer.
  pi.on("agent_start", (_event, ctx) => {
    if (ctx.model?.provider !== "antigravity") return;
    agyAgentActive = true;
    updateAgyTasksWidget();
    reconcileWidgetPolling();
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (ctx.model?.provider !== "antigravity" && !agyAgentActive) return;
    agyAgentActive = false;
    updateAgyTasksWidget();
  });

  // The display-only `antigravity` wrapper tool only matters while an agy
  // model is active (the provider synthesizes its toolCalls from recorded
  // agy activity). Keep it out of every other model's tool payload: sync
  // active-tool state whenever the selected model changes, including the
  // session's initial restore.
  const syncWrapperToolActivation = (provider: string | undefined) => {
    const next = wrapperToolActiveAfterModelSwitch(
      pi.getActiveTools(),
      WRAPPER_TOOL_NAME,
      provider,
      "antigravity",
    );
    if (next) pi.setActiveTools([...next]);
  };

  pi.on("session_start", async (event, ctx: ExtensionContext) => {
    syncWrapperToolActivation(ctx.model?.provider);
    selectedModelKey = ctx.model ? `${ctx.model.provider}:${ctx.model.id}` : undefined;
    const restored =
      event.reason !== "fork" && ctx.model?.provider === "antigravity"
        ? restorableAgyConversation(
            ctx.sessionManager.getBranch(),
            ctx.sessionManager.getSessionId(),
            ctx.cwd,
          )
        : undefined;
    const compatibleRestore =
      restored &&
      restored.modelId === ctx.model?.id &&
      (await agyConversationExists(restored.conversationId))
        ? restored
        : undefined;
    await runAntigravity(
      runtime,
      service.setSession(ctx.cwd, undefined, !compatibleRestore && event.reason !== "new"),
    );
    if (compatibleRestore) {
      await runAntigravity(
        runtime,
        service.restoreConversation({
          conversationId: compatibleRestore.conversationId,
          modelId: compatibleRestore.modelId,
          cwd: compatibleRestore.cwd,
          turns: compatibleRestore.turns,
          usage: compatibleRestore.usage,
        }),
      );
      observedContextTokens = compatibleRestore.contextTokens;
      persistedConversationKey = conversationStateKey(compatibleRestore);
    } else {
      observedContextTokens = undefined;
      persistedConversationKey = undefined;
    }
    if (ctx.hasUI) tasksUi = ctx.ui;
    tasksSessionCwd = ctx.cwd;
    updateAgyTasksWidget();
    // The pi-tool bridge is only useful while an Antigravity model is
    // selected: register lazily here (session resumed on an agy model) and on
    // model_select; non-agy sessions never touch agy at all.
    if (ctx.model?.provider === "antigravity") {
      await ensureBridgeRegistered(ctx.ui);
    }
  });

  pi.on("model_select", async (event, ctx) => {
    syncWrapperToolActivation(event.model?.provider);
    const nextModelKey = event.model ? `${event.model.provider}:${event.model.id}` : undefined;
    if (selectedModelKey?.startsWith("antigravity:") && selectedModelKey !== nextModelKey) {
      // Another provider/model can add context that the mutable agy
      // conversation never saw. Force a branch bootstrap when agy is selected
      // again instead of silently resuming stale native history.
      await runAntigravity(runtime, service.setSession(ctx.cwd, undefined, true));
      observedContextTokens = undefined;
      persistedConversationKey = undefined;
    }
    selectedModelKey = nextModelKey;
    // The bridge exists only while an Antigravity model is selected.
    if (event.model?.provider === "antigravity") {
      await ensureBridgeRegistered(ctx?.ui);
    } else {
      await teardownBridge();
    }
  });

  pi.on("session_tree", async (_event, ctx: ExtensionContext) => {
    // An agy conversation cannot be rewound to match a different pi branch.
    // Restart it and bootstrap the selected branch on the next provider call.
    await runAntigravity(runtime, service.setSession(ctx.cwd, undefined, true));
    appendConversationReset(ctx);
    setAgyTasksWidget(0);
    setAgyArtifactsWidget(0);
  });

  pi.on("agent_settled", async (_event, ctx: ExtensionContext) => {
    await persistConversationState(ctx);
  });

  pi.on("session_compact", async (_event, ctx: ExtensionContext) => {
    // Pi manual/overflow compaction changes the session branch but not agy's
    // native conversation. Re-anchor the same owner after the compaction entry.
    await persistConversationState(ctx, true);
  });

  pi.on("session_shutdown", async () => {
    agyAgentActive = false;
    if (widgetPollTimer) clearInterval(widgetPollTimer);
    widgetPollTimer = undefined;
    widgetScanQueued = false;
    // Stop any live agy background tasks so closing pi leaves nothing
    // running silently. Only processes holding the task log open are certain
    // enough to stop automatically; heuristic orphan matches stay visible in
    // /agy-tasks but require an explicit user stop to avoid false positives.
    try {
      const snapshot = await runAntigravity(runtime, service.snapshot);
      if (snapshot.conversationId) {
        const tasks = await listAgyTasks(snapshot.conversationId, {
          sessionCwd: tasksSessionCwd,
        });
        const live = tasks.filter((task) => task.pids.length > 0);
        await Promise.all(live.map((task) => stopAgyTask(task, { includeOrphans: false })));
      }
    } catch {
      // Runtime closed or scan failed; nothing to stop.
    }
    // Close the runtime: aborts any in-flight agy child process, then tear
    // down the Effect runtime.
    try {
      await runAntigravity(runtime, service.close);
    } catch {
      // Already closed.
    }
    if (bridgeManager.isRegistered() || bridgeManager.isRunning()) {
      await teardownBridge();
    }
    try {
      tasksUi?.setWidget(AGY_TASKS_WIDGET_KEY, undefined);
      tasksUi?.setWidget(AGY_ARTIFACTS_WIDGET_KEY, undefined);
    } catch {
      // UI may already be gone.
    }
    tasksUi = undefined;
    widgetLiveCount = -1;
    widgetArtifactCount = -1;
    widgetScanInFlight = false;
    try {
      await runtime.dispose();
    } catch {
      // Disposed gracefully
    }
    // Sweep any remaining tracked agy process trees (including earlier turns
    // that finished logically while grandchildren held stdio open).
    killAllAgyTrees();
  });

  pi.registerCommand("agy", {
    description: "Manage the agy backend: status | reset | models",
    handler: async (args, ctx) => {
      const sub = args.trim().toLowerCase();
      if (sub === "reset") {
        await runAntigravity(runtime, service.reset);
        appendConversationReset(ctx);
        ctx.ui.notify("antigravity: conversation reset; next turn starts fresh.", "info");
        return;
      }
      if (sub === "models") {
        const refreshed = await discoverModels(true);
        currentCache = refreshed;
        registerAntigravityProvider(refreshed.models);
        ctx.ui.notify(
          `antigravity: ${refreshed.models.length} models registered (${refreshed.source}).`,
          "info",
        );
        return;
      }
      if (sub) {
        ctx.ui.notify(`antigravity: unknown argument "${sub}". Use reset | models.`, "error");
        return;
      }
      const snapshot = await runAntigravity(runtime, service.snapshot);
      const id = snapshot.conversationId ?? "(none — next turn starts fresh)";
      const context =
        observedContextTokens === undefined
          ? ""
          : ` · native context: ~${formatAgyContextTokens(observedContextTokens)}/185k`;
      ctx.ui.notify(
        `antigravity: conversation ${id}\nmodel: ${snapshot.model ?? "unselected"} · turns: ${snapshot.turns}${context} · models: ${currentCache.models.length} (${currentCache.source})`,
        "info",
      );
    },
  });

  pi.registerCommand("agy-tasks", {
    description: "List agy background tasks; `stop <task-id>|stop all` to terminate",
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      const snapshot = await runAntigravity(runtime, service.snapshot);
      const conversationId = snapshot.conversationId;
      if (!conversationId) {
        ctx.ui.notify("agy-tasks: no agy conversation in this session yet.", "error");
        return;
      }
      const rescan = () => listAgyTasks(conversationId, { sessionCwd: ctx.cwd });

      // No arguments: interactive dashboard overlay (x stops, r rescans).
      if (!arg) {
        await openAgyTasksPicker(ctx, rescan);
        updateAgyTasksWidget();
        return;
      }

      const tasks = await rescan();
      const stopMatch = arg.match(/^stop\s+(.+)$/);
      if (!stopMatch) {
        ctx.ui.notify('agy-tasks: usage "/agy-tasks" or "/agy-tasks stop <task-id>|all".', "error");
        return;
      }
      const target = stopMatch[1].trim();
      const selected =
        target === "all"
          ? tasks.filter((task) => task.pids.length > 0 || task.orphans.length > 0)
          : [findAgyTask(tasks, target)].filter(
              (task): task is NonNullable<typeof task> => task !== undefined,
            );
      if (selected.length === 0) {
        ctx.ui.notify(`agy-tasks: no running task "${target}" in this conversation.`, "error");
        return;
      }
      const results = await Promise.all(selected.map((task) => stopAgyTask(task)));
      const stopped = selected.map((task) => task.id).join(", ");
      ctx.ui.notify(
        `agy-tasks: sent SIGTERM to ${stopped} (${results.reduce((sum, count) => sum + count, 0)} process(es)).`,
        "info",
      );
      updateAgyTasksWidget();
    },
  });

  pi.registerCommand("agy-artifacts", {
    description: "List the agy conversation's artifacts (agent-created files, uploads)",
    handler: async (args, ctx) => {
      const snapshot = await runAntigravity(runtime, service.snapshot);
      const conversationId = snapshot.conversationId;
      if (!conversationId) {
        ctx.ui.notify("agy-artifacts: no agy conversation in this session yet.", "error");
        return;
      }
      const rescan = () => listAgyArtifacts(conversationId);
      const arg = args.trim();

      // `open <name>`: non-interactive open by exact name or unique prefix.
      const openMatch = arg.match(/^open\s+(.+)$/);
      if (openMatch) {
        const artifacts = await rescan();
        const artifact = findAgyArtifact(artifacts, openMatch[1]);
        if (!artifact) {
          ctx.ui.notify(`agy-artifacts: no artifact matching "${openMatch[1]}".`, "error");
          return;
        }
        try {
          await openArtifact(artifact.absolutePath);
          ctx.ui.notify(`agy-artifacts: opened ${artifact.name}`, "info");
        } catch (error) {
          ctx.ui.notify(
            `agy-artifacts: failed to open ${artifact.name} (${error instanceof Error ? error.message : error}).`,
            "error",
          );
        }
        return;
      }
      if (arg) {
        ctx.ui.notify(
          'agy-artifacts: usage "/agy-artifacts" or "/agy-artifacts open <name>".',
          "error",
        );
        return;
      }

      await openAgyArtifactsPicker(ctx, rescan);
    },
  });

  pi.registerCommand("agy-usage", {
    description: "Show Antigravity model quotas (weekly and 5-hour limits)",
    handler: async (args, ctx) => {
      if (args.trim()) {
        ctx.ui.notify('agy-usage: usage "/agy-usage".', "error");
        return;
      }
      await openAgyUsagePicker(ctx, (signal) => fetchAgyUsage({ signal }));
    },
  });
}
