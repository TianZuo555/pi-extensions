import type { RunUsage } from "./domain.ts";

export function usageFromSessionStats(data: {
  tokens?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  cost?: number;
  assistantMessages?: number;
}): RunUsage {
  return {
    input: data.tokens?.input ?? 0,
    output: data.tokens?.output ?? 0,
    cacheRead: data.tokens?.cacheRead ?? 0,
    cacheWrite: data.tokens?.cacheWrite ?? 0,
    cost: data.cost ?? 0,
    turns: data.assistantMessages ?? 0,
  };
}
