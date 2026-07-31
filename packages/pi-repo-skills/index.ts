// pi-repo-skills — per-repository skill enable/disable for pi.
//
// Lets you turn individual skills on/off per repository. Disabled skills are
// stripped from the system prompt (so the model won't auto-load them), exactly
// like a skill with `disable-model-invocation: true`. Selections are persisted
// in a central, machine-local registry keyed by git root, so each repo
// remembers its own set without touching global settings or the repo's .pi/.
//
// Mirrors the per-repo persistence design of pi-repo-model.ts.
//
// Commands (interactive):
//   /skills            open a checkbox TUI to toggle skills for this repo
//   /skills-list       list every configured repo and its disabled skills
//   /skills-reset      clear this repo's overrides (all skills enabled)
//
// Config lives at ~/.pi/repo-skills/config.json (machine-local, never synced):
//   {
//     "version": 1,
//     "repos": {
//       "/abs/path/to/repo": {
//         "name": "repo",
//         "disabled": ["jira-cli", "playwriter"],   // or the sentinel "ALL"
//         "updatedAt": "..."
//       }
//     }
//   }
//
// `disabled` is either an array of skill names or the literal "ALL" (every
// skill off, future-proof against newly installed skills). A missing entry or
// empty array means every skill is enabled.

import path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, Skill } from "@earendil-works/pi-coding-agent";
import { formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { getRepoMeta, piConfigDir, readJson, type RepoMeta, writeJson } from "./lib/repo-registry";

const CONFIG_FILE = path.join(piConfigDir("repo-skills"), "config.json");

const ALL = "ALL" as const;
type DisabledSkills = string[] | typeof ALL;

interface RepoSkillsEntry {
  name?: string;
  disabled: DisabledSkills;
  updatedAt?: string;
}

interface RepoSkillsConfig {
  version: number;
  repos?: Record<string, RepoSkillsEntry>;
}

type ActionResult = { message: string; level: "info" | "warning" | "error" };

// Loose structural types for the theme + keybindings passed to custom().
interface PickerTheme {
  fg(name: string, text: string): string;
  bold(text: string): string;
}
interface PickerKeybindings {
  matches(data: string, keybinding: string): boolean;
}

// --- config persistence -----------------------------------------------------

function loadConfig(): RepoSkillsConfig {
  const data = readJson<RepoSkillsConfig>(CONFIG_FILE, { version: 1, repos: {} });
  return { version: 1, repos: data.repos ?? {} };
}

function saveConfig(config: RepoSkillsConfig): void {
  try {
    writeJson(CONFIG_FILE, config);
  } catch (error) {
    console.warn("[pi-repo-skills] Failed to write config:", error);
  }
}

// --- skill helpers ----------------------------------------------------------

function loadedSkills(ctx: ExtensionCommandContext): Skill[] {
  return ctx.getSystemPromptOptions().skills ?? [];
}

// Only skills the model can auto-invoke are togglable. `disable-model-invocation`
// skills are already hidden from the prompt, so toggling them is meaningless.
function visibleSkills(skills: Skill[]): Skill[] {
  return skills.filter((s) => !s.disableModelInvocation);
}

function isDisabled(disabled: DisabledSkills | undefined, name: string): boolean {
  if (!disabled) return false;
  if (disabled === ALL) return true;
  return disabled.includes(name);
}

// Normalize a raw disabled selection against the current skill set:
//   every visible skill disabled -> "ALL"
//   none disabled                -> []  (caller may drop the entry)
//   otherwise                    -> sorted array of names
function normalizeDisabled(disabledNames: Set<string>, visible: Skill[]): DisabledSkills {
  if (visible.length > 0 && visible.every((s) => disabledNames.has(s.name))) return ALL;
  return [...disabledNames].sort();
}

function describeEntry(entry: RepoSkillsEntry): string {
  if (entry.disabled === ALL) return "all skills disabled";
  if (entry.disabled.length === 0) return "all skills enabled";
  return `disabled: ${entry.disabled.join(", ")}`;
}

// --- interactive checkbox toggle (single custom component) ------------------

interface ToggleArgs {
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
  private readonly theme: PickerTheme;
  private readonly keybindings: PickerKeybindings;
  private readonly done: (result: DisabledSkills | undefined) => void;

  private readonly enabled: boolean[]; // enabled[i] for skills[i]
  private cursor = 0;

  private readonly titleText: Text;
  private readonly footerText: Text;
  private readonly listContainer: Container;

  constructor(args: ToggleArgs) {
    super();
    this.repoName = args.repoName;
    this.skills = args.skills;
    this.theme = args.theme;
    this.keybindings = args.keybindings;
    this.done = args.done;
    this.enabled = this.skills.map((s) => !isDisabled(args.initialDisabled, s.name));

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
    const on = this.enabled.filter(Boolean).length;
    const title = `repo-skills · ${this.repoName} · ${on}/${this.skills.length} enabled`;
    return this.theme.fg("accent", this.theme.bold(title));
  }

  private footerLine(): string {
    return this.theme.fg("dim", "↑↓ move · space toggle · a disable all · n enable all · enter save · esc cancel");
  }

  private updateList(): void {
    this.listContainer.clear();
    for (let i = 0; i < this.skills.length; i++) {
      const cursored = i === this.cursor;
      const box = this.enabled[i] ? "[x]" : "[ ]";
      const name = this.skills[i].name;
      const arrow = cursored ? "→ " : "  ";
      const body = `${arrow}${box} ${name}`;
      let line: string;
      if (cursored) line = this.theme.fg("accent", body);
      else if (this.enabled[i]) line = this.theme.fg("text", body);
      else line = this.theme.fg("dim", body);
      this.listContainer.addChild(new Text(line, 1, 0));
    }
    this.titleText.setText(this.titleLine());
  }

  handleInput(keyData: string): void {
    const kb = this.keybindings;
    if (kb.matches(keyData, "tui.select.up") || keyData === "k") {
      this.move(-1);
    } else if (kb.matches(keyData, "tui.select.down") || keyData === "j") {
      this.move(1);
    } else if (keyData === " ") {
      this.toggle();
    } else if (keyData === "a") {
      this.setAll(false);
    } else if (keyData === "n") {
      this.setAll(true);
    } else if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n" || keyData === "\r") {
      this.save();
    } else if (kb.matches(keyData, "tui.select.cancel") || keyData === "\u001b") {
      this.done(undefined);
    }
  }

  private move(delta: number): void {
    const n = this.skills.length;
    if (n === 0) return;
    this.cursor = (this.cursor + delta + n) % n;
    this.updateList();
  }

  private toggle(): void {
    if (this.skills.length === 0) return;
    this.enabled[this.cursor] = !this.enabled[this.cursor];
    this.updateList();
  }

  private setAll(value: boolean): void {
    for (let i = 0; i < this.enabled.length; i++) this.enabled[i] = value;
    this.updateList();
  }

  private save(): void {
    const disabledNames = new Set<string>();
    for (let i = 0; i < this.skills.length; i++) {
      if (!this.enabled[i]) disabledNames.add(this.skills[i].name);
    }
    this.done(normalizeDisabled(disabledNames, this.skills));
  }
}

// --- persistence of a selection ---------------------------------------------

function commitDisabled(meta: RepoMeta, disabled: DisabledSkills): ActionResult {
  const config = loadConfig();
  config.repos ??= {};

  if (disabled !== ALL && disabled.length === 0) {
    // Clean slate: drop the entry entirely.
    if (config.repos[meta.key]) {
      delete config.repos[meta.key];
      saveConfig(config);
    }
    return { message: `${meta.name}: all skills enabled`, level: "info" };
  }

  config.repos[meta.key] = { name: meta.name, disabled, updatedAt: new Date().toISOString() };
  saveConfig(config);
  return { message: `${meta.name}: ${describeEntry(config.repos[meta.key])}`, level: "info" };
}

// --- interactive entrypoint -------------------------------------------------

async function interactiveToggle(ctx: ExtensionCommandContext): Promise<ActionResult> {
  const meta = getRepoMeta(ctx.cwd);
  const all = visibleSkills(loadedSkills(ctx));
  if (all.length === 0) {
    return { message: "No togglable skills are loaded.", level: "info" };
  }
  const sorted = [...all].sort((a, b) => a.name.localeCompare(b.name));
  const current = loadConfig().repos?.[meta.key]?.disabled;

  const custom = (ctx.ui as { custom?: Function }).custom;
  if (typeof custom !== "function") {
    return { message: "Interactive toggle requires TUI mode.", level: "warning" };
  }

  const result = (await custom.call(
    ctx.ui,
    (_tui: unknown, theme: PickerTheme, keybindings: PickerKeybindings, done: (r: DisabledSkills | undefined) => void) =>
      new SkillToggleList({ repoName: meta.name, skills: sorted, initialDisabled: current, theme, keybindings, done }),
  )) as DisabledSkills | undefined;

  if (result === undefined) return { message: "cancelled", level: "info" };
  return commitDisabled(meta, result);
}

// --- text-form actions (shared with the tool) -------------------------------

async function runAction(
  ctx: ExtensionCommandContext,
  action: "get" | "list" | "reset" | "disable-all" | "enable-all" | "disable" | "enable",
  skillName?: string,
): Promise<ActionResult> {
  const config = loadConfig();
  const meta = getRepoMeta(ctx.cwd);
  const all = visibleSkills(loadedSkills(ctx));

  if (action === "list") {
    const entries = Object.entries(config.repos ?? {});
    if (entries.length === 0) return { message: "No repos configured. Run /skills to pick.", level: "info" };
    const lines = entries.map(([key, e]) => {
      const mark = key === meta.key ? " (current)" : "";
      return `${e.name ?? path.basename(key)}  ->  ${describeEntry(e)}${mark}`;
    });
    return { message: `repo-skills (${entries.length}):\n${lines.join("\n")}`, level: "info" };
  }

  if (action === "get") {
    const entry = config.repos?.[meta.key];
    if (!entry) return { message: `${meta.name}: all skills enabled`, level: "info" };
    return { message: `${meta.name} -> ${describeEntry(entry)}`, level: "info" };
  }

  if (action === "reset") return commitDisabled(meta, []);
  if (action === "disable-all") return commitDisabled(meta, ALL);
  if (action === "enable-all") return commitDisabled(meta, []);

  // disable / enable a single skill
  if (!skillName?.trim()) {
    return { message: `Action "${action}" requires a skill name.`, level: "error" };
  }
  const target = skillName.trim();
  if (!all.some((s) => s.name === target)) {
    return { message: `Skill "${target}" is not a togglable loaded skill.`, level: "error" };
  }

  // Expand current selection into a concrete disabled set, then mutate.
  const current = config.repos?.[meta.key]?.disabled;
  const disabledNames = new Set<string>(
    current === ALL ? all.map((s) => s.name) : (current ?? []),
  );
  if (action === "disable") disabledNames.add(target);
  else disabledNames.delete(target);

  return commitDisabled(meta, normalizeDisabled(disabledNames, all));
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
  // Strip this repo's disabled skills from the system prompt on every agent run.
  // Fires before the first turn of a new session too, so persisted selections
  // apply immediately.
  pi.on("before_agent_start", (event, ctx) => {
    const all = event.systemPromptOptions.skills ?? [];
    if (all.length === 0) return;

    const disabled = loadConfig().repos?.[getRepoMeta(ctx.cwd).key]?.disabled;
    if (!disabled || (disabled !== ALL && disabled.length === 0)) return;

    const oldBlock = formatSkillsForPrompt(all);
    if (!oldBlock) return; // nothing model-invocable in the prompt anyway

    const enabled = disabled === ALL ? [] : all.filter((s) => !disabled.includes(s.name));
    const newBlock = formatSkillsForPrompt(enabled);
    if (!event.systemPrompt.includes(oldBlock)) return;

    return { systemPrompt: event.systemPrompt.replace(oldBlock, newBlock) };
  });

  pi.registerCommand("skills", {
    description: "Enable/disable skills for the current repo (checkbox TUI)",
    handler: async (_args, ctx) => {
      if (ctx.hasUI) {
        notify(ctx, await interactiveToggle(ctx));
        return;
      }
      notify(ctx, await runAction(ctx, "get"));
    },
  });

  pi.registerCommand("skills-list", {
    description: "List all repos with skill overrides",
    handler: async (_args, ctx) => {
      notify(ctx, await runAction(ctx, "list"));
    },
  });

  pi.registerCommand("skills-reset", {
    description: "Clear the current repo's skill overrides (enable all)",
    handler: async (_args, ctx) => {
      notify(ctx, await runAction(ctx, "reset"));
    },
  });
}
