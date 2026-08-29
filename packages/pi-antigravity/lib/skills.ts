/**
 * Skill passing for agy — Phase 2 of the pi-tool & skill bridge.
 *
 * agy's native skill expansion is disabled by our always-on
 * `--disable-slash-commands`, so pi skills reach agy two ways:
 *   - bridge mode: one `activate_skill` MCP tool (session-prefixed) whose
 *     JSON-schema enum is the catalog and whose description carries each
 *     skill's one-liner — pi's progressive disclosure, so agy can tell when a
 *     skill applies. Calling it returns the full SKILL.md. Nothing is appended
 *     to the user prompt: tools/list is refreshed on every agy spawn,
 *     including after pi compaction.
 *   - direct mode (bridge off, or a bridge that failed to register): a compact
 *     catalog of absolute SKILL.md paths is appended on the first turn of a
 *     fresh agy conversation, and headless agy reads them straight from disk
 *     (verified 2026-08-21).
 *
 * Catalogs stay name + one-liner only — oversized catalogs derail headless
 * turns the same way agy's built-in antigravity_guide skill does.
 */

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

/** MCP tool name (without the session `pi__p<pid>__` prefix). */
export const ACTIVATE_SKILL_TOOL_NAME = "activate_skill";

const MAX_DESCRIPTION = 120;
const MAX_RESOURCES = 20;

/**
 * Skills agy cannot discover on its own.
 *
 * agy natively scans `<workspace>/.agents/skills/` (walking up from its cwd
 * to the repo root) and injects those skills' names/descriptions itself —
 * verified 2026-08-21, even under `--disable-slash-commands`. Injecting
 * those again would duplicate agy's own catalog, so the bridged catalog
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

/** Unique skills with a file path; first name wins (same as pi collisions). */
export function usableSkillCatalog(skills: SkillLite[]): SkillLite[] {
  const seen = new Set<string>();
  const out: SkillLite[] = [];
  for (const skill of skills) {
    if (!skill.filePath || seen.has(skill.name)) continue;
    seen.add(skill.name);
    out.push(skill);
  }
  return out;
}

export function findSkillByName(skills: SkillLite[], name: string): SkillLite | undefined {
  const trimmed = name.trim();
  return usableSkillCatalog(skills).find((skill) => skill.name === trimmed);
}

/** JSON schema for the single `activate_skill` tool. The enum is the catalog. */
export function activateSkillParameters(skills: SkillLite[]): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Skill name to activate (from this tool's enum).",
        enum: usableSkillCatalog(skills).map((skill) => skill.name),
      },
    },
    required: ["name"],
  };
}

export function activateSkillDescription(skills: SkillLite[]): string {
  const usable = usableSkillCatalog(skills);
  const lines = usable.map((skill) => {
    const description =
      skill.description.replace(/\s+/g, " ").trim().slice(0, MAX_DESCRIPTION) || "(no description)";
    return `- ${skill.name}: ${description}`;
  });
  return [
    "Load a pi Agent Skill by name: returns its full SKILL.md and bundled resource paths. " +
      "Call before following that skill's workflow. Pass `name` from this tool's enum.",
    ...(lines.length > 0 ? ["", "Available skills:", ...lines] : []),
  ].join("\n");
}

export async function handleActivateSkill(
  skills: SkillLite[],
  args: Record<string, unknown>,
): Promise<{ content: string; isError: boolean }> {
  const raw = args.name;
  const name = typeof raw === "string" ? raw.trim() : "";
  const available = usableSkillCatalog(skills)
    .map((skill) => skill.name)
    .join(", ");
  if (!name) {
    return {
      content: `antigravity: no skill name was provided. Available: ${available || "none"}.`,
      isError: true,
    };
  }
  const skill = findSkillByName(skills, name);
  if (!skill) {
    return {
      content: `antigravity: skill "${name}" is not available. Available: ${available || "none"}.`,
      isError: true,
    };
  }
  return readSkillBundle(skill);
}

/**
 * Direct-mode bootstrap catalog (bridge off or unavailable). Returns undefined
 * when there are no model-invocable skills, so nothing is injected.
 */
export function formatSkillCatalog(skills: SkillLite[]): string | undefined {
  const usable = usableSkillCatalog(skills);
  if (usable.length === 0) return undefined;
  const lines = usable.map((skill) => {
    const description =
      skill.description.replace(/\s+/g, " ").trim().slice(0, MAX_DESCRIPTION) || "(no description)";
    return `- ${skill.name}: ${description} (${skill.filePath})`;
  });
  return [
    "## pi Agent Skills",
    "",
    "The following pi Agent Skills are available in this session:",
    ...lines,
    "",
    "To activate a skill, read its SKILL.md file directly.",
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
