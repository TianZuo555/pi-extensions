import type { AgyPiBridge } from "./bridge.ts";
import { formatSkillCatalog, type SkillLite } from "./skills.ts";

export interface BridgeLifecycleDeps {
  bridge: AgyPiBridge;
  bridgeToken: string;
  addMcpServer: (serverName: string, url: string, token: string) => Promise<void>;
  removeMcpServer: (serverName: string) => Promise<void>;
  evictMcpCache: (serverName: string) => Promise<void>;
  enabled?: boolean;
  pruneStaleRegistrations?: () => Promise<void>;
  notifyWarning?: (message: string) => void;
}

export interface BridgeLifecycleManager {
  readonly isRegistered: () => boolean;
  readonly isRunning: () => boolean;
  readonly ensureRegistered: (notify?: (message: string) => void) => Promise<boolean>;
  readonly teardown: () => Promise<void>;
  readonly getBootstrapSuffix: (skills: SkillLite[]) => string | undefined;
}

export function createBridgeLifecycleManager(deps: BridgeLifecycleDeps): BridgeLifecycleManager {
  const enabled = deps.enabled ?? true;
  let registered = false;

  return {
    isRegistered: () => registered,
    isRunning: () => deps.bridge.running,

    ensureRegistered: async (notify?: (message: string) => void) => {
      if (!enabled) return false;
      if (registered) return true;

      try {
        if (deps.pruneStaleRegistrations) {
          await deps.pruneStaleRegistrations();
        }
        if (!deps.bridge.running) {
          await deps.bridge.start();
        }
        const url = deps.bridge.url;
        if (!url) throw new Error("pi-tool bridge did not expose a URL after start.");
        await deps.addMcpServer(deps.bridge.serverName, url, deps.bridgeToken);
        deps.bridge.refreshTools();
        registered = true;
        return true;
      } catch (error) {
        registered = false;
        const message = error instanceof Error ? error.message : String(error);
        const warning = `antigravity: pi-tool bridge unavailable (${message}).`;
        if (notify) {
          notify(warning);
        } else {
          deps.notifyWarning?.(warning);
        }
        return false;
      }
    },

    teardown: async () => {
      if (!registered && !deps.bridge.running) return;
      registered = false;
      try {
        await deps.removeMcpServer(deps.bridge.serverName);
      } catch {
        // Registration may already be gone.
      }
      try {
        await deps.evictMcpCache(deps.bridge.serverName);
      } catch {
        // Manifest cache eviction is best-effort.
      }
      if (deps.bridge.running) {
        await deps.bridge.close();
      }
    },

    getBootstrapSuffix: (skills: SkillLite[]) =>
      enabled && registered ? undefined : formatSkillCatalog(skills),
  };
}
