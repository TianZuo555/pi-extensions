import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { piConfigDir } from "./config.ts";

/** One process's workspace MCP discovery, passed only to its agy children. */
export function createPrivateMcpConfig(root = piConfigDir("antigravity/bridges")) {
  const id = randomUUID();
  // agy caches descriptors by server name; keep that key unique and short.
  const serverName = `pi-${id.replaceAll("-", "").slice(0, 12)}`;
  const directory = path.join(root, id);
  const agentsDirectory = path.join(directory, ".agents");

  return {
    serverName,
    directory,
    async write(url: string, token: string): Promise<void> {
      await mkdir(agentsDirectory, { recursive: true, mode: 0o700 });
      await writeFile(
        path.join(agentsDirectory, "mcp_config.json"),
        `${JSON.stringify(
          {
            mcpServers: {
              [serverName]: {
                serverUrl: url,
                headers: { "x-pi-bridge-token": token },
              },
            },
          },
          null,
          2,
        )}\n`,
        { mode: 0o600 },
      );
    },
    async remove(): Promise<void> {
      await rm(directory, { recursive: true, force: true });
    },
  };
}
