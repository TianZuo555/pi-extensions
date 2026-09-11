/**
 * streamSimple adapter — runs one devin ACP turn per pi request and
 * translates session/update notifications into pi AssistantMessageEvents.
 *
 * `agent_message_chunk` streams into pi's text channel and
 * `agent_thought_chunk` into thinking blocks, keyed by ACP messageId. ACP
 * `tool_call` updates render as display-only tool cards: the provider
 * records the terminal result in the replay store and ends the assistant
 * message with stopReason "toolUse"; pi executes the `devin` wrapper tool,
 * then re-invokes this adapter, which re-attaches to the still-running
 * session/prompt via the runtime's turn controller.
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
import type { ContentBlock } from "@agentclientprotocol/sdk";
import type { DevinRuntimeInstance, DevinRuntimeShape } from "./runtime.ts";
import type { DevinActivity, DevinTurnController, DevinUsage } from "./turn.ts";
import type { DevinReplayStore } from "../lib/replay.ts";
import { devinIncompleteToolError } from "../lib/prompt.ts";
import { summarizeDevinCall, type DevinToolView } from "../lib/tool-content.ts";
import type { DevinModelFamily } from "../lib/models.ts";
import { findDevinGroup, resolveDevinModelRow } from "../lib/models.ts";

interface TextPart {
  type: "text";
  text: string;
}

interface ImagePart {
  type: "image";
  data?: unknown;
  mimeType?: unknown;
  [k: string]: unknown;
}

/**
 * Preserve the latest contiguous user-message batch in order. Trailing
 * assistant/tool messages are tool-loop re-entry, not new user input.
 */
function latestUserBatch(context: Context): {
  start: number;
  prompt: string;
  images: ImagePart[];
} {
  for (let i = context.messages.length - 1; i >= 0; i--) {
    if (context.messages[i].role !== "user") continue;
    const end = i + 1;
    while (i > 0 && context.messages[i - 1].role === "user") i--;
    const texts: string[] = [];
    const images: ImagePart[] = [];
    for (const message of context.messages.slice(i, end)) {
      if (typeof message.content === "string") {
        if (message.content.trim()) texts.push(message.content);
        continue;
      }
      const parts = Array.isArray(message.content) ? message.content : [];
      for (const part of parts as (TextPart | ImagePart)[]) {
        if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) {
          texts.push(part.text);
        } else if (part?.type === "image") {
          images.push(part);
        }
      }
    }
    if (texts.length === 0 && images.length === 0) continue;
    return { start: i, prompt: texts.join("\n"), images };
  }
  return { start: -1, prompt: "", images: [] };
}

// A fresh devin session can safely receive roughly 60k transcript tokens
// while leaving the working window room for system/tools and the response.
const MAX_RESTORED_HISTORY_CHARS = 240_000;

/** Serialize the active pi branch before its latest user request. */
export function piHistoryBootstrap(context: Context): string | undefined {
  const { start: latestUser } = latestUserBatch(context);
  if (latestUser <= 0) return undefined;

  const entries: string[] = [];
  for (const raw of context.messages.slice(0, latestUser)) {
    const message = raw as { role?: string; toolName?: string; content?: unknown };
    const parts = Array.isArray(message.content) ? message.content : [];
    const rendered: string[] =
      typeof message.content === "string" && message.content.trim() ? [message.content] : [];
    for (const part of parts as Array<Record<string, unknown>>) {
      if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) {
        rendered.push(part.text);
      } else if (part?.type === "toolCall" && typeof part.name === "string") {
        const args = JSON.stringify(part.arguments ?? {});
        rendered.push(`[tool call: ${part.name}${args === "{}" ? "" : ` ${args}`}]`);
      } else if (part?.type === "thinking" && typeof part.thinking === "string") {
        if (part.thinking.trim()) rendered.push(`[thinking: ${part.thinking.trim()}]`);
      }
    }
    if (rendered.length === 0) continue;
    const role =
      message.role === "toolResult"
        ? `tool ${message.toolName ?? "result"}`
        : (message.role ?? "message");
    entries.push(`${role}:\n${rendered.join("\n")}`);
  }
  if (entries.length === 0) return undefined;
  const transcript = entries.join("\n\n");
  return transcript.length <= MAX_RESTORED_HISTORY_CHARS
    ? transcript
    : `[Earlier history omitted]\n${transcript.slice(-MAX_RESTORED_HISTORY_CHARS)}`;
}

/**
 * pi's compaction and branch summarization arrive as standalone requests
 * whose only user message is `<conversation>\n…</conversation>`. They run in
 * disposable ACP sessions so internal summary prompts never become user
 * input in the real devin session.
 */
export function isSummarizationRequest(prompt: string): boolean {
  return prompt.startsWith("<conversation>\n");
}

/** Map devin usage fields to pi usage fields. */
export function mapUsage(u: DevinUsage | undefined): AssistantMessage["usage"] {
  return {
    input: u?.inputTokens ?? 0,
    output: u?.outputTokens ?? 0,
    reasoning: undefined,
    cacheRead: u?.cachedReadTokens ?? 0,
    cacheWrite: 0,
    totalTokens: u?.contextUsed ?? (u?.inputTokens ?? 0) + (u?.outputTokens ?? 0),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/** ACP stopReason → pi terminal event kind. */
const STOP_REASON_MAP: Record<string, "stop" | "length" | "aborted" | "error"> = {
  end_turn: "stop",
  max_tokens: "length",
  cancelled: "aborted",
  refusal: "error",
  max_turn_requests: "error",
};

/**
 * Merge usage snapshots. Update payloads omit fields they do not carry, and
 * those omissions must not clobber values an earlier update established.
 */
export function mergeDevinUsage(
  base: DevinUsage | undefined,
  next: DevinUsage | undefined,
): DevinUsage {
  const merged: DevinUsage = { ...(base ?? {}) };
  for (const [key, value] of Object.entries(next ?? {})) {
    if (value !== undefined) merged[key as keyof DevinUsage] = value;
  }
  return merged;
}

export interface DevinProviderDeps {
  runtime: DevinRuntimeInstance;
  service: DevinRuntimeShape;
  replay: DevinReplayStore;
  families: () => DevinModelFamily[];
  cwd: () => string;
  /** Model-facing surface for turn activity (e.g. widget updates). */
  onActivity?: (activity: DevinActivity) => void;
}

export function streamDevin(deps: DevinProviderDeps) {
  const { runtime, service, replay } = deps;

  return (
    model: Model<import("@earendil-works/pi-ai").Api>,
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
        usage: mapUsage(undefined),
        stopReason: "pending",
        timestamp: Date.now(),
      };

      let turnCleared = false;
      const clearTurn = () => {
        if (turnCleared) return;
        turnCleared = true;
        void runtime.runPromise(service.finishTurn).catch(() => {});
      };

      const fail = (message: string) => {
        output.stopReason = options?.signal?.aborted ? "aborted" : "error";
        output.errorMessage = message;
        clearTurn();
        stream.push({
          type: "error",
          reason: output.stopReason as "error" | "aborted",
          error: output,
        });
        stream.end();
      };

      try {
        stream.push({ type: "start", partial: output });

        const { prompt, images } = latestUserBatch(context);
        if (!prompt && images.length === 0) {
          throw new Error("devin: no user content found in the request context.");
        }

        const summaryRequest = isSummarizationRequest(prompt);
        if (summaryRequest) {
          const result = await runtime.runPromise(
            service.runSummaryTurn(prompt, options?.signal),
            options?.signal ? { signal: options.signal } : undefined,
          );
          output.content.push({ type: "text", text: result.text });
          stream.push({ type: "text_start", contentIndex: 0, partial: output });
          stream.push({
            type: "text_delta",
            contentIndex: 0,
            delta: result.text,
            partial: output,
          });
          stream.push({
            type: "text_end",
            contentIndex: 0,
            content: result.text,
            partial: output,
          });
          output.stopReason = "stop";
          stream.push({ type: "done", reason: "stop", message: output });
          clearTurn();
          stream.end();
          return;
        }

        const group = findDevinGroup(deps.families(), model.id);
        const concreteModelId = group
          ? resolveDevinModelRow(group, options?.reasoning).id
          : model.id;

        const blocks: ContentBlock[] = images
          .filter(
            (image): image is ImagePart & { data: string; mimeType: string } =>
              typeof image.data === "string" && typeof image.mimeType === "string",
          )
          .map((image) => ({
            type: "image" as const,
            data: image.data,
            mimeType: image.mimeType,
          }));
        blocks.push({ type: "text", text: prompt });

        const controller: DevinTurnController = await runtime.runPromise(
          service.beginStreamTurn({
            prompt,
            blocks,
            modelId: model.id,
            concreteModelId,
            cwd: deps.cwd(),
            systemPrompt: context.systemPrompt ?? undefined,
            historyBootstrap: piHistoryBootstrap(context),
            signal: options?.signal,
          }),
        );

        let usage: DevinUsage | undefined = controller.lastUsage;
        let textIndex: number | null = null;
        let textBuffer = "";
        let textMessageId: string | undefined;
        let thinkingIndex: number | null = null;
        let thinkingBuffer = "";
        let thinkingMessageId: string | undefined;
        let replayCallSeq = 0;
        const pendingTools = new Map<string, { id: string; index: number }>();

        const closeThinking = () => {
          if (thinkingIndex === null) return;
          stream.push({
            type: "thinking_end",
            contentIndex: thinkingIndex,
            content: thinkingBuffer,
            partial: output,
          });
          thinkingIndex = null;
          thinkingBuffer = "";
          thinkingMessageId = undefined;
        };

        const closeText = () => {
          if (textIndex === null) return;
          stream.push({
            type: "text_end",
            contentIndex: textIndex,
            content: textBuffer,
            partial: output,
          });
          textIndex = null;
          textBuffer = "";
          textMessageId = undefined;
        };

        const attachUsage = (u: DevinUsage | undefined) => {
          output.usage = mapUsage(u);
          calculateCost(model, output.usage);
        };

        const endWithToolUse = () => {
          closeThinking();
          closeText();
          attachUsage(usage);
          output.stopReason = "toolUse";
          stream.push({ type: "done", reason: "toolUse", message: output });
          stream.end();
        };

        /** Emit a pending card for a just-started devin tool call. */
        const emitToolStart = (view: DevinToolView): void => {
          closeText();
          closeThinking();
          const id = `devin-replay-${++replayCallSeq}`;
          const toolCall = {
            type: "toolCall" as const,
            id,
            name: "devin",
            arguments: {
              tool: view.tool ?? view.title ?? "tool",
              title: view.title ?? "tool call",
              kind: view.kind,
              summary: summarizeDevinCall(view),
            },
          };
          output.content.push(toolCall);
          const index = output.content.length - 1;
          pendingTools.set(view.id, { id, index });
          stream.push({ type: "toolcall_start", contentIndex: index, partial: output });
        };

        /** Close a tool card and record its replayed result. */
        const emitToolEnd = (view: DevinToolView): void => {
          const pending = pendingTools.get(view.id);
          const id = pending?.id ?? `devin-replay-${++replayCallSeq}`;
          replay.record(id, {
            title: view.title ?? "tool call",
            kind: view.kind,
            tool: view.tool,
            output: view.output,
            diff: view.diff,
            error: view.status === "failed" ? (view.output ?? "tool call failed") : undefined,
          });
          const toolCall = {
            type: "toolCall" as const,
            id,
            name: "devin",
            arguments: {
              tool: view.tool ?? view.title ?? "tool",
              title: view.title ?? "tool call",
              kind: view.kind,
              summary: summarizeDevinCall(view),
            },
          };
          const index = pending?.index ?? output.content.length;
          if (!pending) {
            output.content.push(toolCall);
            stream.push({ type: "toolcall_start", contentIndex: index, partial: output });
          }
          stream.push({ type: "toolcall_end", contentIndex: index, toolCall, partial: output });
          pendingTools.delete(view.id);
        };

        /**
         * Tool calls that never reached a terminal status get failed replay
         * cards so pi's toolUse loop stays consistent.
         */
        const sweepIncompleteTools = (): number => {
          const incomplete = controller.takeIncompleteTools();
          for (const view of incomplete) {
            const pending = pendingTools.get(view.id);
            const id = pending?.id ?? `devin-replay-${++replayCallSeq}`;
            replay.record(id, {
              title: view.title ?? "tool call",
              kind: view.kind,
              tool: view.tool,
              error: devinIncompleteToolError(view.title ?? "tool call"),
            });
            const index = pending?.index ?? output.content.length;
            const toolCall = pending
              ? output.content[index]
              : {
                  type: "toolCall" as const,
                  id,
                  name: "devin",
                  arguments: { tool: view.tool ?? view.title ?? "tool", title: view.title },
                };
            if (!pending) {
              output.content.push(toolCall as never);
              stream.push({ type: "toolcall_start", contentIndex: index, partial: output });
            }
            stream.push({
              type: "toolcall_end",
              contentIndex: index,
              toolCall: toolCall as never,
              partial: output,
            });
            pendingTools.delete(view.id);
          }
          return incomplete.length;
        };

        while (true) {
          const activity = await controller.next();
          if (activity === null) {
            if (sweepIncompleteTools() > 0) {
              // Defer an error result so the re-entry after pi's replay
              // toolUse terminates this turn instead of re-prompting.
              controller.deferResult({
                type: "result",
                stopReason: "interrupted",
              });
              endWithToolUse();
              return;
            }
            throw new Error("devin turn ended without a result.");
          }

          try {
            deps.onActivity?.(activity);
          } catch {
            // UI side channels are best-effort and never fail the turn.
          }

          switch (activity.type) {
            case "text": {
              if (textIndex === null || activity.messageId !== textMessageId) {
                closeText();
                closeThinking();
                output.content.push({ type: "text", text: "" });
                textIndex = output.content.length - 1;
                textBuffer = "";
                textMessageId = activity.messageId;
                stream.push({ type: "text_start", contentIndex: textIndex, partial: output });
              }
              textBuffer += activity.delta;
              const block = output.content[textIndex];
              if (block.type === "text") block.text = textBuffer;
              stream.push({
                type: "text_delta",
                contentIndex: textIndex,
                delta: activity.delta,
                partial: output,
              });
              break;
            }
            case "thought": {
              if (thinkingIndex === null || activity.messageId !== thinkingMessageId) {
                closeThinking();
                output.content.push({ type: "thinking", thinking: "" });
                thinkingIndex = output.content.length - 1;
                thinkingBuffer = "";
                thinkingMessageId = activity.messageId;
                stream.push({
                  type: "thinking_start",
                  contentIndex: thinkingIndex,
                  partial: output,
                });
              }
              thinkingBuffer += activity.delta;
              const block = output.content[thinkingIndex];
              if (block.type === "thinking") block.thinking = thinkingBuffer;
              stream.push({
                type: "thinking_delta",
                contentIndex: thinkingIndex,
                delta: activity.delta,
                partial: output,
              });
              break;
            }
            case "tool_start":
              emitToolStart(activity.view);
              break;
            case "tool_update": {
              // Progress-only updates keep the card pending; the controller
              // merges the view so the terminal update renders the full
              // picture without duplicate cards.
              const terminal =
                activity.view.status === "completed" || activity.view.status === "failed";
              if (!terminal) break;
              emitToolEnd(activity.view);
              if (pendingTools.size === 0) {
                endWithToolUse();
                return;
              }
              break;
            }
            case "plan": {
              closeText();
              closeThinking();
              const lines = activity.entries
                .map(
                  (entry) =>
                    `  ${entry.status === "completed" ? "☑" : entry.status === "in_progress" ? "◐" : "☐"} ${entry.content}`,
                )
                .join("\n");
              output.content.push({ type: "thinking", thinking: `Plan\n${lines}` });
              const index = output.content.length - 1;
              stream.push({ type: "thinking_start", contentIndex: index, partial: output });
              stream.push({
                type: "thinking_delta",
                contentIndex: index,
                delta: `Plan\n${lines}`,
                partial: output,
              });
              stream.push({
                type: "thinking_end",
                contentIndex: index,
                content: `Plan\n${lines}`,
                partial: output,
              });
              break;
            }
            case "compaction": {
              closeText();
              closeThinking();
              output.content.push({ type: "thinking", thinking: "devin compacted context" });
              const index = output.content.length - 1;
              stream.push({ type: "thinking_start", contentIndex: index, partial: output });
              stream.push({
                type: "thinking_delta",
                contentIndex: index,
                delta: "devin compacted context",
                partial: output,
              });
              stream.push({
                type: "thinking_end",
                contentIndex: index,
                content: "devin compacted context",
                partial: output,
              });
              break;
            }
            case "usage":
              usage = mergeDevinUsage(usage, activity.usage);
              controller.lastUsage = usage;
              break;
            case "stopped":
            case "mode":
            case "config":
            case "title":
            case "commands":
              break;
            case "result": {
              if (sweepIncompleteTools() > 0) {
                controller.deferResult(activity);
                endWithToolUse();
                return;
              }
              closeText();
              closeThinking();
              // The prompt response carries the canonical turn usage; merge
              // it over whatever usage_update reported during streaming.
              usage = mergeDevinUsage(usage, activity.usage);
              controller.lastUsage = usage;
              attachUsage(usage);

              const reason = STOP_REASON_MAP[activity.stopReason] ?? "error";
              if (reason === "stop" || reason === "length") {
                output.stopReason = reason;
                stream.push({ type: "done", reason, message: output });
              } else {
                output.stopReason = reason;
                if (reason === "error") {
                  output.errorMessage = `devin ended the turn with stopReason "${activity.stopReason}".`;
                }
                stream.push({ type: "error", reason, error: output });
              }
              clearTurn();
              stream.end();
              return;
            }
          }
        }
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
      }
    })();

    return stream;
  };
}
