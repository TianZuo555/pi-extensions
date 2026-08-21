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

import type { ExtensionAPI, ExtensionContext, ProviderModelConfig, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { execFile } from "node:child_process";
import path from "node:path";
import { piConfigDir, readJson, writeJson } from "./lib/config.ts";
import { AGY_BINARY } from "./lib/agy-client.ts";
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
    streamSimple: streamAntigravity(runtime, service, replay),
  });

  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    await runAntigravity(runtime, service.setSession(ctx.cwd, undefined));
  });

  pi.on("session_shutdown", async () => {
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
          streamSimple: streamAntigravity(runtime, service, replay),
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
}
