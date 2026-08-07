import { readFile } from "node:fs/promises";
import path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export const DEFAULT_COMMIT_MODEL = "deepseek/deepseek-v4-flash";
export const COMMIT_SETTINGS_KEY = "piCommit";
export const COMMIT_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type CommitThinkingLevel = (typeof COMMIT_THINKING_LEVELS)[number];

export interface ModelReference {
  provider: string;
  id: string;
  value: string;
}

export interface CommitSettingsResolution {
  model: ModelReference;
  fallbackModel?: ModelReference;
  thinkingLevel?: CommitThinkingLevel;
  fallbackThinkingLevel?: CommitThinkingLevel;
  warnings: string[];
}

interface SettingsReadResult {
  value: unknown;
  warning?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseModelReference(raw: string): ModelReference {
  const value = raw.trim();
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) {
    throw new Error(`Model must use provider/model format (received ${JSON.stringify(raw)})`);
  }

  const provider = value.slice(0, slash).trim();
  const id = value.slice(slash + 1).trim();
  if (!provider || !id) {
    throw new Error(`Model must use provider/model format (received ${JSON.stringify(raw)})`);
  }

  return { provider, id, value: `${provider}/${id}` };
}

interface ConfiguredCommitSettings {
  model?: ModelReference;
  fallbackModel?: ModelReference;
  thinkingLevel?: CommitThinkingLevel;
  fallbackThinkingLevel?: CommitThinkingLevel;
}

function configuredSettings(
  settings: unknown,
  source: string,
  warnings: string[],
): ConfiguredCommitSettings {
  if (!isRecord(settings)) {
    if (settings !== undefined) warnings.push(`${source} settings must contain a JSON object`);
    return {};
  }

  const section = settings[COMMIT_SETTINGS_KEY];
  if (section === undefined) return {};
  if (!isRecord(section)) {
    warnings.push(`${source} ${COMMIT_SETTINGS_KEY} setting must be an object`);
    return {};
  }

  const configured: ConfiguredCommitSettings = {};
  const model = section.model;
  if (model !== undefined) {
    if (typeof model !== "string" || model.trim().length === 0) {
      warnings.push(`${source} ${COMMIT_SETTINGS_KEY}.model must be a non-empty provider/model string`);
    } else {
      try {
        configured.model = parseModelReference(model);
      } catch (error) {
        warnings.push(
          `${source} ${COMMIT_SETTINGS_KEY}.model: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  const fallbackModel = section.fallbackModel;
  if (fallbackModel !== undefined) {
    if (typeof fallbackModel !== "string" || fallbackModel.trim().length === 0) {
      warnings.push(
        `${source} ${COMMIT_SETTINGS_KEY}.fallbackModel must be a non-empty provider/model string`,
      );
    } else {
      try {
        configured.fallbackModel = parseModelReference(fallbackModel);
      } catch (error) {
        warnings.push(
          `${source} ${COMMIT_SETTINGS_KEY}.fallbackModel: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  const thinkingLevel = section.thinkingLevel;
  if (thinkingLevel !== undefined) {
    if (
      typeof thinkingLevel !== "string" ||
      !COMMIT_THINKING_LEVELS.includes(thinkingLevel as CommitThinkingLevel)
    ) {
      warnings.push(
        `${source} ${COMMIT_SETTINGS_KEY}.thinkingLevel must be one of ${COMMIT_THINKING_LEVELS.join(", ")}`,
      );
    } else {
      configured.thinkingLevel = thinkingLevel as CommitThinkingLevel;
    }
  }

  const fallbackThinkingLevel = section.fallbackThinkingLevel;
  if (fallbackThinkingLevel !== undefined) {
    if (
      typeof fallbackThinkingLevel !== "string" ||
      !COMMIT_THINKING_LEVELS.includes(fallbackThinkingLevel as CommitThinkingLevel)
    ) {
      warnings.push(
        `${source} ${COMMIT_SETTINGS_KEY}.fallbackThinkingLevel must be one of ${COMMIT_THINKING_LEVELS.join(", ")}`,
      );
    } else {
      configured.fallbackThinkingLevel = fallbackThinkingLevel as CommitThinkingLevel;
    }
  }

  return configured;
}

export function resolveCommitSettings(
  globalSettings: unknown,
  projectSettings?: unknown,
): CommitSettingsResolution {
  const warnings: string[] = [];
  const global = configuredSettings(globalSettings, "Global", warnings);
  const project = configuredSettings(projectSettings, "Project", warnings);

  return {
    model: project.model ?? global.model ?? parseModelReference(DEFAULT_COMMIT_MODEL),
    fallbackModel: project.fallbackModel ?? global.fallbackModel,
    thinkingLevel: project.thinkingLevel ?? global.thinkingLevel,
    fallbackThinkingLevel: project.fallbackThinkingLevel ?? global.fallbackThinkingLevel,
    warnings,
  };
}

async function readSettingsFile(file: string, label: string): Promise<SettingsReadResult> {
  try {
    return { value: JSON.parse(await readFile(file, "utf8")) as unknown };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { value: undefined };
    return {
      value: undefined,
      warning: `${label} settings could not be read from ${file}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function loadCommitSettings(
  cwd: string,
  projectTrusted: boolean,
): Promise<CommitSettingsResolution> {
  const globalPath = path.join(getAgentDir(), "settings.json");
  const projectPath = path.join(cwd, CONFIG_DIR_NAME, "settings.json");

  const [globalRead, projectRead] = await Promise.all([
    readSettingsFile(globalPath, "Global"),
    projectTrusted
      ? readSettingsFile(projectPath, "Project")
      : Promise.resolve<SettingsReadResult>({ value: undefined }),
  ]);

  const resolved = resolveCommitSettings(globalRead.value, projectRead.value);
  if (globalRead.warning) resolved.warnings.unshift(globalRead.warning);
  if (projectRead.warning) resolved.warnings.push(projectRead.warning);
  return resolved;
}
