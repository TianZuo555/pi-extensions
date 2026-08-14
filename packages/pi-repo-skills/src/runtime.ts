/**
 * RepoSkillsRuntime — Effect v4 service for managing per-repository skill
 * toggles, system prompt filtering, and central config persistence.
 */

import path from "node:path";
import type { Skill } from "@earendil-works/pi-coding-agent";
import {
  Cause,
  Context,
  Effect,
  Exit,
  Layer,
  ManagedRuntime,
  Result,
} from "effect";
import {
  getRepoMeta as getRepoMetaHelper,
  piConfigDir,
  readJson,
  type RepoMeta,
  writeJson,
} from "../lib/repo-registry.ts";
import { RepoSkillsConfigError } from "./errors.ts";

export const ALL = "ALL" as const;
export type DisabledSkills = string[] | typeof ALL;

export interface RepoSkillsEntry {
  name?: string;
  disabled: DisabledSkills;
  updatedAt?: string;
}

export interface RepoSkillsConfig {
  version: number;
  repos?: Record<string, RepoSkillsEntry>;
}

export const CONFIG_FILE = path.join(piConfigDir("repo-skills"), "config.json");

export function isDisabled(disabled: DisabledSkills | undefined, name: string): boolean {
  if (!disabled) return false;
  if (disabled === ALL) return true;
  return disabled.includes(name);
}

export interface RepoSkillsRuntimeShape {
  readonly loadConfig: Effect.Effect<RepoSkillsConfig>;
  readonly saveConfig: (
    config: RepoSkillsConfig,
  ) => Effect.Effect<void, RepoSkillsConfigError>;
  readonly getRepoMeta: (cwd: string) => Effect.Effect<RepoMeta>;
  readonly getRepoSkills: (cwd: string) => Effect.Effect<RepoSkillsEntry | undefined>;
  readonly setRepoSkills: (
    cwd: string,
    disabled: DisabledSkills,
  ) => Effect.Effect<RepoSkillsConfig, RepoSkillsConfigError>;
  readonly resetRepoSkills: (
    cwd: string,
  ) => Effect.Effect<{ removed: boolean; repoName: string }, RepoSkillsConfigError>;
  readonly listRepos: Effect.Effect<
    Array<{ path: string; name: string; disabled: DisabledSkills }>
  >;
  readonly filterSkills: (
    skills: Skill[],
    cwd: string,
  ) => Effect.Effect<{ enabled: Skill[]; disabledCount: number }>;
}

export class RepoSkillsRuntime extends Context.Service<
  RepoSkillsRuntime,
  RepoSkillsRuntimeShape
>()("pi-tian-repo-skills/RepoSkillsRuntime") {}

const makeRepoSkillsRuntime = Effect.sync(() => {
  const loadConfig: Effect.Effect<RepoSkillsConfig> = Effect.sync(() => {
    const data = readJson<RepoSkillsConfig>(CONFIG_FILE, { version: 1, repos: {} });
    return { version: 1, repos: data.repos ?? {} };
  });

  const saveConfig = (
    config: RepoSkillsConfig,
  ): Effect.Effect<void, RepoSkillsConfigError> =>
    Effect.try({
      try: () => writeJson(CONFIG_FILE, config),
      catch: (err) =>
        new RepoSkillsConfigError({
          message: `Failed to save repo skills config: ${err instanceof Error ? err.message : String(err)}`,
        }),
    });

  const getRepoMeta = (cwd: string): Effect.Effect<RepoMeta> =>
    Effect.sync(() => getRepoMetaHelper(cwd));

  const getRepoSkills = (cwd: string): Effect.Effect<RepoSkillsEntry | undefined> =>
    Effect.gen(function* () {
      const meta = yield* getRepoMeta(cwd);
      const config = yield* loadConfig;
      return config.repos?.[meta.key];
    });

  const setRepoSkills = (
    cwd: string,
    disabled: DisabledSkills,
  ): Effect.Effect<RepoSkillsConfig, RepoSkillsConfigError> =>
    Effect.gen(function* () {
      const meta = yield* getRepoMeta(cwd);
      const config = yield* loadConfig;
      const repos = { ...(config.repos ?? {}) };

      if (Array.isArray(disabled) && disabled.length === 0) {
        delete repos[meta.key];
      } else {
        repos[meta.key] = {
          name: meta.name,
          disabled,
          updatedAt: new Date().toISOString(),
        };
      }
      const updated: RepoSkillsConfig = { ...config, repos };
      yield* saveConfig(updated);
      return updated;
    });

  const resetRepoSkills = (
    cwd: string,
  ): Effect.Effect<{ removed: boolean; repoName: string }, RepoSkillsConfigError> =>
    Effect.gen(function* () {
      const meta = yield* getRepoMeta(cwd);
      const config = yield* loadConfig;
      if (!config.repos?.[meta.key]) {
        return { removed: false, repoName: meta.name };
      }
      const repos = { ...config.repos };
      delete repos[meta.key];
      const updated: RepoSkillsConfig = { ...config, repos };
      yield* saveConfig(updated);
      return { removed: true, repoName: meta.name };
    });

  const listRepos: Effect.Effect<
    Array<{ path: string; name: string; disabled: DisabledSkills }>
  > = Effect.gen(function* () {
    const config = yield* loadConfig;
    const entries: Array<{ path: string; name: string; disabled: DisabledSkills }> = [];
    for (const [repoPath, entry] of Object.entries(config.repos ?? {})) {
      entries.push({
        path: repoPath,
        name: entry.name || path.basename(repoPath),
        disabled: entry.disabled,
      });
    }
    return entries;
  });

  const filterSkills = (
    skills: Skill[],
    cwd: string,
  ): Effect.Effect<{ enabled: Skill[]; disabledCount: number }> =>
    Effect.gen(function* () {
      const entry = yield* getRepoSkills(cwd);
      if (!entry || !entry.disabled) {
        return { enabled: skills, disabledCount: 0 };
      }
      const enabled = skills.filter((s) => !isDisabled(entry.disabled, s.name));
      const disabledCount = skills.length - enabled.length;
      return { enabled, disabledCount };
    });

  return RepoSkillsRuntime.of({
    loadConfig,
    saveConfig,
    getRepoMeta,
    getRepoSkills,
    setRepoSkills,
    resetRepoSkills,
    listRepos,
    filterSkills,
  });
});

export const RepoSkillsRuntimeLive: Layer.Layer<RepoSkillsRuntime> = Layer.effect(
  RepoSkillsRuntime,
  makeRepoSkillsRuntime,
);

export function createRepoSkillsRuntime() {
  return ManagedRuntime.make(RepoSkillsRuntimeLive);
}

export type RepoSkillsRuntimeInstance = ReturnType<typeof createRepoSkillsRuntime>;

/** Run an async repo-skills effect program safely */
export async function runRepoSkills<A, E>(
  runtime: RepoSkillsRuntimeInstance,
  effect: Effect.Effect<A, E>,
  options: { signal?: AbortSignal } = {},
): Promise<A> {
  const exit = await runtime.runPromiseExit(
    effect,
    options.signal ? { signal: options.signal } : undefined,
  );
  if (Exit.isSuccess(exit)) return exit.value;
  if (Cause.hasInterruptsOnly(exit.cause)) {
    const error = new Error("repo-skills operation aborted");
    error.name = "AbortError";
    throw error;
  }
  const failure = Cause.findFail(exit.cause);
  if (Result.isSuccess(failure)) {
    const err = failure.success.error;
    if (err instanceof Error) throw err;
    if (typeof err === "object" && err !== null && "message" in err) {
      throw new Error(String((err as { message: unknown }).message));
    }
    throw new Error(String(err));
  }
  const [first] = Cause.prettyErrors(exit.cause);
  throw new Error(first?.message ?? Cause.pretty(exit.cause));
}
