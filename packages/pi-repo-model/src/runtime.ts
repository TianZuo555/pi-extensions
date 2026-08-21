/**
 * RepoModelRuntime — Effect v4 service for managing per-repository default
 * model preferences and central machine-local registry persistence.
 */

import path from "node:path";
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
import { RepoModelConfigError, type RepoModelError } from "./errors.ts";

export type SessionStartReason = "startup" | "new" | "resume" | "fork" | "reload";
export const DEFAULT_TRIGGERS: SessionStartReason[] = ["startup", "new"];

export interface RepoModelEntry {
  name?: string;
  provider: string;
  model: string;
  thinkingLevel?: string;
  updatedAt?: string;
}

export interface RepoModelConfig {
  version: number;
  triggers?: SessionStartReason[];
  repos?: Record<string, RepoModelEntry>;
}

export const CONFIG_FILE = path.join(piConfigDir("repo-model"), "config.json");

export interface RepoModelRuntimeShape {
  readonly loadConfig: Effect.Effect<RepoModelConfig>;
  readonly saveConfig: (config: RepoModelConfig) => Effect.Effect<void, RepoModelConfigError>;
  readonly getRepoMeta: (cwd: string) => Effect.Effect<RepoMeta>;
  readonly getRepoModel: (cwd: string) => Effect.Effect<RepoModelEntry | undefined>;
  readonly setRepoModel: (
    cwd: string,
    entry: Omit<RepoModelEntry, "updatedAt">,
  ) => Effect.Effect<RepoModelConfig, RepoModelConfigError>;
  readonly unsetRepoModel: (
    cwd: string,
  ) => Effect.Effect<{ removed: boolean; repoName: string }, RepoModelConfigError>;
  readonly listRepos: Effect.Effect<
    Array<{ path: string; name: string; entry: RepoModelEntry }>
  >;
}

export class RepoModelRuntime extends Context.Service<
  RepoModelRuntime,
  RepoModelRuntimeShape
>()("pi-repo-model/RepoModelRuntime") {}

const makeRepoModelRuntime = Effect.sync(() => {
  const loadConfig: Effect.Effect<RepoModelConfig> = Effect.sync(() => {
    const data = readJson<RepoModelConfig>(CONFIG_FILE, {
      version: 1,
      triggers: DEFAULT_TRIGGERS,
      repos: {},
    });
    return {
      version: 1,
      triggers: (data.triggers?.length ? data.triggers : DEFAULT_TRIGGERS) as SessionStartReason[],
      repos: data.repos ?? {},
    };
  });

  const saveConfig = (config: RepoModelConfig): Effect.Effect<void, RepoModelConfigError> =>
    Effect.try({
      try: () => writeJson(CONFIG_FILE, config),
      catch: (err) =>
        new RepoModelConfigError({
          message: `Failed to save repo model config: ${err instanceof Error ? err.message : String(err)}`,
        }),
    });

  const getRepoMeta = (cwd: string): Effect.Effect<RepoMeta> =>
    Effect.sync(() => getRepoMetaHelper(cwd));

  const getRepoModel = (cwd: string): Effect.Effect<RepoModelEntry | undefined> =>
    Effect.gen(function* () {
      const meta = yield* getRepoMeta(cwd);
      const config = yield* loadConfig;
      return config.repos?.[meta.key];
    });

  const setRepoModel = (
    cwd: string,
    entry: Omit<RepoModelEntry, "updatedAt">,
  ): Effect.Effect<RepoModelConfig, RepoModelConfigError> =>
    Effect.gen(function* () {
      const meta = yield* getRepoMeta(cwd);
      const config = yield* loadConfig;
      const repos = { ...(config.repos ?? {}) };
      repos[meta.key] = {
        ...entry,
        name: meta.name,
        updatedAt: new Date().toISOString(),
      };
      const updated: RepoModelConfig = { ...config, repos };
      yield* saveConfig(updated);
      return updated;
    });

  const unsetRepoModel = (
    cwd: string,
  ): Effect.Effect<{ removed: boolean; repoName: string }, RepoModelConfigError> =>
    Effect.gen(function* () {
      const meta = yield* getRepoMeta(cwd);
      const config = yield* loadConfig;
      if (!config.repos?.[meta.key]) {
        return { removed: false, repoName: meta.name };
      }
      const repos = { ...config.repos };
      delete repos[meta.key];
      const updated: RepoModelConfig = { ...config, repos };
      yield* saveConfig(updated);
      return { removed: true, repoName: meta.name };
    });

  const listRepos: Effect.Effect<
    Array<{ path: string; name: string; entry: RepoModelEntry }>
  > = Effect.gen(function* () {
    const config = yield* loadConfig;
    const entries: Array<{ path: string; name: string; entry: RepoModelEntry }> = [];
    for (const [repoPath, entry] of Object.entries(config.repos ?? {})) {
      entries.push({
        path: repoPath,
        name: entry.name || path.basename(repoPath),
        entry,
      });
    }
    return entries;
  });

  return RepoModelRuntime.of({
    loadConfig,
    saveConfig,
    getRepoMeta,
    getRepoModel,
    setRepoModel,
    unsetRepoModel,
    listRepos,
  });
});

export const RepoModelRuntimeLive: Layer.Layer<RepoModelRuntime> = Layer.effect(
  RepoModelRuntime,
  makeRepoModelRuntime,
);

export function createRepoModelRuntime() {
  return ManagedRuntime.make(RepoModelRuntimeLive);
}

export type RepoModelRuntimeInstance = ReturnType<typeof createRepoModelRuntime>;

/** Run an async repo-model effect program safely */
export async function runRepoModel<A, E>(
  runtime: RepoModelRuntimeInstance,
  effect: Effect.Effect<A, E>,
  options: { signal?: AbortSignal } = {},
): Promise<A> {
  const exit = await runtime.runPromiseExit(
    effect,
    options.signal ? { signal: options.signal } : undefined,
  );
  if (Exit.isSuccess(exit)) return exit.value;
  if (Cause.hasInterruptsOnly(exit.cause)) {
    const error = new Error("repo-model operation aborted");
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
