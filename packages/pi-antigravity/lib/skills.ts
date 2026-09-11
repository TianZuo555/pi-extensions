/**
 * Skill passing for agy — Phase 2 of the pi-tool & skill bridge.
 *
 * agy's native skill expansion is disabled by our always-on
 * `--disable-slash-commands`, so pi-private skills reach agy through one
 * `activate_skill` MCP tool (session-prefixed) whose JSON-schema enum is the
 * catalog and whose description carries each skill's one-liner — pi's
 * progressive disclosure, so agy can tell when a skill applies. Calling it
 * returns the full SKILL.md. Nothing is appended to the user prompt:
 * tools/list is refreshed on every agy spawn, including after pi compaction.
 *
 * When the bridge is off or fails to register, the catalog is NOT injected
 * into the prompt — shared/agy-native skills still reach agy on their own,
 * and the user is warned once that pi-private skills are unavailable.
 *
 * Catalogs stay name + one-liner only — oversized catalogs derail headless
 * turns the same way agy's built-in antigravity_guide skill does.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

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

function isUnderDir(filePath: string, dir: string): boolean {
  const root = dir.endsWith(path.sep) ? dir : dir + path.sep;
  return filePath.startsWith(root);
}

/**
 * Skills only pi can provide — paths under pi's actual roots, not just any
 * directory segment that happens to be named like a config tree:
 *
 * - `getAgentDir()` (`~/.pi/agent`, or `PI_CODING_AGENT_DIR` when
 *   customized): global pi skills and pi-package installs.
 * - `<session cwd>/<CONFIG_DIR_NAME>` (`<project>/.pi`): project-private pi
 *   skills.
 *
 * Shared `.agents/skills` roots (user-global and project walk-up) are the
 * agents format — agy scans the workspace ones itself and the global ones
 * belong to other agents; never bridged. The exclusion targets the actual
 * `<dir>/.agents/skills/` root boundary, not any ancestor named `.agents` —
 * a pi agent dir or a workspace nested under some `.agents` directory keeps
 * its own private skills. Anything else outside those two roots is excluded
 * too: sitting outside the workspace does not make a skill pi-private.
 */
export function piPrivateSkills(skills: SkillLite[], sessionCwd: string | undefined): SkillLite[] {
  const roots = [path.resolve(getAgentDir())];
  if (sessionCwd) roots.push(path.resolve(sessionCwd, CONFIG_DIR_NAME));
  return skills.filter((skill) => {
    const filePath = path.resolve(skill.filePath);
    const segments = filePath.split(path.sep);
    const underSharedSkillsRoot = segments.some(
      (segment, index) => segment === ".agents" && segments[index + 1] === "skills",
    );
    if (underSharedSkillsRoot) return false;
    return roots.some((root) => isUnderDir(filePath, root));
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
