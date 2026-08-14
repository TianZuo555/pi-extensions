// pi-repo-model — per-repository default model for pi.
//
// Stores one model preference per repository in a central, machine-local
// registry (~/.pi/repo-model/config.json) and auto-applies it at session start,
// so each repo remembers its own default model + thinking level without you
// touching global settings or the repo's own .pi/ folder.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  type ModelRuntime,
  resolveModelScopeWithDiagnostics,
  type ScopedModel,
} from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { type RepoMeta } from "./lib/repo-registry.ts";
import {
  createRepoModelRuntime,
  DEFAULT_TRIGGERS,
  type RepoModelConfig,
  type RepoModelEntry,
  RepoModelRuntime,
  type RepoModelRuntimeInstance,
  runRepoModel,
  type SessionStartReason,
} from "./src/runtime.ts";

// off + the reasoning levels pi supports.
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

const NO_OVERRIDE = "(no thinking override)";

function hasExplicitCliModel(): boolean {
  const args = process.argv.slice(2);
  return args.some((arg, index) =>
    arg === "--model" ? index + 1 < args.length : arg.startsWith("--model="),
  );
}

type ActionResult = { message: string; level: "info" | "warning" | "error" };

interface PickerTheme {
  fg(name: string, text: string): string;
  bold(text: string): string;
}
interface PickerKeybindings {
  matches(data: string, keybinding: string): boolean;
}

// --- scoped model list (your enabledModels) --------------------------------

interface ScopedModelOption {
  key: string; // provider/id — unique
  label: string; // friendly text shown in the dropdown
  provider: string;
  id: string;
  model: unknown;
  patternThinking?: ThinkingLevel; // thinking level hinted by the enabledModels pattern
}

function readEnabledModelPatterns(cwd: string): string[] {
  const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
  const files = [path.join(cwd, ".pi", "settings.json"), path.join(agentDir, "settings.json")];
  for (const file of files) {
    try {
      if (!fs.existsSync(file)) continue;
      const data = JSON.parse(fs.readFileSync(file, "utf-8")) as { enabledModels?: unknown };
      if (Array.isArray(data.enabledModels) && data.enabledModels.length) {
        return data.enabledModels.filter((x): x is string => typeof x === "string");
      }
    } catch {
      // ignore malformed settings
    }
  }
  return [];
}

async function getScopedModelOptions(ctx: ExtensionContext): Promise<ScopedModelOption[]> {
  const patterns = readEnabledModelPatterns(ctx.cwd);
  let scoped: ScopedModel[] = [];
  if (patterns.length) {
    const result = await resolveModelScopeWithDiagnostics(
      patterns,
      ctx.modelRegistry as unknown as ModelRuntime,
    );
    scoped = result.scopedModels;
  }
  if (scoped.length === 0) {
    scoped = ctx.modelRegistry.getAvailable().map((model) => ({ model }));
  }

  const seen = new Map<string, ScopedModelOption>();
  for (const s of scoped) {
    const m = s.model;
    const key = `${m.provider}/${m.id}`;
    if (seen.has(key)) continue;
    const name = (m.name as string | undefined) || (m.id as string);
    const label = name === m.id ? key : `${name} · ${key}`;
    seen.set(key, {
      key,
      label,
      provider: m.provider as string,
      id: m.id as string,
      model: m,
      patternThinking: s.thinkingLevel as ThinkingLevel | undefined,
    });
  }
  return [...seen.values()];
}

function thinkingLevelsForModel(model: unknown): ThinkingLevel[] {
  try {
    const levels = getSupportedThinkingLevels(
      model as Parameters<typeof getSupportedThinkingLevels>[0],
    ) as ThinkingLevel[];
    if (levels.length) return levels;
  } catch {
    // fall through to heuristic
  }
  const m = model as { reasoning?: boolean } | null | undefined;
  return m?.reasoning ? ["off", "minimal", "low", "medium", "high", "xhigh", "max"] : ["off"];
}

// --- model reference parsing (text path) -----------------------------------

interface ParsedRef {
  provider: string;
  model: string;
  thinkingLevel?: ThinkingLevel;
  error?: string;
}

function parseModelRef(raw: string): ParsedRef {
  const ref0 = raw.trim();
  if (!ref0) return { provider: "", model: "", error: "Empty model reference" };

  let thinkingLevel: ThinkingLevel | undefined;
  let ref = ref0;
  const lastColon = ref.lastIndexOf(":");
  if (lastColon > ref.lastIndexOf("/")) {
    const candidate = ref.slice(lastColon + 1).trim().toLowerCase();
    if (
      candidate === "off" ||
      ["minimal", "low", "medium", "high", "xhigh", "max"].includes(candidate)
    ) {
      thinkingLevel = candidate as ThinkingLevel;
      ref = ref.slice(0, lastColon).trim();
    }
  }

  const slashIdx = ref.indexOf("/");
  if (slashIdx === -1) {
    return { provider: "", model: ref, error: `Use the format provider/model (got "${ref}")` };
  }
  const provider = ref.slice(0, slashIdx).trim();
  const model = ref.slice(slashIdx + 1).trim();
  if (!provider || !model) {
    return { provider, model, error: "Both provider and model are required" };
  }
  return { provider, model, thinkingLevel };
}

function describeEntry(
  entry: Pick<RepoModelEntry, "provider" | "model" | "thinkingLevel">,
): string {
  const th = entry.thinkingLevel ? `:${entry.thinkingLevel}` : "";
  return `${entry.provider}/${entry.model}${th}`;
}

// --- model application ------------------------------------------------------

async function applyEntry(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  entry: RepoModelEntry,
  meta: RepoMeta,
  options: { silentIfNoChange?: boolean } = {},
): Promise<{ message: string; level: "info" | "warning"; changed: boolean }> {
  const model = ctx.modelRegistry.find(entry.provider, entry.model);
  if (!model) {
    return {
      message: `${meta.name}: ${describeEntry(entry)} not found in your models.`,
      level: "warning",
      changed: false,
    };
  }

  const current = ctx.model;
  const sameModel = current?.provider === entry.provider && current?.id === entry.model;
  const sameThinking = !entry.thinkingLevel || pi.getThinkingLevel() === entry.thinkingLevel;

  if (sameModel && sameThinking) {
    if (options.silentIfNoChange) return { message: "", level: "info", changed: false };
    return {
      message: `${meta.name}: already on ${describeEntry(entry)}`,
      level: "info",
      changed: false,
    };
  }

  const ok = await pi.setModel(model);
  if (!ok) {
    return {
      message: `${meta.name}: ${describeEntry(entry)} has no API key configured. Use /login or models.json.`,
      level: "warning",
      changed: false,
    };
  }
  if (entry.thinkingLevel) {
    pi.setThinkingLevel(entry.thinkingLevel as ThinkingLevel);
  }
  return { message: `${meta.name}: set to ${describeEntry(entry)}`, level: "info", changed: true };
}

// --- interactive two-stage picker (single custom component) -----------------

interface PickerResult {
  model: ScopedModelOption;
  thinking: ThinkingLevel | undefined;
}

interface PickerArgs {
  repoName: string;
  modelOptions: ScopedModelOption[];
  defaultModelIndex: number;
  theme: PickerTheme;
  keybindings: PickerKeybindings;
  done: (result: PickerResult | undefined) => void;
}

class RepoModelPicker extends Container {
  private readonly repoName: string;
  private readonly modelOptions: ScopedModelOption[];
  private readonly theme: PickerTheme;
  private readonly keybindings: PickerKeybindings;
  private readonly done: (result: PickerResult | undefined) => void;

  private stage: "model" | "thinking" = "model";
  private modelIndex: number;
  private picked: ScopedModelOption | undefined;
  private thinkingOptions: string[] = [];
  private thinkingValues: (ThinkingLevel | undefined)[] = [];
  private thinkingIndex = 0;

  constructor(args: PickerArgs) {
    super();
    this.repoName = args.repoName;
    this.modelOptions = args.modelOptions;
    this.modelIndex = Math.max(0, Math.min(args.defaultModelIndex, args.modelOptions.length - 1));
    this.theme = args.theme;
    this.keybindings = args.keybindings;
    this.done = args.done;
    this.rebuildUI();
  }

  private rebuildUI(): void {
    const lines: string[] = [];
    const t = this.theme;

    if (this.stage === "model") {
      lines.push(t.bold(t.fg("accent", `repo-model · ${this.repoName}`)));
      lines.push(t.fg("muted", "Step 1 of 2: pick the default model (Enter next · Esc cancel)"));
      lines.push("");

      const visibleRows = 10;
      const start = Math.max(
        0,
        Math.min(this.modelIndex - Math.floor(visibleRows / 2), this.modelOptions.length - visibleRows),
      );
      const end = Math.min(start + visibleRows, this.modelOptions.length);

      for (let i = start; i < end; i++) {
        const opt = this.modelOptions[i]!;
        const selected = i === this.modelIndex;
        const prefix = selected ? t.fg("accent", "❯ ") : "  ";
        const text = selected ? t.bold(opt.label) : opt.label;
        lines.push(`${prefix}${text}`);
      }
    } else {
      lines.push(t.bold(t.fg("accent", `repo-model · ${this.repoName}`)));
      lines.push(
        t.fg(
          "muted",
          `Step 2 of 2: thinking level for ${this.picked?.label ?? ""} (Enter save · Esc cancel)`,
        ),
      );
      lines.push("");

      for (let i = 0; i < this.thinkingOptions.length; i++) {
        const selected = i === this.thinkingIndex;
        const prefix = selected ? t.fg("accent", "❯ ") : "  ";
        const text = selected
          ? t.bold(this.thinkingOptions[i]!)
          : this.thinkingOptions[i]!;
        lines.push(`${prefix}${text}`);
      }
    }

    this.children = [new Text(lines.join("\n"), 0, 0), new Spacer(1)];
  }

  handleInput(data: string): boolean {
    if (this.keybindings.matches(data, "cancel") || data === "\x1b") {
      this.done(undefined);
      return true;
    }

    if (this.stage === "model") {
      if (this.keybindings.matches(data, "up") || data === "\x1b[A") {
        this.modelIndex = (this.modelIndex - 1 + this.modelOptions.length) % this.modelOptions.length;
        this.rebuildUI();
        return true;
      }
      if (this.keybindings.matches(data, "down") || data === "\x1b[B") {
        this.modelIndex = (this.modelIndex + 1) % this.modelOptions.length;
        this.rebuildUI();
        return true;
      }
      if (this.keybindings.matches(data, "select") || data === "\r" || data === "\n") {
        this.picked = this.modelOptions[this.modelIndex];
        if (!this.picked) return true;

        const supported = thinkingLevelsForModel(this.picked.model);
        this.thinkingOptions = [NO_OVERRIDE, ...supported];
        this.thinkingValues = [undefined, ...supported];
        this.thinkingIndex = 0;

        if (this.picked.patternThinking && supported.includes(this.picked.patternThinking)) {
          const matchIdx = this.thinkingValues.indexOf(this.picked.patternThinking);
          if (matchIdx !== -1) this.thinkingIndex = matchIdx;
        }

        this.stage = "thinking";
        this.rebuildUI();
        return true;
      }
      return false;
    }

    // stage === "thinking"
    if (this.keybindings.matches(data, "up") || data === "\x1b[A") {
      this.thinkingIndex =
        (this.thinkingIndex - 1 + this.thinkingOptions.length) % this.thinkingOptions.length;
      this.rebuildUI();
      return true;
    }
    if (this.keybindings.matches(data, "down") || data === "\x1b[B") {
      this.thinkingIndex = (this.thinkingIndex + 1) % this.thinkingOptions.length;
      this.rebuildUI();
      return true;
    }
    if (this.keybindings.matches(data, "select") || data === "\r" || data === "\n") {
      if (!this.picked) {
        this.done(undefined);
        return true;
      }
      const thinking = this.thinkingValues[this.thinkingIndex];
      this.done({ model: this.picked, thinking });
      return true;
    }

    return false;
  }
}

async function interactiveSet(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  runtime: RepoModelRuntimeInstance,
): Promise<ActionResult> {
  const service = runtime.runSync(RepoModelRuntime);
  const meta = await runRepoModel(runtime, service.getRepoMeta(ctx.cwd));
  const options = await getScopedModelOptions(ctx);
  if (options.length === 0) {
    return {
      message: "No models available. Check enabledModels or sign in with /login.",
      level: "error",
    };
  }

  const currentEntry = await runRepoModel(runtime, service.getRepoModel(ctx.cwd));
  const currentKey = currentEntry ? `${currentEntry.provider}/${currentEntry.model}` : undefined;

  let defaultModelIndex = 0;
  if (currentKey) {
    const idx = options.findIndex((o) => o.key === currentKey);
    if (idx !== -1) defaultModelIndex = idx;
  } else if (ctx.model) {
    const activeKey = `${ctx.model.provider}/${ctx.model.id}`;
    const idx = options.findIndex((o) => o.key === activeKey);
    if (idx !== -1) defaultModelIndex = idx;
  }

  const ordered = [...options];
  if (currentKey && defaultModelIndex > 0) {
    const [current] = ordered.splice(defaultModelIndex, 1);
    if (current) {
      ordered.unshift(current);
      defaultModelIndex = 0;
    }
  }

  const custom = (ctx.ui as { custom?: Function }).custom;
  if (typeof custom !== "function") {
    const label = await ctx.ui.select(
      `repo-model · pick a model for ${meta.name}`,
      ordered.map((o) => o.label),
    );
    if (!label) return { message: "cancelled", level: "info" };
    const picked = ordered.find((o) => o.label === label);
    if (!picked) return { message: "invalid model selection", level: "error" };
    return commitEntry(pi, ctx, meta, picked, undefined, runtime);
  }

  const result = await custom.call(
    ctx.ui,
    (
      _tui: unknown,
      theme: PickerTheme,
      keybindings: PickerKeybindings,
      done: (r: PickerResult | undefined) => void,
    ) =>
      new RepoModelPicker({
        repoName: meta.name,
        modelOptions: ordered,
        defaultModelIndex,
        theme,
        keybindings,
        done,
      }),
  );
  if (!result) return { message: "cancelled", level: "info" };

  return commitEntry(pi, ctx, meta, result.model, result.thinking, runtime);
}

async function commitEntry(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  meta: RepoMeta,
  picked: ScopedModelOption,
  thinking: ThinkingLevel | undefined,
  runtime: RepoModelRuntimeInstance,
): Promise<ActionResult> {
  const service = runtime.runSync(RepoModelRuntime);
  const entry: RepoModelEntry = {
    name: meta.name,
    provider: picked.provider,
    model: picked.id,
    thinkingLevel: thinking,
  };
  await runRepoModel(runtime, service.setRepoModel(ctx.cwd, entry));

  const result = await applyEntry(pi, ctx, entry, meta);
  return { message: result.message, level: result.level };
}

async function runAction(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  action: "get" | "set" | "unset" | "list",
  runtime: RepoModelRuntimeInstance,
  modelRef?: string,
): Promise<ActionResult> {
  const service = runtime.runSync(RepoModelRuntime);
  const meta = await runRepoModel(runtime, service.getRepoMeta(ctx.cwd));

  if (action === "list") {
    const entries = await runRepoModel(runtime, service.listRepos);
    if (entries.length === 0) {
      return { message: "No repos configured. Use /repo-model to pick one.", level: "info" };
    }
    const lines = entries.map((e) => {
      const mark = e.path === meta.key ? " (current)" : "";
      return `${e.name}  ->  ${describeEntry(e.entry)}${mark}`;
    });
    return { message: `repo-model (${entries.length}):\n${lines.join("\n")}`, level: "info" };
  }

  if (action === "get") {
    const entry = await runRepoModel(runtime, service.getRepoModel(ctx.cwd));
    if (!entry) {
      return { message: `${meta.name}: no default set. Run /repo-model to pick one.`, level: "info" };
    }
    return { message: `${meta.name} -> ${describeEntry(entry)}`, level: "info" };
  }

  if (action === "unset") {
    const res = await runRepoModel(runtime, service.unsetRepoModel(ctx.cwd));
    if (!res.removed) return { message: `${meta.name}: nothing to unset`, level: "info" };
    return { message: `${meta.name}: cleared repo default`, level: "info" };
  }

  // action === "set" (text form)
  if (!modelRef?.trim()) {
    return { message: "Usage: /repo-model provider/model[:thinking]", level: "error" };
  }
  const parsed = parseModelRef(modelRef);
  if (parsed.error) return { message: parsed.error, level: "error" };
  if (!ctx.modelRegistry.find(parsed.provider, parsed.model)) {
    return { message: `${parsed.provider}/${parsed.model} not found in your models`, level: "error" };
  }

  const entry: RepoModelEntry = {
    name: meta.name,
    provider: parsed.provider,
    model: parsed.model,
    thinkingLevel: parsed.thinkingLevel,
  };
  await runRepoModel(runtime, service.setRepoModel(ctx.cwd, entry));

  const result = await applyEntry(pi, ctx, entry, meta);
  return { message: result.message, level: result.level };
}

function notify(ctx: ExtensionContext, result: ActionResult): void {
  if (result.message === "cancelled") {
    ctx.ui.notify("repo-model: cancelled", "info");
    return;
  }
  ctx.ui.notify(
    result.message.startsWith("repo-model") ? result.message : `repo-model: ${result.message}`,
    result.level === "info" ? "info" : result.level === "error" ? "error" : "warning",
  );
}

// --- extension --------------------------------------------------------------

export default function repoModelExtension(pi: ExtensionAPI): void {
  const runtime = createRepoModelRuntime();
  const service = runtime.runSync(RepoModelRuntime);

  pi.on("session_start", async (event, ctx) => {
    if (event.reason === "startup" && hasExplicitCliModel()) return;

    const config = await runRepoModel(runtime, service.loadConfig);
    const triggers = config.triggers ?? DEFAULT_TRIGGERS;
    if (!triggers.includes(event.reason)) return;

    const meta = await runRepoModel(runtime, service.getRepoMeta(ctx.cwd));
    const entry = await runRepoModel(runtime, service.getRepoModel(ctx.cwd));
    if (!entry) return;

    const result = await applyEntry(pi, ctx, entry, meta, { silentIfNoChange: true });
    if (result.message) {
      ctx.ui.notify(`repo-model: ${result.message}`, result.level);
    }
  });

  pi.on("session_shutdown", async () => {
    try {
      await runtime.dispose();
    } catch {
      // Disposed gracefully
    }
  });

  pi.registerCommand("repo-model", {
    description:
      "Pick the repo default model + thinking level (dropdowns), or set via provider/model[:thinking]",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (trimmed) {
        notify(ctx, await runAction(pi, ctx, "set", runtime, trimmed));
        return;
      }
      if (ctx.hasUI) {
        notify(ctx, await interactiveSet(pi, ctx, runtime));
        return;
      }
      notify(ctx, await runAction(pi, ctx, "get", runtime));
    },
  });

  pi.registerCommand("repo-model-unset", {
    description: "Remove the default model override for the current repo",
    handler: async (_args, ctx) => {
      notify(ctx, await runAction(pi, ctx, "unset", runtime));
    },
  });

  pi.registerCommand("repo-model-list", {
    description: "List all configured repo default models",
    handler: async (_args, ctx) => {
      notify(ctx, await runAction(pi, ctx, "list", runtime));
    },
  });
}
