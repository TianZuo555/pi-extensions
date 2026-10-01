import {
  compact,
  type CompactionResult,
  type ExtensionContext,
  type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { CompactSettings } from "./settings.ts";

/** Reuse Pi's summarizer, including split turns, previous summaries, file tracking and usage. */
export async function requestTextCompaction(
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
  model: Model<Api>,
  settings: CompactSettings,
  signal: AbortSignal,
  fetch?: typeof globalThis.fetch,
): Promise<CompactionResult> {
  const controller = new AbortController();
  const timeout = new Error(`Text compaction timed out after ${settings.requestTimeoutMs}ms`);
  const timer = setTimeout(() => controller.abort(timeout), settings.requestTimeoutMs);
  timer.unref();
  let emptySummary = false;
  try {
    const result = await compact(
      event.preparation,
      model,
      undefined,
      undefined,
      event.customInstructions,
      AbortSignal.any([signal, controller.signal]),
      ctx.thinkingLevel,
      async (summaryModel, context, options) => {
        const stream = ctx.modelRegistry.streamSimple(summaryModel, context, {
          ...options,
          fetch,
          timeoutMs: settings.requestTimeoutMs,
          maxRetries: settings.maxRetries,
        });
        const response = await stream.result();
        emptySummary ||= !response.content.some(
          (part) => part.type === "text" && part.text.trim().length > 0,
        );
        return stream;
      },
      undefined,
      { enabled: false, maxRetries: 0, baseDelayMs: 0 },
      undefined,
      ctx.sessionManager.getSessionId(),
    );
    // File-list suffixes must not make an otherwise empty summary look valid.
    if (emptySummary || !result.summary.trim()) {
      throw new Error("Text compaction returned an empty summary");
    }
    return result;
  } catch (error) {
    if (!signal.aborted && controller.signal.reason === timeout) throw timeout;
    throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
