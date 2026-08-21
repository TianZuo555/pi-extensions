/**
 * streamSimple adapter — runs one agy turn per pi request and translates the
 * reduced outcome into pi AssistantMessageEvents.
 *
 * agy streams response text (reasoning included — agy writes it inline as
 * markdown) as text_delta continuation chunks on agent_response steps; these
 * stream live into pi's text channel. agy tool steps render as native pi
 * tool cards: when a tool step completes, the provider records the result in
 * the replay store and ends the assistant message with stopReason
 * "toolUse", so pi renders the card, executes the display-only `agy`
 * wrapper tool, and re-invokes this adapter — which re-attaches to the
 * still-running agy turn via the runtime's turn controller.
 */

import {
  calculateCost,
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type ThinkingLevel,
} from "@earendil-works/pi-ai";
import type { AgyEffort } from "../lib/agy-client.ts";
import { BRIDGE_SERVER_NAME, type AgyPiBridge, resolveBridgeResultsFromContext } from "../lib/bridge.ts";
import type { AgyUsage } from "../lib/reducer.ts";
import { AgyReplayStore } from "../lib/replay.ts";
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

/** Map agy usage fields to pi usage fields. */
export function mapUsage(u: AgyUsage | undefined): AssistantMessage["usage"] {
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

/**
 * Error recorded for an agy tool call that never reached DONE. agy runs
 * long-lived commands as background tasks (its own manage_task system); in
 * headless print mode the step never completes and the turn ends with
 * "timeout waiting for response" while the spawned process keeps running.
 */
export function agyIncompleteToolError(tool: string, resultError?: string): string {
  if (
    tool === "run_command" &&
    (!resultError || /timeout waiting for response/i.test(resultError))
  ) {
    return (
      "agy started this command as a background task, which headless agy cannot await " +
      "(\u201ctimeout waiting for response\u201d). The process keeps running after the turn \u2014 " +
      "follow up in a later message to have agy check the task\u2019s output, or run " +
      "long-lived processes with pi\u2019s own bash instead."
    );
  }
  return "agy tool call did not complete.";
}

/** Map pi's thinking level to agy's `--effort` (low|medium|high). */
export function mapThinkingToEffort(level: ThinkingLevel | undefined): AgyEffort {
  if (level === "low" || level === "minimal") return "low";
  if (level === "medium") return "medium";
  return "high"; // high, xhigh, max, and undefined default
}

let replayCallSeq = 0;

/**
 * True for agy `call_mcp_tool` steps that target our own bridge server.
 * Those calls surface as synthetic bridge_call activities (emitted as the
 * real pi tool), so the raw call_mcp_tool step must not render a duplicate
 * display-only card. MCP calls against OTHER servers render normally.
 */
function isBridgedMcpStep(activity: {
  name: string;
  args: Record<string, unknown>;
}): boolean {
  return activity.name === "call_mcp_tool" && activity.args?.["ServerName"] === BRIDGE_SERVER_NAME;
}

/** Build the streamSimple implementation bound to the runtime service. */
export function streamAntigravity(
  runtime: AntigravityRuntimeInstance,
  service: AntigravityRuntimeShape,
  replay: AgyReplayStore,
  /** Pi-tool bridge; pass a detached AgyPiBridge when the bridge is off. */
  bridge: AgyPiBridge,
  /** Called when a turn fully settles (stop or error) — the moment an agy
   * background task may have been created. */
  onSettled?: () => void,
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
        usage: mapUsage(undefined),
        stopReason: "pending",
        timestamp: Date.now(),
      };

      const clearTurn = () => {
        runtime.runPromise(service.finishTurn).catch(() => {});
        onSettled?.();
      };

      const fail = (message: string) => {
        const hint = message.includes("permission check failed for command")
          ? " — add an allow-rule (e.g. command(*)) to permissions.allow in ~/.gemini/antigravity-cli/settings.json for autonomous agy turns"
          : "";
        output.stopReason = options?.signal?.aborted ? "aborted" : "error";
        output.errorMessage = `${message}${hint}`;
        clearTurn();
        stream.push({ type: "error", reason: output.stopReason, error: output });
        stream.end();
      };

      try {
        stream.push({ type: "start", partial: output });

        const { prompt } = latestUserPrompt(context);
        if (!prompt) {
          throw new Error("antigravity: no user text found in the request context.");
        }

        const controller = await runtime.runPromise(
          service.beginStreamTurn({
            prompt,
            modelId: model.id,
            effort: mapThinkingToEffort(options?.reasoning),
            signal: options?.signal,
          }),
        );

        // Refresh the exposed-tool snapshot per request and hand back the
        // results of bridged tools pi executed since the previous request.
        bridge.refreshTools();
        resolveBridgeResultsFromContext(bridge, context.messages);

        let usage: AgyUsage | undefined;
        let open: { id: string; name: string } | undefined;
        let textIndex: number | null = null;
        let textBuffer = "";

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
        };

        const endWithToolUse = () => {
          closeText();
          output.usage = mapUsage(usage);
          calculateCost(model, output.usage);
          output.stopReason = "toolUse";
          stream.push({ type: "done", reason: "toolUse", message: output });
          stream.end();
        };

        while (true) {
          const activity = await controller.next();
          if (activity === null) {
            if (open) {
              // The agy stream ended while a tool call was still open.
              replay.record(open.id, {
                agyTool: open.name,
                error: agyIncompleteToolError(open.name),
              });
              endWithToolUse();
              return;
            }
            throw new Error("agy turn ended without a result event.");
          }

          switch (activity.type) {
            case "usage": {
              usage = activity.usage;
              break;
            }
            case "tool_start": {
              if (isBridgedMcpStep(activity)) break;
              closeText();
              const id = `agy-replay-${++replayCallSeq}`;
              const toolCall = {
                type: "toolCall" as const,
                id,
                name: "agy",
                arguments: { tool: activity.name, input: activity.args },
              };
              output.content.push(toolCall);
              const index = output.content.length - 1;
              stream.push({ type: "toolcall_start", contentIndex: index, partial: output });
              stream.push({
                type: "toolcall_end",
                contentIndex: index,
                toolCall,
                partial: output,
              });
              open = { id, name: activity.name };
              break;
            }
            case "tool_done": {
              if (!open || isBridgedMcpStep(activity)) break;
              replay.record(open.id, {
                agyTool: activity.name,
                output: activity.output,
                durationSeconds: activity.durationSeconds,
              });
              endWithToolUse();
              return;
            }
            case "tool_error": {
              if (!open || isBridgedMcpStep(activity)) break;
              replay.record(open.id, { agyTool: activity.name, error: activity.message });
              endWithToolUse();
              return;
            }
            case "bridge_call": {
              // agy invoked a pi tool through the bridge: end this message
              // with a toolUse for the REAL pi tool so pi executes it with
              // full ownership (hooks, permissions, rendering, abort).
              closeText();
              const toolCall = {
                type: "toolCall" as const,
                id: activity.id,
                name: activity.name,
                arguments: activity.args,
              };
              output.content.push(toolCall);
              const index = output.content.length - 1;
              stream.push({ type: "toolcall_start", contentIndex: index, partial: output });
              stream.push({
                type: "toolcall_end",
                contentIndex: index,
                toolCall,
                partial: output,
              });
              endWithToolUse();
              return;
            }
            case "text": {
              if (textIndex === null) {
                output.content.push({ type: "text", text: "" });
                textIndex = output.content.length - 1;
                textBuffer = "";
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
            case "result": {
              if (open) {
                replay.record(open.id, {
                  agyTool: open.name,
                  error: agyIncompleteToolError(open.name, activity.error),
                });
                endWithToolUse();
                return;
              }
              output.usage = mapUsage(activity.usage);
              calculateCost(model, output.usage);

              if (activity.response) {
                if (textIndex !== null) {
                  // Deltas already streamed this block; snap it to the
                  // authoritative final text in case of drift.
                  if (textBuffer !== activity.response) {
                    const block = output.content[textIndex];
                    if (block.type === "text") block.text = activity.response;
                  }
                  closeText();
                } else {
                  output.content.push({ type: "text", text: activity.response });
                  const idx = output.content.length - 1;
                  stream.push({ type: "text_start", contentIndex: idx, partial: output });
                  stream.push({
                    type: "text_delta",
                    contentIndex: idx,
                    delta: activity.response,
                    partial: output,
                  });
                  stream.push({
                    type: "text_end",
                    contentIndex: idx,
                    content: activity.response,
                    partial: output,
                  });
                }
              } else {
                closeText();
              }

              if (activity.status === "ERROR") {
                const message = activity.error || "agy reported an error for this turn.";
                output.stopReason = "error";
                output.errorMessage = OVERFLOW_PATTERN.test(message)
                  ? `context_length_exceeded: ${message}`
                  : message;
                stream.push({ type: "error", reason: "error", error: output });
              } else {
                output.stopReason = "stop";
                stream.push({ type: "done", reason: "stop", message: output });
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
