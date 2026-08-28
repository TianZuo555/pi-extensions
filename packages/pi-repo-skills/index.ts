// pi-repo-skills — per-repository skill enable/disable for pi.
//
// Lets you turn individual skills on/off per repository. Disabled skills are
// stripped from the system prompt (so the model won't auto-load them), exactly
// like a skill with `disable-model-invocation: true`. Selections are persisted
// in a central, machine-local registry keyed by git root, so each repo
// remembers its own set without touching global settings or the repo's .pi/.

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  Skill,
} from "@earendil-works/pi-coding-agent";
import { formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { getRepoMeta, readJson, type RepoMeta } from "./lib/repo-registry.ts";
import {
  ALL,
  CONFIG_FILE,
  createRepoSkillsRuntime,
  type DisabledSkills,
  type RepoSkillsConfig,
  type RepoSkillsEntry,
  RepoSkillsRuntime,
  type RepoSkillsRuntimeInstance,
  runRepoSkills,
} from "./src/runtime.ts";

type ActionResult = { message: string; level: "info" | "warning" | "error" };

interface PickerTheme {
  fg(name: string, text: string): string;
  bold(text: string): string;
}
interface PickerKeybindings {
  matches(data: string, keybinding: string): boolean;
}

// --- skill helpers ----------------------------------------------------------

function loadedSkills(ctx: ExtensionCommandContext): Skill[] {
  return ctx.getSystemPromptOptions().skills ?? [];
}

function visibleSkills(skills: Skill[]): Skill[] {
  return skills.filter((s) => !s.disableModelInvocation);
}

function isDisabled(disabled: DisabledSkills | undefined, name: string): boolean {
  if (!disabled) return false;
  if (disabled === ALL) return true;
  return disabled.includes(name);
}

function normalizeDisabled(disabledNames: Set<string>, visibleSkillsList: Skill[]): DisabledSkills {
  if (visibleSkillsList.length > 0 && visibleSkillsList.every((s) => disabledNames.has(s.name))) {
    return ALL;
  }
  return [...disabledNames].sort();
}

function describeEntry(entry: RepoSkillsEntry | undefined): string {
  if (!entry) return "all skills enabled";
  if (entry.disabled === ALL) return "all skills disabled";
  if (!entry.disabled.length) return "all skills enabled";
  return `disabled: ${entry.disabled.join(", ")}`;
}

// --- checkbox picker --------------------------------------------------------

interface SkillToggleListArgs {
  repoName: string;
  skills: Skill[];
  initialDisabled: DisabledSkills | undefined;
  theme: PickerTheme;
  keybindings: PickerKeybindings;
  done: (result: DisabledSkills | undefined) => void;
}

class SkillToggleList extends Container {
  private readonly repoName: string;
  private readonly skills: Skill[];
  private readonly disabledNames: Set<string>;
  private readonly theme: PickerTheme;
  private readonly keybindings: PickerKeybindings;
  private readonly done: (result: DisabledSkills | undefined) => void;
  private selectedIndex = 0;

  constructor(args: SkillToggleListArgs) {
    super();
    this.repoName = args.repoName;
    this.skills = args.skills;
    this.theme = args.theme;
    this.keybindings = args.keybindings;
    this.done = args.done;

    if (args.initialDisabled === ALL) {
      this.disabledNames = new Set(this.skills.map((s) => s.name));
    } else {
      this.disabledNames = new Set(args.initialDisabled ?? []);
    }

    this.rebuildUI();
  }

  private isSkillDisabled(name: string): boolean {
    return this.disabledNames.has(name);
  }

  private toggle(index: number): void {
    const s = this.skills[index];
    if (!s) return;
    if (this.disabledNames.has(s.name)) {
      this.disabledNames.delete(s.name);
    } else {
      this.disabledNames.add(s.name);
    }
  }

  private toggleAll(): void {
    if (this.disabledNames.size === this.skills.length) {
      this.disabledNames.clear();
    } else {
      for (const s of this.skills) this.disabledNames.add(s.name);
    }
  }

  private rebuildUI(): void {
    const lines: string[] = [];
    const t = this.theme;

    lines.push(t.bold(t.fg("accent", `repo-skills · ${this.repoName}`)));
    lines.push(t.fg("muted", "Space toggle · 'a' all on/off · Enter save · Esc cancel"));
    lines.push("");

    const visibleRows = 12;
    const start = Math.max(
      0,
      Math.min(this.selectedIndex - Math.floor(visibleRows / 2), this.skills.length - visibleRows),
    );
    const end = Math.min(start + visibleRows, this.skills.length);

    for (let i = start; i < end; i++) {
      const s = this.skills[i]!;
      const selected = i === this.selectedIndex;
      const off = this.isSkillDisabled(s.name);
      const box = off ? t.fg("muted", "[ ]") : t.fg("accent", "[x]");
      const prefix = selected ? t.fg("accent", "❯ ") : "  ";
      const name = selected ? t.bold(s.name) : s.name;
      const desc = s.description ? t.fg("muted", ` — ${s.description}`) : "";
      lines.push(`${prefix}${box} ${name}${desc}`);
    }

    this.children = [new Text(lines.join("\n"), 0, 0), new Spacer(1)];
  }

  handleInput(data: string): boolean {
    if (this.keybindings.matches(data, "cancel") || data === "\x1b") {
      this.done(undefined);
      return true;
    }

    if (this.keybindings.matches(data, "up") || data === "\x1b[A") {
      this.selectedIndex = (this.selectedIndex - 1 + this.skills.length) % this.skills.length;
      this.rebuildUI();
      return true;
    }
    if (this.keybindings.matches(data, "down") || data === "\x1b[B") {
      this.selectedIndex = (this.selectedIndex + 1) % this.skills.length;
      this.rebuildUI();
      return true;
    }

    if (data === " " || data === "x" || data === "X") {
      this.toggle(this.selectedIndex);
      this.rebuildUI();
      return true;
    }
    if (data === "a" || data === "A") {
      this.toggleAll();
      this.rebuildUI();
      return true;
    }

    if (this.keybindings.matches(data, "select") || data === "\r" || data === "\n") {
      this.done(normalizeDisabled(this.disabledNames, this.skills));
      return true;
    }

    return false;
  }
}

async function commitDisabled(
  meta: RepoMeta,
  disabled: DisabledSkills,
  runtime: RepoSkillsRuntimeInstance,
): Promise<ActionResult> {
  const service = runtime.runSync(RepoSkillsRuntime);
  const updated = await runRepoSkills(runtime, service.setRepoSkills(meta.key, disabled));
  return {
    message: `${meta.name}: ${describeEntry(updated.repos?.[meta.key])}`,
    level: "info",
  };
}

async function interactiveToggle(
  ctx: ExtensionCommandContext,
  runtime: RepoSkillsRuntimeInstance,
): Promise<ActionResult> {
  const service = runtime.runSync(RepoSkillsRuntime);
  const meta = await runRepoSkills(runtime, service.getRepoMeta(ctx.cwd));
  const all = visibleSkills(loadedSkills(ctx));
  if (all.length === 0) {
    return { message: "No togglable skills are loaded.", level: "info" };
  }
  const sorted = [...all].sort((a, b) => a.name.localeCompare(b.name));
  const current = (await runRepoSkills(runtime, service.getRepoSkills(ctx.cwd)))?.disabled;

  const custom = (ctx.ui as { custom?: (...args: unknown[]) => unknown }).custom;
  if (typeof custom !== "function") {
    return { message: "Interactive toggle requires TUI mode.", level: "warning" };
  }

  const result = (await custom.call(
    ctx.ui,
    (
      _tui: unknown,
      theme: PickerTheme,
      keybindings: PickerKeybindings,
      done: (r: DisabledSkills | undefined) => void,
    ) =>
      new SkillToggleList({
        repoName: meta.name,
        skills: sorted,
        initialDisabled: current,
        theme,
        keybindings,
        done,
      }),
  )) as DisabledSkills | undefined;

  if (result === undefined) return { message: "cancelled", level: "info" };
  return commitDisabled(meta, result, runtime);
}

async function runAction(
  ctx: ExtensionCommandContext,
  action: "get" | "list" | "reset" | "disable-all" | "enable-all" | "disable" | "enable",
  runtime: RepoSkillsRuntimeInstance,
  skillName?: string,
): Promise<ActionResult> {
  const service = runtime.runSync(RepoSkillsRuntime);
  const meta = await runRepoSkills(runtime, service.getRepoMeta(ctx.cwd));
  const all = visibleSkills(loadedSkills(ctx));

  if (action === "list") {
    const entries = await runRepoSkills(runtime, service.listRepos);
    if (entries.length === 0) {
      return { message: "No repos configured. Run /skills to pick.", level: "info" };
    }
    const lines = entries.map((e) => {
      const mark = e.path === meta.key ? " (current)" : "";
      return `${e.name}  ->  ${describeEntry({ disabled: e.disabled })}${mark}`;
    });
    return { message: `repo-skills (${entries.length}):\n${lines.join("\n")}`, level: "info" };
  }

  if (action === "get") {
    const entry = await runRepoSkills(runtime, service.getRepoSkills(ctx.cwd));
    if (!entry) return { message: `${meta.name}: all skills enabled`, level: "info" };
    return { message: `${meta.name} -> ${describeEntry(entry)}`, level: "info" };
  }

  if (action === "reset") return commitDisabled(meta, [], runtime);
  if (action === "disable-all") return commitDisabled(meta, ALL, runtime);
  if (action === "enable-all") return commitDisabled(meta, [], runtime);

  if (!skillName?.trim()) {
    return { message: `Action "${action}" requires a skill name.`, level: "error" };
  }
  const target = skillName.trim();
  if (!all.some((s) => s.name === target)) {
    return { message: `Skill "${target}" is not a togglable loaded skill.`, level: "error" };
  }

  const current = (await runRepoSkills(runtime, service.getRepoSkills(ctx.cwd)))?.disabled;
  const disabledNames = new Set<string>(current === ALL ? all.map((s) => s.name) : (current ?? []));
  if (action === "disable") disabledNames.add(target);
  else disabledNames.delete(target);

  return commitDisabled(meta, normalizeDisabled(disabledNames, all), runtime);
}

function notify(ctx: ExtensionContext, result: ActionResult): void {
  if (result.message === "cancelled") {
    ctx.ui.notify("repo-skills: cancelled", "info");
    return;
  }
  ctx.ui.notify(
    result.message.startsWith("repo-skills") ? result.message : `repo-skills: ${result.message}`,
    result.level,
  );
}

// --- extension --------------------------------------------------------------

export default function repoSkillsExtension(pi: ExtensionAPI): void {
  const runtime = createRepoSkillsRuntime();
  const _service = runtime.runSync(RepoSkillsRuntime);

  pi.on("before_agent_start", (event, ctx) => {
    const all = event.systemPromptOptions.skills ?? [];
    if (all.length === 0) return;

    const config = readJson<RepoSkillsConfig>(CONFIG_FILE, { version: 1, repos: {} });
    const meta = getRepoMeta(ctx.cwd);
    const entry = config.repos?.[meta.key];
    if (!entry?.disabled || (entry.disabled !== ALL && entry.disabled.length === 0)) {
      return;
    }

    const oldBlock = formatSkillsForPrompt(all);
    if (!oldBlock) return;

    const enabled =
      entry.disabled === ALL ? [] : all.filter((s) => !isDisabled(entry.disabled, s.name));
    const newBlock = formatSkillsForPrompt(enabled);
    if (!event.systemPrompt.includes(oldBlock)) return;

    return { systemPrompt: event.systemPrompt.replace(oldBlock, newBlock) };
  });

  pi.on("session_shutdown", async () => {
    try {
      await runtime.dispose();
    } catch {
      // Disposed gracefully
    }
  });

  pi.registerCommand("skills", {
    description: "Enable/disable skills for the current repo (checkbox TUI)",
    handler: async (_args, ctx) => {
      if (ctx.hasUI) {
        notify(ctx, await interactiveToggle(ctx, runtime));
        return;
      }
      notify(ctx, await runAction(ctx, "get", runtime));
    },
  });

  pi.registerCommand("skills-list", {
    description: "List all repos with skill overrides",
    handler: async (_args, ctx) => {
      notify(ctx, await runAction(ctx, "list", runtime));
    },
  });

  pi.registerCommand("skills-reset", {
    description: "Clear the current repo's skill overrides (enable all)",
    handler: async (_args, ctx) => {
      notify(ctx, await runAction(ctx, "reset", runtime));
    },
  });
}
