import { promises as fs } from "node:fs";
import * as os from "node:os";
import path from "node:path";

/** agy stores tool descriptors under a server-name key shared by its processes. */
export function agyMcpCacheDir(home = os.homedir()): string {
  return path.join(home, ".gemini", "antigravity-cli", "mcp");
}

/** Remove only the descriptor cache belonging to this bridge instance. */
export async function removeMcpCacheEntry(serverName: string, home = os.homedir()): Promise<void> {
  await fs
    .rm(path.join(agyMcpCacheDir(home), serverName), { recursive: true, force: true })
    .catch(() => {});
}
