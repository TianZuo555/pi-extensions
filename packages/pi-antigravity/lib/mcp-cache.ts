/**
 * agy's MCP tool-manifest cache.
 *
 * agy writes one directory of JSON tool manifests per connected server under
 * `~/.gemini/antigravity-cli/mcp/<server-name>/`. Nothing evicts the cache —
 * `agy mcp remove` only deregisters, and a dead loopback server leaves its
 * manifests behind — so every bridge session leaks a directory. This module
 * computes cache paths and prunes bridge entries whose server is gone.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BRIDGE_SERVER_NAME } from "./bridge.ts";

export function agyMcpCacheDir(home = os.homedir()): string {
  return path.join(home, ".gemini", "antigravity-cli", "mcp");
}

/** Remove one server's manifest cache directory. Best-effort; never throws. */
export async function removeMcpCacheEntry(serverName: string, home = os.homedir()): Promise<void> {
  await fs
    .rm(path.join(agyMcpCacheDir(home), serverName), { recursive: true, force: true })
    .catch(() => {});
}

/**
 * Delete every bridge cache entry (legacy `pi-bridge` or `pi-bridge-<pid>`)
 * that is not in `liveServers`. Non-bridge entries are left untouched.
 * Returns the removed entry names.
 */
export async function pruneBridgeMcpCache(options: {
  liveServers: Iterable<string>;
  home?: string;
}): Promise<string[]> {
  const live = new Set(options.liveServers);
  let entries: string[];
  try {
    entries = await fs.readdir(agyMcpCacheDir(options.home));
  } catch {
    return []; // Cache directory absent — nothing to prune.
  }
  const dead = entries.filter((name) => isBridgeCacheEntry(name) && !live.has(name));
  await Promise.all(dead.map((name) => removeMcpCacheEntry(name, options.home)));
  return dead;
}

function isBridgeCacheEntry(name: string): boolean {
  if (name === BRIDGE_SERVER_NAME) return true; // pre-pid legacy registration
  return (
    name.startsWith(`${BRIDGE_SERVER_NAME}-`) &&
    /^\d+$/.test(name.slice(BRIDGE_SERVER_NAME.length + 1))
  );
}
