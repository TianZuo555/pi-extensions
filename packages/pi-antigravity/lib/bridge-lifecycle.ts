import type { AgyPiBridge, PiToolInfo } from "./bridge.ts";
import type { SkillLite } from "./skills.ts";

export interface BridgeLifecycleDeps {
  bridge: AgyPiBridge;
  bridgeToken: string;
  writeMcpConfig: (serverName: string, url: string, token: string) => Promise<void>;
  removeMcpConfig: (serverName: string) => Promise<void>;
  evictMcpCache: (serverName: string) => Promise<void>;
  enabled?: boolean;
  notifyWarning?: (message: string) => void;
}

export interface BridgeLifecycleManager {
  readonly isRegistered: () => boolean;
  readonly isRunning: () => boolean;
  readonly ensureRegistered: (notify?: (message: string) => void) => Promise<boolean>;
  readonly teardown: () => Promise<void>;
  readonly registrationGeneration: () => number;
  readonly processRevision: () => string;
  readonly warnMcpAdapterUnsupported: (
    resources: readonly Pick<PiToolInfo, "sourceInfo">[],
    notify?: (message: string) => void,
  ) => void;
  readonly warnSkillsUnavailable: (skills: SkillLite[]) => void;
}

export function createBridgeLifecycleManager(deps: BridgeLifecycleDeps): BridgeLifecycleManager {
  const enabled = deps.enabled ?? true;
  let registered = false;
  let ownsConfig = false;
  let generation = 0;
  let preparing: Promise<boolean> | undefined;
  let tearingDown: Promise<void> | undefined;
  let warnedSkillsUnavailable = false;
  let warnedMcpAdapterUnsupported = false;

  const cleanup = async () => {
    if (!registered && !ownsConfig && !deps.bridge.running) return;
    registered = false;
    let removalError: unknown;
    try {
      await deps.removeMcpConfig(deps.bridge.serverName);
      ownsConfig = false;
    } catch (error) {
      removalError = error;
    }
    try {
      await deps.evictMcpCache(deps.bridge.serverName);
    } catch {
      // Descriptor-cache eviction is best-effort and limited to our own key.
    }
    try {
      await deps.bridge.close();
    } finally {
      generation += 1;
    }
    if (removalError) throw removalError;
  };

  const prepare = async (notify?: (message: string) => void) => {
    try {
      await deps.bridge.start();
      const url = deps.bridge.url;
      if (!url) throw new Error("pi-tool bridge did not expose a URL after start.");
      // A failed write can still leave a partial directory that we own.
      ownsConfig = true;
      await deps.writeMcpConfig(deps.bridge.serverName, url, deps.bridgeToken);
      deps.bridge.refreshTools();
      registered = true;
      generation += 1;
      return true;
    } catch (error) {
      let message = error instanceof Error ? error.message : String(error);
      try {
        await cleanup();
      } catch (cleanupError) {
        message += `; cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`;
      }
      const warning = `antigravity: pi-tool bridge unavailable (${message}).`;
      (notify ?? deps.notifyWarning)?.(warning);
      return false;
    }
  };

  return {
    isRegistered: () => registered,
    isRunning: () => deps.bridge.running,
    registrationGeneration: () => generation,
    processRevision: () => `${generation}:${deps.bridge.catalogRevision}`,

    ensureRegistered: async (notify) => {
      if (!enabled) return false;
      if (tearingDown) await tearingDown;
      if (registered) return true;
      preparing ??= prepare(notify).finally(() => {
        preparing = undefined;
      });
      return preparing;
    },

    teardown: async () => {
      tearingDown ??= (async () => {
        await preparing;
        await cleanup();
      })().finally(() => {
        tearingDown = undefined;
      });
      await tearingDown;
    },

    warnMcpAdapterUnsupported: (resources, notify) => {
      if (!enabled || warnedMcpAdapterUnsupported) return;
      const adapterSource = /(?:^|[:/\\])pi-mcp-adapter(?=$|[@/\\.])/;
      const installed = resources.some(({ sourceInfo }) =>
        [sourceInfo?.source, sourceInfo?.path].some((value) => adapterSource.test(value ?? "")),
      );
      const warn = notify ?? deps.notifyWarning;
      if (!installed || !warn) return;
      warnedMcpAdapterUnsupported = true;
      warn(
        "antigravity: pi-mcp-adapter is installed, but its MCP tools are not bridged to agy. " +
          "It also replaces Pi's built-in MCP support. Remove or disable pi-mcp-adapter, " +
          'move your servers to ~/.pi/agent/mcp.json (or .pi/mcp.json) with "exposure": "direct", ' +
          "then run /reload.",
      );
    },

    warnSkillsUnavailable: (skills) => {
      if (warnedSkillsUnavailable || skills.length === 0) return;
      if (enabled && registered) return;
      warnedSkillsUnavailable = true;
      deps.notifyWarning?.(
        enabled
          ? "antigravity: pi-tool bridge failed to prepare — pi-private skills are unavailable to agy this session."
          : "antigravity: pi-tool bridge is disabled — pi-private skills are unavailable to agy this session.",
      );
    },
  };
}
