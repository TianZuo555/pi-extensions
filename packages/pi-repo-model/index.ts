// pi-repo-model — per-repository default model for pi.
//
// Stores one model preference per repository in a central, machine-local
// registry (~/.pi/repo-model/config.json) and auto-applies it at session start,
// so each repo remembers its own default model + thinking level without you
// touching global settings or the repo's own .pi/ folder.
//
// Inspired by how pi-memory-md keeps per-project data keyed by git root.
//
// Commands (interactive):
//   /repo-model                    pick model, then thinking level, from dropdowns
//                                  (models come from your scoped enabledModels list;
//                                   rendered as one custom picker so both steps show)
//   /repo-model provider/model[:t] set directly, e.g. /repo-model cursor/composer-2.5:high
//   /repo-model-unset              clear current repo's default
//   /repo-model-list               list every configured repo
//
// Config lives at ~/.pi/repo-model/config.json (machine-local, never synced):
//   {
//     "version": 1,
//     "triggers": ["startup", "new"],
//     "repos": {
//       "/abs/path/to/repo": {
//         "name": "repo", "provider": "cursor", "model": "composer-2.5",
//         "thinkingLevel": "high", "updatedAt": "..."
//       }
//     }
//   }

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type ModelRuntime, resolveModelScopeWithDiagnostics, type ScopedModel } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { getRepoMeta, piConfigDir, readJson, type RepoMeta, writeJson } from "./lib/repo-registry";

// off + the reasoning levels pi supports.
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
type SessionStartReason = "startup" | "new" | "resume" | "fork" | "reload";

const DEFAULT_TRIGGERS: SessionStartReason[] = ["startup", "new"];

const CONFIG_FILE = path.join(piConfigDir("repo-model"), "config.json");

const NO_OVERRIDE = "(no thinking override)";

interface RepoModelEntry {
  name?: string;
  provider: string;
  model: string;
  thinkingLevel?: ThinkingLevel;
  updatedAt?: string;
}

interface RepoModelConfig {
  version: number;
  triggers?: SessionStartReason[];
  repos?: Record<string, RepoModelEntry>;
}

type ActionResult = { message: string; level: "info" | "warning" | "error" };

// Minimal structural type for the Theme and KeybindingsManager we use inside the
// picker. Kept loose so we don't depend on private type re-exports.
interface PickerTheme {
  fg(name: string, text: string): string;
  bold(text: string): string;
}
interface PickerKeybindings {
  matches(data: string, keybinding: string): boolean;
}

// --- config persistence -----------------------------------------------------

function loadConfig(): RepoModelConfig {
  const data = readJson<RepoModelConfig>(CONFIG_FILE, { version: 1, triggers: DEFAULT_TRIGGERS, repos: {} });
  return {
    version: 1,
    triggers: (data.triggers?.length ? data.triggers : DEFAULT_TRIGGERS) as SessionStartReason[],
    repos: data.repos ?? {},
  };
}

function saveConfig(config: RepoModelConfig): void {
  try {
    writeJson(CONFIG_FILE, config);
  } catch (error) {
    console.warn("[pi-repo-model] Failed to write config:", error);
  }
}

// --- scoped model list (your enabledModels) --------------------------------

interface ScopedModelOption {
  key: string; // provider/id — unique
  label: string; // friendly text shown in the dropdown
  provider: string;
  id: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  model: any;
  patternThinking?: ThinkingLevel; // thinking level hinted by the enabledModels pattern
}

function readEnabledModelPatterns(cwd: string): string[] {
  const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
  // project overrides global for arrays, so check it first.
  const files = [path.join(cwd, ".pi", "settings.json"), path.join(agentDir, "settings.json")];
  for (const file of files) {
    try {
      if (!fs.existsSync(file)) continue;
      const data = JSON.parse(fs.readFileSync(file, "utf-8")) as { enabledModels?: unknown };
      if (Array.isArray(data.enabledModels) && data.enabledModels.length) {
        return data.enabledModels.filter((x): x is string => typeof x === "string");
      }
    } catch {
      // ignore malformed settings, try the next file
    }
  }
  return [];
}

async function getScopedModelOptions(ctx: ExtensionContext): Promise<ScopedModelOption[]> {
  const patterns = readEnabledModelPatterns(ctx.cwd);
  let scoped: ScopedModel[] = [];
  if (patterns.length) {
    // ctx.modelRegistry is the runtime pi hands us; the exported type is narrower
    // than what this helper accepts, so bridge it explicitly.
    const result = await resolveModelScopeWithDiagnostics(patterns, ctx.modelRegistry as unknown as ModelRuntime);
    scoped = result.scopedModels;
  }
  // No enabledModels configured (or nothing matched): fall back to every model
  // that has auth so the picker is never empty.
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
    // fall through to the heuristic below
  }
  // Heuristic fallback if the helper surprises us: reasoning models get the
  // full ladder, non-reasoning models only get "off".
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
  // A trailing :level only counts when it sits after the provider/model slash
  // and matches a known thinking level.
  if (lastColon > ref.lastIndexOf("/")) {
    const candidate = ref.slice(lastColon + 1).trim().toLowerCase();
    if (candidate === "off" || ["minimal", "low", "medium", "high", "xhigh", "max"].includes(candidate)) {
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

function describeEntry(entry: Pick<RepoModelEntry, "provider" | "model" | "thinkingLevel">): string {
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
    return { message: `${meta.name}: already on ${describeEntry(entry)}`, level: "info", changed: false };
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
    pi.setThinkingLevel(entry.thinkingLevel);
  }
  return { message: `${meta.name}: set to ${describeEntry(entry)}`, level: "info", changed: true };
}

// --- interactive two-stage picker (single custom component) -----------------
//
// Both stages live inside ONE ctx.ui.custom() component. This avoids the
// rendering race that happens when two ctx.ui.select() calls run back-to-back
// (the second dropdown's options can render blank).

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

  private readonly titleText: Text;
  private readonly footerText: Text;
  private readonly listContainer: Container;

  constructor(args: PickerArgs) {
    super();
    this.repoName = args.repoName;
    this.modelOptions = args.modelOptions;
    this.theme = args.theme;
    this.keybindings = args.keybindings;
    this.done = args.done;
    this.modelIndex = args.defaultModelIndex;

    this.addChild(new Spacer(1));
    this.titleText = new Text(this.titleLine(), 1, 0);
    this.addChild(this.titleText);
    this.addChild(new Spacer(1));
    this.listContainer = new Container();
    this.addChild(this.listContainer);
    this.addChild(new Spacer(1));
    this.footerText = new Text(this.footerLine(), 1, 0);
    this.addChild(this.footerText);
    this.addChild(new Spacer(1));
    this.updateList();
  }

  private titleLine(): string {
    const title =
      this.stage === "model"
        ? `repo-model · pick a model for ${this.repoName}`
        : `repo-model · thinking level for ${this.picked?.key ?? ""}`;
    return this.theme.fg("accent", this.theme.bold(title));
  }

  private footerLine(): string {
    const hint = this.stage === "model" ? "esc cancel" : "esc back to models";
    return this.theme.fg("dim", `↑↓ navigate · enter select · ${hint}`);
  }

  private refreshChrome(): void {
    this.titleText.setText(this.titleLine());
    this.footerText.setText(this.footerLine());
  }

  private updateList(): void {
    this.listContainer.clear();
    const labels = this.stage === "model" ? this.modelOptions.map((o) => o.label) : this.thinkingOptions;
    const idx = this.stage === "model" ? this.modelIndex : this.thinkingIndex;
    for (let i = 0; i < labels.length; i++) {
      const selected = i === idx;
      const line = selected
        ? this.theme.fg("accent", `→ ${labels[i]}`)
        : this.theme.fg("text", `  ${labels[i]}`);
      this.listContainer.addChild(new Text(line, 1, 0));
    }
  }

  handleInput(keyData: string): void {
    const kb = this.keybindings;
    if (kb.matches(keyData, "tui.select.up") || keyData === "k") {
      this.move(-1);
    } else if (kb.matches(keyData, "tui.select.down") || keyData === "j") {
      this.move(1);
    } else if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n" || keyData === "\r") {
      this.confirm();
    } else if (kb.matches(keyData, "tui.select.cancel") || keyData === "\u001b") {
      this.cancel();
    }
  }

  private move(delta: number): void {
    if (this.stage === "model") {
      const n = this.modelOptions.length;
      if (n === 0) return;
      this.modelIndex = (this.modelIndex + delta + n) % n;
    } else {
      const n = this.thinkingOptions.length;
      if (n === 0) return;
      this.thinkingIndex = (this.thinkingIndex + delta + n) % n;
    }
    this.updateList();
  }

  private confirm(): void {
    if (this.stage === "model") {
      this.picked = this.modelOptions[this.modelIndex];
      if (!this.picked) {
        this.done(undefined);
        return;
      }
      const levels = thinkingLevelsForModel(this.picked.model);
      this.thinkingValues = [undefined, ...levels];
      this.thinkingOptions = [NO_OVERRIDE, ...levels];
      this.thinkingIndex = 0;
      this.stage = "thinking";
      this.refreshChrome();
      this.updateList();
      return;
    }
    this.done({ model: this.picked!, thinking: this.thinkingValues[this.thinkingIndex] });
  }

  private cancel(): void {
    // From the thinking stage, esc goes back to the model list (so a mis-pick is
    // cheap to fix). From the model stage, esc cancels the whole flow.
    if (this.stage === "thinking") {
      this.stage = "model";
      this.refreshChrome();
      this.updateList();
      return;
    }
    this.done(undefined);
  }
}

async function interactiveSet(pi: ExtensionAPI, ctx: ExtensionContext): Promise<ActionResult> {
  const meta = getRepoMeta(ctx.cwd);
  const options = await getScopedModelOptions(ctx);
  if (options.length === 0) {
    return {
      message: "No models available. Configure enabledModels in settings.json or add models in models.json.",
      level: "error",
    };
  }

  const currentKey = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
  // Current model first (handy default), then alphabetical.
  const ordered = [...options].sort((a, b) => {
    if (a.key === currentKey) return -1;
    if (b.key === currentKey) return 1;
    return a.label.localeCompare(b.label);
  });
  const defaultModelIndex = Math.max(
    0,
    ordered.findIndex((o) => o.key === currentKey),
  );

  const custom = (ctx.ui as { custom?: Function }).custom;
  if (typeof custom !== "function") {
    // Fallback (older runtime, no custom()): skip the thinking picker to avoid
    // the back-to-back select race; just pick a model with no thinking override.
    const label = await ctx.ui.select(`repo-model · pick a model for ${meta.name}`, ordered.map((o) => o.label));
    if (!label) return { message: "cancelled", level: "info" };
    const picked = ordered.find((o) => o.label === label);
    if (!picked) return { message: "invalid model selection", level: "error" };
    return commitEntry(pi, ctx, meta, picked, undefined);
  }

  const result = await custom.call(
    ctx.ui,
    (_tui: unknown, theme: PickerTheme, keybindings: PickerKeybindings, done: (r: PickerResult | undefined) => void) =>
      new RepoModelPicker({ repoName: meta.name, modelOptions: ordered, defaultModelIndex, theme, keybindings, done }),
  );
  if (!result) return { message: "cancelled", level: "info" };

  return commitEntry(pi, ctx, meta, result.model, result.thinking);
}

async function commitEntry(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  meta: RepoMeta,
  picked: ScopedModelOption,
  thinking: ThinkingLevel | undefined,
): Promise<ActionResult> {
  const entry: RepoModelEntry = {
    name: meta.name,
    provider: picked.provider,
    model: picked.id,
    thinkingLevel: thinking,
    updatedAt: new Date().toISOString(),
  };
  const config = loadConfig();
  config.repos ??= {};
  config.repos[meta.key] = entry;
  saveConfig(config);

  const result = await applyEntry(pi, ctx, entry, meta);
  return { message: result.message, level: result.level };
}

// --- action core (text + get/unset/list, shared with the tool) --------------

async function runAction(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  action: "get" | "set" | "unset" | "list",
  modelRef?: string,
): Promise<ActionResult> {
  const config = loadConfig();
  const meta = getRepoMeta(ctx.cwd);

  if (action === "list") {
    const entries = Object.entries(config.repos ?? {});
    if (entries.length === 0) {
      return { message: "No repos configured. Use /repo-model to pick one.", level: "info" };
    }
    const lines = entries.map(([key, e]) => {
      const mark = key === meta.key ? " (current)" : "";
      return `${e.name ?? path.basename(key)}  ->  ${describeEntry(e)}${mark}`;
    });
    return { message: `repo-model (${entries.length}):\n${lines.join("\n")}`, level: "info" };
  }

  if (action === "get") {
    const entry = config.repos?.[meta.key];
    if (!entry) {
      return { message: `${meta.name}: no default set. Run /repo-model to pick one.`, level: "info" };
    }
    return { message: `${meta.name} -> ${describeEntry(entry)}`, level: "info" };
  }

  if (action === "unset") {
    if (!config.repos?.[meta.key]) return { message: `${meta.name}: nothing to unset`, level: "info" };
    delete config.repos![meta.key];
    saveConfig(config);
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
    updatedAt: new Date().toISOString(),
  };
  config.repos ??= {};
  config.repos[meta.key] = entry;
  saveConfig(config);

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
  // Auto-apply the stored repo default when a session starts under a configured
  // repo. Only the configured triggers fire (default: fresh start + new session),
  // so resumed/forked/reloaded sessions keep whatever model they already have.
  pi.on("session_start", async (event, ctx) => {
    const config = loadConfig();
    const triggers = config.triggers ?? DEFAULT_TRIGGERS;
    if (!triggers.includes(event.reason)) return;

    const meta = getRepoMeta(ctx.cwd);
    const entry = config.repos?.[meta.key];
    if (!entry) return;

    const result = await applyEntry(pi, ctx, entry, meta, { silentIfNoChange: true });
    if (result.message) {
      ctx.ui.notify(`repo-model: ${result.message}`, result.level);
    }
  });

  pi.registerCommand("repo-model", {
    description: "Pick the repo default model + thinking level (dropdowns), or set via provider/model[:thinking]",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (trimmed) {
        notify(ctx, await runAction(pi, ctx, "set", trimmed));
        return;
      }
      if (ctx.hasUI) {
        notify(ctx, await interactiveSet(pi, ctx));
        return;
      }
      // No UI (print/json mode): just show the current setting.
      notify(ctx, await runAction(pi, ctx, "get"));
    },
  });

  pi.registerCommand("repo-model-unset", {
    description: "Remove the default model override for the current repo",
    handler: async (_args, ctx) => {
      notify(ctx, await runAction(pi, ctx, "unset"));
    },
  });

  pi.registerCommand("repo-model-list", {
    description: "List all configured repo default models",
    handler: async (_args, ctx) => {
      notify(ctx, await runAction(pi, ctx, "list"));
    },
  });
}
