/**
 * Skill passing for agy — Phase 2 of the pi-tool & skill bridge.
 *
 * agy's native skill expansion is disabled by our always-on
 * `--disable-slash-commands`, so pi skills reach agy two ways:
 *   - bridge mode: a compact catalog is appended to bootstrap prompts and a
 *     bridge-virtual `pi__activate_skill` tool returns the full SKILL.md;
 *   - direct mode (bridge off): the catalog lists absolute SKILL.md paths
 *     and headless agy reads them straight from disk (verified 2026-08-21).
 *
 * Catalogs stay name + one-liner only — oversized catalogs derail headless
 * turns the same way agy's built-in antigravity_guide skill does.
 */

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Minimal shape of pi's loaded skills (from systemPromptOptions.skills). */
export interface SkillLite {
  name: string;
  description: string;
  /** Absolute path to SKILL.md. */
  filePath: string;
  /** Absolute directory containing SKILL.md and bundled resources. */
  baseDir: string;
}

const MAX_DESCRIPTION = 120;
const MAX_RESOURCES = 20;

/**
 * MCP-safe bridge tool name for a skill (MCP tool names allow
 * [A-Za-z0-9_-]). Shared by the dynamic tool registration and the bootstrap
 * catalog so the advertised name always matches the listed one.
 */
export function skillToolName(skill: SkillLite): string {
  const safe = skill.name.replace(/[^A-Za-z0-9_-]/g, "_") || "unnamed";
  return `skill__${safe}`;
}

export interface AssignedSkillTool {
  skill: SkillLite;
  toolName: string;
}

/** Assign stable unique names even when two skill names sanitize identically. */
export function assignSkillToolNames(skills: SkillLite[]): AssignedSkillTool[] {
  const unique = skills.filter(
    (skill, index) =>
      skills.findIndex((candidate) => candidate.filePath === skill.filePath) === index,
  );
  const bases = unique.map((skill) => skillToolName(skill));
  const counts = new Map<string, number>();
  for (const base of bases) counts.set(base, (counts.get(base) ?? 0) + 1);
  return unique.map((skill, index) => {
    const base = bases[index];
    if ((counts.get(base) ?? 0) === 1) return { skill, toolName: base };
    const suffix = createHash("sha256").update(skill.filePath).digest("hex").slice(0, 8);
    return { skill, toolName: `${base}__${suffix}` };
  });
}

export type SkillCatalogMode = "bridge" | "direct";

/**
 * Skills agy cannot discover on its own.
 *
 * agy natively scans `<workspace>/.agents/skills/` (walking up from its cwd
 * to the repo root) and injects those skills' names/descriptions itself —
 * verified 2026-08-21, even under `--disable-slash-commands`. Injecting
 * those again would duplicate agy's own catalog, so the bootstrap catalog
 * only includes skills OUTSIDE the session workspace (pi-only globals like
 * `~/.pi/agent/skills` and `~/.agents/skills`, which agy never scans).
 */
export function nonWorkspaceSkills(
  skills: SkillLite[],
  sessionCwd: string | undefined,
): SkillLite[] {
  if (!sessionCwd) return skills;
  const resolvedCwd = path.resolve(sessionCwd);
  const cwdPrefix = resolvedCwd.endsWith(path.sep) ? resolvedCwd : resolvedCwd + path.sep;
  const home = path.resolve(os.homedir());
  return skills.filter((skill) => {
    const filePath = path.resolve(skill.filePath);
    if (filePath.startsWith(cwdPrefix)) return false;
    const marker = `${path.sep}.agents${path.sep}skills${path.sep}`;
    const markerIndex = filePath.indexOf(marker);
    if (markerIndex < 0) return true;
    const skillWorkspace = filePath.slice(0, markerIndex) || path.parse(filePath).root;
    if (path.resolve(skillWorkspace) === home) return true; // ~/.agents/skills is global.
    return !(
      resolvedCwd === path.resolve(skillWorkspace) ||
      resolvedCwd.startsWith(`${path.resolve(skillWorkspace)}${path.sep}`)
    );
  });
}

/**
 * Format the bootstrap-prompt catalog block. Returns undefined when there
 * are no model-invocable skills, so nothing is injected. `toolPrefix` is the
 * session's bridge prefix (see AgyPiBridge) so advertised names match the
 * tools/list entries exactly.
 */
export function formatSkillCatalog(
  skills: SkillLite[],
  mode: SkillCatalogMode,
  toolPrefix = "pi__",
): string | undefined {
  const usable = skills.filter((skill) => skill.filePath);
  if (usable.length === 0) return undefined;
  const assignments = assignSkillToolNames(usable);
  const lines = assignments.map(({ skill, toolName }) => {
    const description =
      skill.description.replace(/\s+/g, " ").trim().slice(0, MAX_DESCRIPTION) || "(no description)";
    const location =
      mode === "bridge" ? `${skill.filePath}; tool: ${toolPrefix}${toolName}` : skill.filePath;
    return `- ${skill.name}: ${description} (${location})`;
  });
  const how =
    mode === "bridge"
      ? "Call the exact bridge tool shown on each skill entry to activate it."
      : "To activate a skill, read its SKILL.md file directly.";
  return [
    "## pi Agent Skills",
    "",
    "The following pi Agent Skills are available in this session:",
    ...lines,
    "",
    how,
    "Activate a skill BEFORE attempting its workflow; follow the activated instructions.",
  ].join("\n");
}

/**
 * Load a skill bundle for agy: the full SKILL.md plus the absolute paths of
 * bundled resources (relative references in SKILL.md are useless to agy —
 * they resolve against the skill directory, not the agy workspace).
 */
export async function readSkillBundle(skill: SkillLite): Promise<{
  content: string;
  isError: boolean;
}> {
  let body: string;
  try {
    body = await readFile(skill.filePath, "utf-8");
  } catch (error) {
    return {
      content: `antigravity: failed to read skill "${skill.name}" (${error instanceof Error ? error.message : error}).`,
      isError: true,
    };
  }
  const resources: string[] = [];
  try {
    const entries = await readdir(skill.baseDir, { withFileTypes: true });
    for (const entry of entries) {
      if (resources.length >= MAX_RESOURCES) {
        resources.push(`… (+${entries.length - MAX_RESOURCES} more entries)`);
        break;
      }
      if (entry.name === "SKILL.md") continue;
      resources.push(path.join(skill.baseDir, entry.name) + (entry.isDirectory() ? "/" : ""));
    }
  } catch {
    // Resource listing is best-effort; the SKILL.md body is the payload.
  }

  const parts = [body.trim()];
  if (resources.length > 0) {
    parts.push(
      "---",
      "Bundled resources (absolute paths):",
      ...resources.map((resource) => `- ${resource}`),
    );
  }
  return { content: parts.join("\n\n"), isError: false };
}
