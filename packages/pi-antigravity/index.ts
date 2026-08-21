// antigravity — use Google Antigravity (agy) models inside the pi coding
// agent via the agy stream-json RPC. pi stays the UI: model picker, sessions,
// compaction, and rendering; agy runs the Gemini agent loop underneath with
// --dangerously-skip-permissions always enabled (headless agy turns
// auto-deny tools that would need a permission prompt otherwise).
//
// Commands:
//   /agy            show agy conversation status (id, model, turns)
//   /agy reset      drop the current agy conversation (next turn starts fresh)
//   /agy models     re-discover models from `agy models` and re-register

import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
  ProviderModelConfig,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { execFile } from "node:child_process";
import path from "node:path";
import { piConfigDir, readJson, writeJson } from "./lib/config.ts";
import { AGY_BINARY } from "./lib/agy-client.ts";
import {
  AgyPiBridge,
  BRIDGE_SERVER_NAME,
  type BridgeToolDef,
} from "./lib/bridge.ts";
import {
  formatSkillCatalog,
  nonWorkspaceSkills,
  readSkillBundle,
  type SkillLite,
} from "./lib/skills.ts";
import {
  CONTEXT_WINDOW,
  FALLBACK_MODELS,
  MAX_TOKENS,
  normalizeAgyModelId,
  parseAgyModels,
  pricingForModel,
  type AgyModelInfo,
} from "./lib/models.ts";
import { AgyReplayStore, type RecordedAgyTool } from "./lib/replay.ts";
import { findAgyTask, listAgyTasks, stopAgyTask, type AgyTask } from "./lib/tasks.ts";
import { openAgyTasksPicker } from "./src/tasks-ui.ts";
import {
  agyToolLabel,
  formatAgyCall,
  summarizeAgyResult,
} from "./lib/render.ts";
import { streamAntigravity } from "./src/provider.ts";
import {
  AntigravityRuntime,
  createAntigravityRuntime,
  runAntigravity,
} from "./src/runtime.ts";

const MODEL_CACHE_FILE = path.join(piConfigDir("antigravity"), "model-list.json");
const MODEL_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const DISCOVERY_TIMEOUT_MS = 15_000;

// --- Pi-tool bridge ---------------------------------------------------------

const BRIDGE_ENABLED = process.env.PI_ANTIGRAVITY_PI_TOOL_BRIDGE !== "0";
const EXPOSE_BUILTIN_TOOLS = process.env.PI_ANTIGRAVITY_EXPOSE_BUILTIN_TOOLS === "1";

/**
 * Built-in pi tools hidden from the bridge by default — agy has native
 * equivalents, and duplicating them bloats agy's prompt and invites it to
 * round-trip work through pi for no gain.
 */
const HIDDEN_BUILTIN_TOOLS = new Set(["read", "bash", "write", "edit", "grep", "find", "ls"]);

function execAgy(args: string[], timeoutMs = DISCOVERY_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(AGY_BINARY, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message));
      else resolve(stdout);
    });
  });
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
  return {
    id: model.id,
    name: model.name,
    reasoning: true,
    input: ["text"],
    cost: pricingForModel(model.id),
    contextWindow: CONTEXT_WINDOW,
    maxTokens: MAX_TOKENS,
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

function listAgyModels(): Promise<AgyModelInfo[]> {
  return new Promise((resolve) => {
    execFile(AGY_BINARY, ["models"], { timeout: DISCOVERY_TIMEOUT_MS }, (err, stdout) => {
      if (err) resolve([]);
      else resolve(parseAgyModels(stdout));
    });
  });
}

async function discoverModels(refresh = false): Promise<ModelCache> {
  if (!refresh) {
    const cached = readJson<ModelCache | null>(MODEL_CACHE_FILE, null);
    if (
      cached?.models?.length &&
      cached.fetchedAt &&
      Date.now() - cached.fetchedAt < MODEL_CACHE_TTL_MS
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

const AGY_TOOL_DESCRIPTION =
  "Replay a recorded Google Antigravity (agy) tool result. The agy agent already ran the tool; calling this only returns the recorded output.";

export default async function antigravityExtension(pi: ExtensionAPI): Promise<void> {
  const runtime = createAntigravityRuntime();
  const service = runtime.runSync(AntigravityRuntime);
  const replay = new AgyReplayStore();
  const cache = await discoverModels();

  // --- Pi-tool bridge setup -------------------------------------------------

  const bridge = new AgyPiBridge();
  bridge.setOnCall((call) => service.pushBridgeCall(call));

  // --- Skill passing (Phase 2) ----------------------------------------------
  // pi's loaded skills, refreshed per turn via before_agent_start so /reload
  // is respected. Model-invocation-disabled skills are excluded.
  let loadedSkills: SkillLite[] = [];

  function captureSkills(skills: unknown): void {
    if (!Array.isArray(skills)) return;
    loadedSkills = skills
      .map((skill) => skill as Partial<SkillLite> & { disableModelInvocation?: boolean })
      .filter((skill) => skill.disableModelInvocation !== true && typeof skill.filePath === "string")
      .map((skill) => ({
        name: String(skill.name),
        description: String(skill.description ?? ""),
        filePath: String(skill.filePath),
        baseDir: String(skill.baseDir ?? path.dirname(String(skill.filePath))),
      }));
  }

  const getBootstrapSuffix = () =>
    formatSkillCatalog(
      // agy injects workspace .agents/skills itself — only bridge the rest.
      nonWorkspaceSkills(loadedSkills, tasksSessionCwd),
      BRIDGE_ENABLED ? "bridge" : "direct",
    );

  bridge.setToolSource(() => {
    if (!BRIDGE_ENABLED) return [];
    let activeNames: string[] = [];
    let allTools: Array<{
      name: string;
      description?: string;
      parameters?: unknown;
      sourceInfo?: { source?: string };
    }> = [];
    try {
      activeNames = pi.getActiveTools();
      allTools = pi.getAllTools() as typeof allTools;
    } catch {
      return []; // API unavailable (print/RPC edge) — expose nothing.
    }
    const active = new Set(activeNames);
    const tools: BridgeToolDef[] = [];
    for (const tool of allTools) {
      if (!active.has(tool.name)) continue;
      if (tool.name === "agy") continue; // display-only replay wrapper
      const source = tool.sourceInfo?.source;
      if (
        !EXPOSE_BUILTIN_TOOLS &&
        (source === "builtin" || HIDDEN_BUILTIN_TOOLS.has(tool.name))
      ) {
        continue;
      }
      tools.push({ name: tool.name, description: tool.description ?? "", parameters: tool.parameters });
    }
    return tools;
  });

  // Bridge-virtual tool: activate_skill is a local file read — handled
  // in-process, no pi toolUse round-trip needed.
  bridge.registerVirtualTool(
    "activate_skill",
    {
      description:
        "Activate a pi Agent Skill by name: returns the full SKILL.md instructions and the absolute paths of bundled resources. Activate a skill before following its workflow.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Skill name from the pi Agent Skills catalog" },
        },
        required: ["name"],
      },
    },
    async (args) => {
      const name = String(args.name ?? "").trim();
      const skill = loadedSkills.find((candidate) => candidate.name === name);
      if (!skill) {
        const known = loadedSkills.map((candidate) => candidate.name).join(", ") || "(none)";
        return { content: `antigravity: unknown skill "${name}". Available: ${known}.`, isError: true };
      }
      return readSkillBundle(skill);
    },
  );

  // --- Status-bar hint for live agy background tasks -----------------------

  const AGY_TASKS_WIDGET_KEY = "agy-tasks";
  let tasksUi: ExtensionUIContext | undefined;
  let tasksSessionCwd: string | undefined;
  let widgetLiveCount = -1;
  let widgetScanInFlight = false;

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

  /** Rescan the conversation's task logs and refresh the status-bar hint. */
  function updateAgyTasksWidget(): void {
    if (!tasksUi || widgetScanInFlight) return;
    widgetScanInFlight = true;
    void (async () => {
      try {
        const snapshot = await runAntigravity(runtime, service.snapshot);
        if (!snapshot.conversationId) {
          setAgyTasksWidget(0);
          return;
        }
        const tasks = await listAgyTasks(snapshot.conversationId, {
          sessionCwd: tasksSessionCwd,
        });
        setAgyTasksWidget(
          tasks.filter((task) => task.pids.length > 0 || task.orphans.length > 0).length,
        );
      } catch {
        // Runtime closed or scan failed; leave the widget as-is.
      } finally {
        widgetScanInFlight = false;
      }
    })();
  }

  pi.registerTool({
    name: "agy",
    label: "antigravity",
    description: AGY_TOOL_DESCRIPTION,
    parameters: Type.Object({
      tool: Type.String({ description: "Recorded agy tool name" }),
      input: Type.Unknown({ description: "Recorded agy tool arguments" }),
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
        content: [
          { type: "text", text: body ? body.slice(0, 16_000) : "(no output)" },
        ],
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
        text += "\n" + shown.map((line) => theme.fg("toolOutput", line)).join("\n");
        if (!expanded && lines.length > 3) {
          text += theme.fg("muted", `\n… +${lines.length - 3} lines (ctrl+o to expand)`);
        }
      }
      return new Text(text, 0, 0);
    },
  });

  pi.registerProvider("antigravity", {
    name: "Google Antigravity (agy)",
    baseUrl: "agy://local-stream-json",
    apiKey: "agy-local-session",
    api: "antigravity-stream-json",
    models: cache.models.map(toProviderModel),
    streamSimple: streamAntigravity(
      runtime,
      service,
      replay,
      bridge,
      updateAgyTasksWidget,
      getBootstrapSuffix,
    ),
  });

  pi.on("before_agent_start", (event) => {
    captureSkills(event.systemPromptOptions?.skills);
  });

  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    await runAntigravity(runtime, service.setSession(ctx.cwd, undefined));
    if (ctx.hasUI) tasksUi = ctx.ui;
    tasksSessionCwd = ctx.cwd;
    updateAgyTasksWidget();
    // Bridge must be registered before the first agy spawn of the session:
    // agy eagerly connects to MCP servers at startup (verified 2026-08-21).
    if (BRIDGE_ENABLED) {
      try {
        await bridge.start();
        await execAgy(["mcp", "add", "--type", "http", BRIDGE_SERVER_NAME, bridge.url!]);
        bridge.refreshTools();
      } catch (error) {
        ctx.ui.notify(
          `antigravity: pi-tool bridge unavailable (${error instanceof Error ? error.message : error}).`,
          "warning",
        );
      }
    }
  });

  pi.on("session_shutdown", async () => {
    // Stop any live agy background tasks so closing pi leaves nothing
    // running silently. Runs before service.close: the orphan scan needs
    // the task logs' birth times, and killing agy first turns direct-pid
    // detections into orphan detections (both are handled, but earlier is
    // more precise).
    try {
      const snapshot = await runAntigravity(runtime, service.snapshot);
      if (snapshot.conversationId) {
        const tasks = await listAgyTasks(snapshot.conversationId, {
          sessionCwd: tasksSessionCwd,
        });
        const live = tasks.filter(
          (task) => task.pids.length > 0 || task.orphans.length > 0,
        );
        await Promise.all(live.map((task) => stopAgyTask(task)));
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
    if (bridge.running) {
      try {
        await execAgy(["mcp", "remove", BRIDGE_SERVER_NAME]);
      } catch {
        // Registration may already be gone.
      }
      await bridge.close();
    }
    try {
      tasksUi?.setWidget(AGY_TASKS_WIDGET_KEY, undefined);
    } catch {
      // UI may already be gone.
    }
    tasksUi = undefined;
    widgetLiveCount = -1;
    try {
      await runtime.dispose();
    } catch {
      // Disposed gracefully
    }
  });

  pi.registerCommand("agy", {
    description: "Manage the agy backend: status | reset | models",
    handler: async (args, ctx) => {
      const sub = args.trim().toLowerCase();
      if (sub === "reset") {
        await runAntigravity(runtime, service.reset);
        ctx.ui.notify("antigravity: conversation reset; next turn starts fresh.", "info");
        return;
      }
      if (sub === "models") {
        const refreshed = await discoverModels(true);
        pi.registerProvider("antigravity", {
          name: "Google Antigravity (agy)",
          baseUrl: "agy://local-stream-json",
          apiKey: "agy-local-session",
          api: "antigravity-stream-json",
          models: refreshed.models.map(toProviderModel),
          streamSimple: streamAntigravity(
            runtime,
            service,
            replay,
            bridge,
            updateAgyTasksWidget,
            getBootstrapSuffix,
          ),
        });
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
      ctx.ui.notify(
        `antigravity: conversation ${id}\nmodel: ${snapshot.model ?? "unselected"} · turns: ${snapshot.turns} · models: ${cache.models.length} (${cache.source})`,
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
}
