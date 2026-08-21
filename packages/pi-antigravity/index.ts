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

import type { ExtensionAPI, ExtensionContext, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import path from "node:path";
import { piConfigDir, readJson, writeJson } from "./lib/config.ts";
import { AGY_BINARY } from "./lib/agy-client.ts";
import {
  CONTEXT_WINDOW,
  FALLBACK_MODELS,
  MAX_TOKENS,
  parseAgyModels,
  type AgyModelInfo,
} from "./lib/models.ts";
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

function toProviderModel(model: AgyModelInfo): ProviderModelConfig {
  return {
    id: model.id,
    name: model.name,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: CONTEXT_WINDOW,
    maxTokens: MAX_TOKENS,
  };
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
      return cached;
    }
  }
  const live = await listAgyModels();
  const cache: ModelCache = live.length
    ? { fetchedAt: Date.now(), source: "live", models: live }
    : { fetchedAt: Date.now(), source: "fallback", models: FALLBACK_MODELS };
  try {
    writeJson(MODEL_CACHE_FILE, cache);
  } catch {
    // Cache is best-effort; discovery still returns.
  }
  return cache;
}

export default async function antigravityExtension(pi: ExtensionAPI): Promise<void> {
  const runtime = createAntigravityRuntime();
  const service = runtime.runSync(AntigravityRuntime);
  const cache = await discoverModels();

  pi.registerProvider("antigravity", {
    name: "Google Antigravity (agy)",
    baseUrl: "agy://local-stream-json",
    apiKey: "agy-local-session",
    api: "antigravity-stream-json",
    models: cache.models.map(toProviderModel),
    streamSimple: streamAntigravity(runtime, service),
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
          streamSimple: streamAntigravity(runtime, service),
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
