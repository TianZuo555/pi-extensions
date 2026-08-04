import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Model } from "@earendil-works/pi-ai";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import {
  ALL_ALLOWED_TOOLS,
  BUILTIN_PROFILE_NAMES,
  DEFAULT_MAX_TURNS,
  DEFAULT_RUN_TIMEOUT_MS,
  MAX_PROFILE_TURNS,
  MUTATING_TOOLS,
  READ_ONLY_TOOLS,
  type ProfileDefinition,
  type ProfileSource,
  type WorkspacePolicy,
} from "./domain.ts";
import { createProfileDiagnosticBuffer, type ProfileDiagnosticCollector } from "./profile-diagnostics.ts";
import {
  loadSubagentsSettings,
  mergeProfileOverride,
  settingsPaths,
  type ProfileOverride,
  type SubagentsSettings,
} from "./settings.ts";
import { profileContentHash } from "./trust.ts";

const PACKAGE_ROOT = path.dirname(fileURLToPath(import.meta.url));

function parseTools(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return parseTools(raw.map(String).join(","));
  }
  const text = typeof raw === "string" ? raw : String(raw ?? "");
  if (!text.trim()) return [...READ_ONLY_TOOLS];
  const parts = text
    .split(/[,\s]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  if (parts.includes("*")) return [...ALL_ALLOWED_TOOLS];
  return parts;
}

function hasMutatingTool(tools: string[]): boolean {
  return tools.some((t) => MUTATING_TOOLS.includes(t as typeof MUTATING_TOOLS[number]));
}

function resolveWorkspace(raw: unknown, tools: string[]): WorkspacePolicy {
  const explicit = String(raw ?? "").trim();
  if (explicit === "shared-readonly" || explicit === "shared-write" || explicit === "worktree") {
    return explicit;
  }
  if (hasMutatingTool(tools)) return "shared-write";
  return "shared-readonly";
}

function validateTools(name: string, tools: string[], workspace: WorkspacePolicy): void {
  for (const tool of tools) {
    if (!ALL_ALLOWED_TOOLS.includes(tool as typeof ALL_ALLOWED_TOOLS[number])) {
      throw new Error(`Profile "${name}" tool "${tool}" is not allowed`);
    }
  }
  if (workspace === "worktree" && !hasMutatingTool(tools)) {
    throw new Error(`Profile "${name}" worktree workspace requires at least one mutating tool`);
  }
}

function resolveMaxTurns(
  name: string,
  frontmatter: Record<string, unknown>,
  override: ProfileOverride | undefined,
  settings: SubagentsSettings,
): number {
  const raw = override?.maxTurns ?? frontmatter.maxTurns ?? settings.defaultMaxTurns ?? DEFAULT_MAX_TURNS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_PROFILE_TURNS) {
    throw new Error(
      `Profile "${name}" maxTurns must be an integer from 1 to ${MAX_PROFILE_TURNS}`,
    );
  }
  return value;
}

function loadProfileFromFile(
  filePath: string,
  source: ProfileSource,
  settings: SubagentsSettings,
): ProfileDefinition | undefined {
  const raw = fs.readFileSync(filePath, "utf8");
  const { frontmatter, body } = parseFrontmatter(raw);
  const name = String(frontmatter.name ?? path.basename(filePath, ".md")).trim();
  if (!name) return undefined;

  const tools = parseTools(frontmatter.tools);
  const workspace = resolveWorkspace(frontmatter.workspace, tools);
  validateTools(name, tools, workspace);

  const timeoutSeconds = Number(frontmatter.timeoutSeconds ?? 0);
  const override = mergeProfileOverride(name, `${source}/${name}`, settings);
  const timeoutMs =
    override?.timeoutSeconds !== undefined
      ? override.timeoutSeconds * 1000
      : timeoutSeconds > 0
        ? timeoutSeconds * 1000
        : settings.defaultTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;

  const thinkingRaw = override?.thinking ?? frontmatter.thinking ?? frontmatter.thinkingLevel;
  const thinkingRef = thinkingRaw !== undefined ? String(thinkingRaw).trim() : "";

  const modelRef = override?.model ?? (frontmatter.model as string | undefined)?.trim();
  const maxTurns = resolveMaxTurns(name, frontmatter, override, settings);

  return {
    qualifiedId: `${source}/${name}`,
    name,
    source,
    description: String(frontmatter.description ?? "").trim(),
    tools,
    modelRef: modelRef || undefined,
    systemPrompt: body.trim(),
    workspace,
    timeoutMs,
    thinkingRef: thinkingRef || undefined,
    filePath,
    contentHash: profileContentHash(raw),
    maxTurns,
  };
}

function loadDirProfiles(
  dir: string,
  source: ProfileSource,
  settings: SubagentsSettings,
  onDiagnostic?: ProfileDiagnosticCollector,
): ProfileDefinition[] {
  if (!fs.existsSync(dir)) return [];
  const out: ProfileDefinition[] = [];
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith(".md")) continue;
    const filePath = path.join(dir, entry);
    try {
      const profile = loadProfileFromFile(filePath, source, settings);
      if (profile) out.push(profile);
    } catch (error) {
      const message = `skipped ${filePath}: ${error instanceof Error ? error.message : error}`;
      onDiagnostic?.(message);
    }
  }
  return out;
}

export class ProfileCatalog {
  private profiles = new Map<string, ProfileDefinition>();
  private byShortName = new Map<string, ProfileDefinition[]>();
  private readonly cwd: string;
  private readonly agentDir: string;
  private readonly diagnostics = createProfileDiagnosticBuffer();
  private settings: SubagentsSettings = {};

  constructor(cwd: string, agentDir?: string) {
    this.cwd = cwd;
    this.agentDir = agentDir ?? getAgentDir();
    this.reload();
  }

  getAgentDir(): string {
    return this.agentDir;
  }

  getSettings(): SubagentsSettings {
    return this.settings;
  }

  getLoadDiagnostics(): readonly string[] {
    return this.diagnostics.list();
  }

  reload(): void {
    this.diagnostics.clear();
    this.settings = loadSubagentsSettings(settingsPaths(this.agentDir, this.cwd));
    const builtinsDir = path.join(PACKAGE_ROOT, "..", "profiles");
    const loaded: ProfileDefinition[] = [];
    const onDiagnostic = (message: string) => this.diagnostics.push(message);

    for (const name of BUILTIN_PROFILE_NAMES) {
      const filePath = path.join(builtinsDir, `${name}.md`);
      if (!fs.existsSync(filePath)) continue;
      try {
        const profile = loadProfileFromFile(filePath, "builtin", this.settings);
        if (profile) loaded.push(profile);
      } catch (error) {
        onDiagnostic(
          `skipped builtin ${name}: ${error instanceof Error ? error.message : error}`,
        );
      }
    }

    loaded.push(
      ...loadDirProfiles(path.join(this.agentDir, "agents"), "user", this.settings, onDiagnostic),
    );
    loaded.push(
      ...loadDirProfiles(path.join(this.cwd, ".pi", "agents"), "project", this.settings, onDiagnostic),
    );

    this.profiles.clear();
    this.byShortName.clear();
    for (const profile of loaded) {
      this.profiles.set(profile.qualifiedId, profile);
      const list = this.byShortName.get(profile.name) ?? [];
      list.push(profile);
      this.byShortName.set(profile.name, list);
    }
  }

  resolve(ref: string): ProfileDefinition {
    const trimmed = ref.trim();
    if (this.profiles.has(trimmed)) {
      return this.profiles.get(trimmed)!;
    }
    const matches = this.byShortName.get(trimmed);
    if (!matches?.length) {
      throw new Error(
        `Unknown profile "${trimmed}". Available: ${this.listQualifiedIds().join(", ")}`,
      );
    }
    if (matches.length > 1) {
      throw new Error(
        `Ambiguous profile "${trimmed}". Use a qualified id: ${matches.map((p) => p.qualifiedId).join(", ")}`,
      );
    }
    return matches[0];
  }

  list(): ProfileDefinition[] {
    return [...this.profiles.values()].sort((a, b) => a.qualifiedId.localeCompare(b.qualifiedId));
  }

  listQualifiedIds(): string[] {
    return this.list().map((p) => p.qualifiedId);
  }

  listShortNames(): string[] {
    return [...this.byShortName.keys()].sort();
  }
}

export function formatModelArg(model: Model<any>): string {
  return `${model.provider}/${model.id}`;
}

export function resolveProfileModelArg(
  profile: ProfileDefinition,
  parentModel: Model<any> | undefined,
): string {
  let base: string;
  if (profile.modelRef && profile.modelRef !== "inherit") {
    base = profile.modelRef;
  } else if (parentModel) {
    base = formatModelArg(parentModel);
  } else {
    throw new Error(
      `Profile "${profile.qualifiedId}" has no model and parent session has no active model`,
    );
  }

  const thinking = profile.thinkingRef?.trim();
  if (thinking && !base.includes(":")) {
    return `${base}:${thinking}`;
  }
  return base;
}
