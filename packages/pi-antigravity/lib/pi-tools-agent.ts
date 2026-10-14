import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { PI_TOOLS_AGENT_DESCRIPTION, piToolsAgentPrompt } from "./prompt.ts";

export interface PiToolsAgentBridge {
  serverName: string;
  url: string;
  token: string;
}

/** One session-owned agent, discovered by agy without changing the workspace. */
export function createPiToolsAgent(
  agentRoot = path.join(homedir(), ".gemini", "config", "agents"),
) {
  const name = `pi-tools-${process.pid}-${randomUUID()}`;
  const directory = path.join(agentRoot, name);
  let prepared = false;

  return {
    name,
    isPrepared: () => prepared,
    async prepare(bridge: PiToolsAgentBridge): Promise<void> {
      prepared = false;
      const definition = {
        name,
        description: PI_TOOLS_AGENT_DESCRIPTION,
        mainAgent: true,
        subagent: false,
        inheritCustomizations: false,
        tools: [],
        mcpServers: [
          {
            name: bridge.serverName,
            serverUrl: bridge.url,
            headers: { "x-pi-bridge-token": bridge.token },
          },
        ],
      };
      await mkdir(directory, { recursive: true, mode: 0o700 });
      // JSON is valid YAML frontmatter and safely quotes the URL, name and token.
      await writeFile(
        path.join(directory, "agent.md"),
        `---
${JSON.stringify(definition, null, 2)}
---

${piToolsAgentPrompt(bridge.serverName)}
`,
        { mode: 0o600 },
      );
      prepared = true;
    },
    async remove(): Promise<void> {
      prepared = false;
      await rm(directory, { recursive: true, force: true });
    },
  };
}
