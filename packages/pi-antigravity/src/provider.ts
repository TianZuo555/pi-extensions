/**
 * streamSimple adapter — runs one agy turn per pi request and translates the
 * reduced outcome into pi AssistantMessageEvents.
 *
 * agy streams no assistant-text deltas; tool activity streams live and is
 * surfaced through pi's thinking channel (dim, collapsible), while the final
 * text arrives from the terminal result event as a single text block.
 */

import {
  calculateCost,
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { AgyTurnOutcome } from "../lib/reducer.ts";
import type { AntigravityRuntimeInstance, AntigravityRuntimeShape } from "./runtime.ts";

interface TextPart {
  type: "text";
  text: string;
}

interface ImagePart {
  type: "image";
  [k: string]: unknown;
}

/** Extract the latest user message text (plus an image-omitted note). */
export function latestUserPrompt(context: Context): { prompt: string; images: number } {
  let images = 0;
  for (let i = context.messages.length - 1; i >= 0; i--) {
    const message = context.messages[i] as { role?: string; content?: unknown };
    if (message.role !== "user") continue;
    const parts = Array.isArray(message.content) ? message.content : [];
    let text = "";
    for (const part of parts as (TextPart | ImagePart)[]) {
      if (part && typeof part === "object" && part.type === "text") {
        text += (text ? "\n" : "") + part.text;
      } else if (part && typeof part === "object" && part.type === "image") {
        images += 1;
      }
    }
    if (images > 0) {
      text += `\n(${images} image(s) omitted — the agy print interface is text-only)`;
    }
    return { prompt: text, images };
  }
  return { prompt: "", images: 0 };
}

const EMPTY_OUTCOME: AgyTurnOutcome = {
  conversationId: undefined,
  status: "UNKNOWN",
  response: "",
  error: undefined,
  usage: undefined,
  toolLines: [],
  finished: false,
};

/** Map agy usage fields to pi usage fields. */
export function mapUsage(outcome: AgyTurnOutcome): AssistantMessage["usage"] {
  const u = outcome.usage;
  return {
    input: u?.input_tokens ?? 0,
    output: u?.output_tokens ?? 0,
    cacheRead: u?.cache_read_tokens ?? 0,
    cacheWrite: 0,
    totalTokens: u?.total_tokens ?? 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

const OVERFLOW_PATTERN = /context (length|window|size).*(exceed|limit)|exceeds.*context/i;

/** Build the streamSimple implementation bound to the runtime service. */
export function streamAntigravity(
  runtime: AntigravityRuntimeInstance,
  service: AntigravityRuntimeShape,
) {
  return (
    model: Model<string>,
    context: Context,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream => {
    const stream = createAssistantMessageEventStream();

    (async () => {
      const output: AssistantMessage = {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: mapUsage(EMPTY_OUTCOME),
        stopReason: "pending",
        timestamp: Date.now(),
      };

      const fail = (message: string) => {
        const hint = message.includes("permission check failed for command")
          ? " — add an allow-rule (e.g. command(*)) to permissions.allow in ~/.gemini/antigravity-cli/settings.json for autonomous agy turns"
          : "";
        output.stopReason = options?.signal?.aborted ? "aborted" : "error";
        output.errorMessage = `${message}${hint}`;
        stream.push({ type: "error", reason: output.stopReason, error: output });
        stream.end();
      };

      try {
        stream.push({ type: "start", partial: output });

        const { prompt } = latestUserPrompt(context);
        if (!prompt) {
          throw new Error("antigravity: no user text found in the request context.");
        }

        const { resumeConversationId } = await runtime.runPromise(
          service.beginTurn(model.id),
        );

        let thinkingIndex = -1;
        const ensureThinking = () => {
          if (thinkingIndex >= 0) return;
          output.content.push({ type: "thinking", thinking: "" });
          thinkingIndex = output.content.length - 1;
          stream.push({ type: "thinking_start", contentIndex: thinkingIndex, partial: output });
        };

        const result: AgyTurnOutcome = await runtime.runPromise(
          service.runTurn({
            prompt,
            conversationId: resumeConversationId,
            model: model.id,
            timeoutMs: 600_000,
            signal: options?.signal,
            onActivity: (line) => {
              ensureThinking();
              const block = output.content[thinkingIndex];
              if (block.type === "thinking") block.thinking += `${line}\n`;
              stream.push({
                type: "thinking_delta",
                contentIndex: thinkingIndex,
                delta: `${line}\n`,
                partial: output,
              });
            },
          }),
        );

        if (thinkingIndex >= 0) {
          const block = output.content[thinkingIndex];
          stream.push({
            type: "thinking_end",
            contentIndex: thinkingIndex,
            content: block.type === "thinking" ? block.thinking : "",
            partial: output,
          });
        }

        output.usage = mapUsage(result);
        calculateCost(model, output.usage);

        if (result.response) {
          output.content.push({ type: "text", text: result.response });
          const idx = output.content.length - 1;
          stream.push({ type: "text_start", contentIndex: idx, partial: output });
          stream.push({
            type: "text_delta",
            contentIndex: idx,
            delta: result.response,
            partial: output,
          });
          stream.push({
            type: "text_end",
            contentIndex: idx,
            content: result.response,
            partial: output,
          });
        }

        if (result.status === "ERROR") {
          const message = result.error || "agy reported an error for this turn.";
          output.stopReason = "error";
          output.errorMessage = OVERFLOW_PATTERN.test(message)
            ? `context_length_exceeded: ${message}`
            : message;
          stream.push({ type: "error", reason: "error", error: output });
        } else {
          output.stopReason = "stop";
          stream.push({ type: "done", reason: "stop", message: output });
        }
        stream.end();
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
      }
    })();

    return stream;
  };
}
