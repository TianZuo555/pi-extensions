export type AgyExecutionMode = "plan" | "accept-edits";

export interface AgyProcessProfile {
  agent?: string;
  mode?: AgyExecutionMode;
}

const MAX_AGENT_NAME_LENGTH = 128;

export function readAgyProcessProfile(env: NodeJS.ProcessEnv = process.env): AgyProcessProfile {
  let agent: string | undefined;
  if (env.PI_ANTIGRAVITY_AGENT !== undefined) {
    agent = env.PI_ANTIGRAVITY_AGENT.trim();
    if (!agent) {
      throw new Error("PI_ANTIGRAVITY_AGENT must not be empty.");
    }
    if (agent.includes("\0")) {
      throw new Error("PI_ANTIGRAVITY_AGENT must not contain NUL bytes.");
    }
    if (/[\x01-\x1f\x7f]/.test(agent)) {
      throw new Error("PI_ANTIGRAVITY_AGENT must not contain control characters.");
    }
    if (agent.length > MAX_AGENT_NAME_LENGTH) {
      throw new Error(`PI_ANTIGRAVITY_AGENT must be at most ${MAX_AGENT_NAME_LENGTH} characters.`);
    }
  }

  let mode: AgyExecutionMode | undefined;
  if (env.PI_ANTIGRAVITY_MODE !== undefined) {
    const configured = env.PI_ANTIGRAVITY_MODE.trim();
    if (configured !== "plan" && configured !== "accept-edits") {
      throw new Error('PI_ANTIGRAVITY_MODE must be exactly "plan" or "accept-edits".');
    }
    mode = configured;
  }
  return {
    ...(agent ? { agent } : {}),
    ...(mode ? { mode } : {}),
  };
}

/** Parse the intentionally simple line-oriented output of `agy agents`. */
export function parseAgyAgents(text: string): string[] {
  const agents: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^available\s+agents:?$/i.test(line) || /^name\s+/i.test(line)) continue;
    const name = line
      .split(/\t|\s{2,}/, 1)[0]
      ?.replace(/^[-*]\s*/, "")
      .trim();
    if (!name || name.length > MAX_AGENT_NAME_LENGTH || /[\x00-\x1f\x7f]/.test(name)) continue;
    if (!agents.includes(name)) agents.push(name);
  }
  return agents;
}
