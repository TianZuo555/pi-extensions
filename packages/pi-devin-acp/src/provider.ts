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

import { randomUUID } from "node:crypto";
import {
  calculateCost,
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import type { DevinPromptRequest, DevinRuntimeInstance, DevinRuntimeShape } from "./runtime.ts";
import {
  TERMINAL_TOOL_STATUSES,
  type DevinActivity,
  type DevinTurnController,
  type DevinUsage,
} from "./turn.ts";
import type { DevinReplayStore } from "../lib/replay.ts";
import { devinBackgroundToolNote, devinIncompleteToolError } from "../lib/prompt.ts";
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
function latestUserBatch(context: TranscriptContext): {
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
export function piHistoryBootstrap(context: TranscriptContext): string | undefined {
  const { start: latestUser } = latestUserBatch(context);
  if (latestUser <= 0) return undefined;

  const entries: string[] = [];
  for (const raw of context.messages.slice(0, latestUser)) {
    if (raw.role === "system") continue;
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
export function mapUsage(
  u: DevinUsage | undefined,
  contextWindow?: number,
): AssistantMessage["usage"] {
  // Devin's inputTokens is the TOTAL prompt size and already includes
  // cache reads/writes; pi's usage.input is the non-cached portion (Anthropic
  // convention). Passing the total through double-counts cache reads and
  // trips pi's per-turn "Cache miss" detector.
  const cached = u?.cachedReadTokens ?? 0;
  const written = u?.cachedWriteTokens ?? 0;
  return {
    input: Math.max(0, (u?.inputTokens ?? 0) - cached - written),
    output: u?.outputTokens ?? 0,
    reasoning: undefined,
    cacheRead: cached,
    cacheWrite: written,
    // pi reads totalTokens as "context occupancy" — the compaction
    // threshold and footer gauge both consume it — so report devin's real
    // fill scaled into this model's window, never the billed prompt sums
    // (a multi-request segment's sum would read as a bogus overflow).
    totalTokens:
      contextOccupancyTokens(u, contextWindow) ?? (u?.inputTokens ?? 0) + (u?.outputTokens ?? 0),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/** Price the original counters before adapting them to pi's overflow heuristic. */
function billedUsage(
  u: DevinUsage | undefined,
  model: Model<import("@earendil-works/pi-ai").Api>,
): AssistantMessage["usage"] {
  const usage = mapUsage(u, model.contextWindow);
  calculateCost(model, usage);
  // pi treats input + cacheRead as one request's prompt, but our message
  // can bill many requests. Keep aggregate tokens out of that heuristic.
  // cacheWrite is a synthetic overflow bucket here, NOT a pricing input:
  // cost above retains the original input/read/write attribution.
  if (Number.isFinite(model.contextWindow) && model.contextWindow > 0) {
    const excess = Math.max(0, usage.input + usage.cacheRead - model.contextWindow);
    const reads = Math.min(excess, usage.cacheRead);
    usage.cacheRead -= reads;
    usage.input -= excess - reads;
    usage.cacheWrite += excess;
  }
  return usage;
}

/**
 * Devin's contextUsed scaled into the registered model's window units.
 * When devin's contextSize differs from the model's contextWindow, scaling
 * preserves the true fill ratio so pi's percent-of-window math stays right.
 */
function contextOccupancyTokens(
  u: DevinUsage | undefined,
  contextWindow?: number,
): number | undefined {
  const used = u?.contextUsed;
  if (used === undefined) return undefined;
  const size = u?.contextSize;
  if (size === undefined || size <= 0 || contextWindow === undefined || contextWindow <= 0) {
    return Math.round(used);
  }
  return Math.round((used * contextWindow) / size);
}

/** ACP stopReason → pi terminal event kind. */
const STOP_REASON_MAP: Record<string, "stop" | "length" | "aborted" | "error"> = {
  end_turn: "stop",
  max_tokens: "length",
  cancelled: "aborted",
  refusal: "error",
  max_turn_requests: "error",
};

export interface DevinProviderDeps {
  runtime: DevinRuntimeInstance;
  service: DevinRuntimeShape;
  replay: DevinReplayStore;
  families: () => DevinModelFamily[];
  cwd: () => string;
  /** Whether /devin-fast selected the priority serving tier. */
  fast?: () => boolean;
  /** Model-facing surface for turn activity (e.g. widget updates). */
  onActivity?: (activity: DevinActivity) => void;
}

/**
 * Adapt pi's payload hook to the ACP prompt. pi hands custom providers the
 * same `onPayload` callback its built-in HTTP providers call, so extensions
 * listening on `before_provider_request` see the outgoing prompt. ACP has no
 * HTTP response, so `onResponse` stays unclaimed.
 */
export function promptTransformFromPayloadHook(
  onPayload: SimpleStreamOptions["onPayload"],
  model: Model<import("@earendil-works/pi-ai").Api>,
): ((request: DevinPromptRequest) => Promise<ContentBlock[] | undefined>) | undefined {
  if (!onPayload) return undefined;
  return async (request) => {
    const replaced = await onPayload(request, model);
    const prompt = (replaced as { prompt?: unknown } | undefined)?.prompt;
    return Array.isArray(prompt) ? (prompt as ContentBlock[]) : undefined;
  };
}

export function streamDevin(deps: DevinProviderDeps) {
  const { runtime, service, replay } = deps;

  return (
    model: Model<import("@earendil-works/pi-ai").Api>,
    context: TranscriptContext,
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

      let turnController: DevinTurnController | undefined;
      let turnCleared = false;
      /** Priced by the resolved devin row: /devin-fast tiers cost more. */
      let billingModel = model;
      const clearTurn = () => {
        if (turnCleared) return;
        turnCleared = true;
        void runtime.runPromise(service.finishTurn).catch(() => {});
      };

      const fail = (message: string) => {
        // On failure, account for whatever turn usage was observed but not
        // yet persisted on an earlier segment.
        output.usage = billedUsage(turnController?.takeBillableUsage(), billingModel);
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

        const group = findDevinGroup(deps.families(), model.id);
        const resolvedRow = group
          ? resolveDevinModelRow(group, options?.reasoning ?? "off", deps.fast?.() ?? false)
          : undefined;
        const concreteModelId = resolvedRow?.id ?? model.id;
        // The registered group prices the standard tier; the selected row
        // bills at its own rates (a /devin-fast tier costs more).
        if (resolvedRow) {
          billingModel = { ...model, cost: { ...resolvedRow.cost } };
        }

        const summaryRequest = isSummarizationRequest(prompt);
        if (summaryRequest) {
          const result = await runtime.runPromise(
            service.runSummaryTurn(
              prompt,
              options?.signal,
              concreteModelId,
              promptTransformFromPayloadHook(options?.onPayload, model),
            ),
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
          // Compaction/summary turns consume tokens too; record their usage.
          output.usage = billedUsage(result.usage, billingModel);
          output.stopReason = "stop";
          stream.push({ type: "done", reason: "stop", message: output });
          clearTurn();
          stream.end();
          return;
        }

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

        const systemPrompt = context.messages.some((message) => message.role === "system")
          ? getCurrentSystemPrompt(context.messages)
          : undefined;
        const controller: DevinTurnController = await runtime.runPromise(
          service.beginStreamTurn({
            prompt,
            blocks,
            modelId: model.id,
            concreteModelId,
            modelCost: billingModel.cost,
            cwd: deps.cwd(),
            systemPrompt,
            historyBootstrap: piHistoryBootstrap(context),
            signal: options?.signal,
            transformPrompt: promptTransformFromPayloadHook(options?.onPayload, model),
          }),
          options?.signal ? { signal: options.signal } : undefined,
        );

        turnController = controller;
        // Re-attachment keeps the original ACP model even if /devin-fast or
        // the catalog changed between replay segments. Bill at that turn's
        // captured rates; the new selection applies only to the next turn.
        billingModel = { ...model, cost: controller.modelCost };
        let textIndex: number | null = null;
        let textBuffer = "";
        let textMessageId: string | undefined;
        let thinkingIndex: number | null = null;
        let thinkingBuffer = "";
        let thinkingMessageId: string | undefined;
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

        const attachUsage = () => {
          output.usage = billedUsage(controller.takeBillableUsage(), billingModel);
        };

        const endWithToolUse = () => {
          closeThinking();
          closeText();
          // Segments bill only the turn's not-yet-persisted share: the log
          // sums to the observed request totals while the footer fills live.
          attachUsage();
          output.stopReason = "toolUse";
          stream.push({ type: "done", reason: "toolUse", message: output });
          stream.end();
        };

        /** Emit a pending card for a just-started devin tool call. */
        const emitToolStart = (view: DevinToolView): void => {
          closeText();
          closeThinking();
          const id = `devin-replay-${randomUUID()}`;
          const toolCall = {
            type: "toolCall" as const,
            id,
            name: "devin",
            arguments: {
              tool: view.tool ?? view.title ?? "tool",
              title: view.title ?? "tool call",
              ...(view.kind ? { kind: view.kind } : {}),
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
          const id = pending?.id ?? `devin-replay-${randomUUID()}`;
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
              ...(view.kind ? { kind: view.kind } : {}),
              summary: summarizeDevinCall(view),
            },
          };
          const index = pending?.index ?? output.content.length;
          if (!pending) {
            output.content.push(toolCall);
            stream.push({ type: "toolcall_start", contentIndex: index, partial: output });
          } else {
            // pi persists `output.content`, not the toolcall_end payload, so the
            // card's stored arguments must be the terminal view.
            output.content[index] = toolCall;
          }
          stream.push({ type: "toolcall_end", contentIndex: index, toolCall, partial: output });
          pendingTools.delete(view.id);
        };

        /**
         * Tool calls that never reached a terminal status get failed replay
         * cards — or a neutral note for still-running background shells — so
         * pi's toolUse loop stays consistent.
         */
        const sweepIncompleteTools = (): number => {
          const incomplete = controller.takeIncompleteTools();
          for (const view of incomplete) {
            const pending = pendingTools.get(view.id);
            const id = pending?.id ?? `devin-replay-${randomUUID()}`;
            if (view.background) {
              // A detached shell outliving the turn is normal — replay it as a
              // note, not a failure.
              const note = devinBackgroundToolNote(view.shellId);
              replay.record(id, {
                title: view.title ?? "tool call",
                kind: view.kind,
                tool: view.tool,
                output: view.output ? `${view.output}\n${note}` : note,
              });
            } else {
              replay.record(id, {
                title: view.title ?? "tool call",
                kind: view.kind,
                tool: view.tool,
                error: devinIncompleteToolError(view.title ?? "tool call"),
              });
            }
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
              // Defer a terminal result so the re-entry after pi's replay
              // toolUse ends this turn instead of re-prompting. It must be a
              // stop reason pi maps to "stop"; anything else surfaces a
              // spurious error for a turn that already rendered its cards.
              controller.deferResult({
                type: "result",
                stopReason: "end_turn",
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
                closeText();
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
            case "tool_update": {
              if (activity.type === "tool_start") emitToolStart(activity.view);
              // Progress-only updates keep the card pending; the controller
              // merges the view so the terminal update renders the full
              // picture without duplicate cards.
              const terminal = TERMINAL_TOOL_STATUSES.has(activity.view.status ?? "");
              if (!terminal) break;
              emitToolEnd(activity.view);
              if (pendingTools.size === 0) {
                endWithToolUse();
                return;
              }
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
              controller.recordUsage(activity.usage);
              break;
            case "stopped":
            case "retry":
            case "mode":
            case "config":
            case "title":
            case "commands":
            case "plan":
              break;
            case "result": {
              if (sweepIncompleteTools() > 0) {
                controller.deferResult(activity);
                endWithToolUse();
                return;
              }
              closeText();
              closeThinking();
              // The prompt response echoes the last request's usage — the
              // controller dedups it — then bills whatever remains unbilled.
              controller.recordUsage(activity.usage);
              attachUsage();

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
