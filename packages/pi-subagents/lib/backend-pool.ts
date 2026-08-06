/**
 * Lazy RPC + Herdr backends with per-profile resolution.
 */

import type { ProfileDefinition } from "./domain.ts";
import type { SubagentBackend } from "./backend.ts";
import { RpcSubagentBackend } from "./backend-rpc.ts";
import { HerdrSubagentBackend } from "./backend-herdr.ts";
import { resolveBackendKind, type ResolvedBackendKind } from "./backend-selection.ts";
import type { HerdrCliOptions } from "./herdr/cli.ts";
import { getDefaultArtifactRoot } from "./worktree.ts";

export interface SubagentBackendPoolOptions {
  artifactRoot?: string;
  herdrCliOptions?: HerdrCliOptions;
}

export interface ResolvedBackend {
  backend: SubagentBackend;
  backendId: ResolvedBackendKind;
}

export class SubagentBackendPool {
  private artifactRoot: string;
  private herdrCliOptions: HerdrCliOptions | undefined;
  private rpcBackend: RpcSubagentBackend | undefined;
  private herdrBackend: HerdrSubagentBackend | undefined;

  constructor(options?: SubagentBackendPoolOptions) {
    this.artifactRoot = options?.artifactRoot ?? getDefaultArtifactRoot();
    this.herdrCliOptions = options?.herdrCliOptions;
  }

  /**
   * `forceRpc` is set when the caller supplied RPC-only controls (`spawnOverride` /
   * `skipChildRuntime`). Those are meaningless to an interactive Herdr agent, so honoring
   * them requires the RPC child regardless of what the environment would otherwise select.
   */
  resolve(profile: ProfileDefinition, forceRpc = false): ResolvedBackend {
    if (forceRpc) {
      return { backendId: "rpc", backend: this.getRpc() };
    }
    const backendId = resolveBackendKind(profile);
    return {
      backendId,
      backend: backendId === "herdr" ? this.getHerdr() : this.getRpc(),
    };
  }

  getRpc(): RpcSubagentBackend {
    if (!this.rpcBackend) {
      this.rpcBackend = new RpcSubagentBackend();
    }
    return this.rpcBackend;
  }

  getHerdr(): HerdrSubagentBackend {
    if (!this.herdrBackend) {
      this.herdrBackend = new HerdrSubagentBackend(this.artifactRoot, this.herdrCliOptions);
    }
    return this.herdrBackend;
  }

  getHerdrCliOptions(): HerdrCliOptions | undefined {
    return this.herdrBackend?.getCliOptions() ?? this.herdrCliOptions;
  }

  async cancel(backendId: ResolvedBackendKind, runId: string, reason?: string): Promise<void> {
    if (backendId === "herdr") {
      await this.getHerdr().cancel(runId, reason);
    } else {
      await this.getRpc().cancel(runId, reason);
    }
  }

  async dispose(): Promise<void> {
    if (this.rpcBackend) {
      await this.rpcBackend.dispose();
      this.rpcBackend = undefined;
    }
    if (this.herdrBackend) {
      await this.herdrBackend.dispose();
      this.herdrBackend = undefined;
    }
  }
}
