import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";

export type AssistantContentSegment =
  | { kind: "thinking"; segmentIndex: number }
  | { kind: "tools"; toolCallIds: string[] };

function isCommentaryText(part: TextContent): boolean {
  const signature = part.textSignature;
  if (!signature?.startsWith("{")) return false;
  try {
    const parsed = JSON.parse(signature) as { v?: number; phase?: string };
    return parsed.v === 1 && parsed.phase === "commentary";
  } catch {
    return false;
  }
}

function isThinkingRunBreak(part: AssistantMessage["content"][number]): boolean {
  if (part.type === "toolCall") return true;
  if (part.type === "text" && part.text.trim() && !isCommentaryText(part)) return true;
  return false;
}

/** Collect thinking runs (merged consecutive blocks) and tool-call runs in order. */
export function parseAssistantContentSegments(
  content: AssistantMessage["content"],
): AssistantContentSegment[] {
  const segments: AssistantContentSegment[] = [];
  let thinkingRunIndex = 0;
  let pendingTools: string[] = [];
  let inThinkingRun = false;

  const flushTools = (): void => {
    if (pendingTools.length === 0) return;
    segments.push({ kind: "tools", toolCallIds: [...pendingTools] });
    pendingTools = [];
  };

  const flushThinking = (): void => {
    if (!inThinkingRun) return;
    segments.push({ kind: "thinking", segmentIndex: thinkingRunIndex++ });
    inThinkingRun = false;
  };

  for (const part of content) {
    if (part.type === "thinking") {
      flushTools();
      if (part.thinking.trim()) {
        inThinkingRun = true;
      }
      continue;
    }
    if (part.type === "toolCall") {
      flushThinking();
      pendingTools.push(part.id);
      continue;
    }
    if (isThinkingRunBreak(part)) {
      flushTools();
      flushThinking();
    }
  }

  flushTools();
  flushThinking();
  return segments;
}

export function getThinkingSegmentText(
  content: AssistantMessage["content"],
  segmentIndex: number,
): string | undefined {
  const runs: string[] = [];
  let currentRun: string[] = [];

  const flushRun = (): void => {
    if (currentRun.length === 0) return;
    runs.push(currentRun.join("\n\n"));
    currentRun = [];
  };

  for (const part of content) {
    if (part.type === "thinking") {
      const thinking = part.thinking.trim();
      if (thinking) currentRun.push(part.thinking);
      continue;
    }
    if (isThinkingRunBreak(part)) {
      flushRun();
    }
  }
  flushRun();
  return runs[segmentIndex];
}
