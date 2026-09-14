/** Model-facing checkpoint and compaction instructions. */
export function checkpointMarker(checkpointId: string): string {
  return [
    `[PI_CODEX_REMOTE_CHECKPOINT:${checkpointId}]`,
    "Opaque checkpoint injection failed. Do not infer missing history; tell the user to load",
    "@tian.zuo/pi-compact through the original Codex provider and Responses API.",
  ].join(" ");
}

export function fallbackSummary(checkpointId: string): string {
  return [
    `Responses compaction checkpoint ${checkpointId} stores the older history opaquely.`,
    "Full replay requires @tian.zuo/pi-compact through the original Codex provider and Responses API.",
    "Without them, only Pi's retained recent messages remain available.",
  ].join(" ");
}

export function compactionSystemPrompt(systemPrompt: string, customInstructions?: string): string {
  const instructions = customInstructions?.trim();
  if (!instructions) return systemPrompt;
  return `${systemPrompt}\n\nAdditional instructions for this compaction only:\n${instructions}`;
}
