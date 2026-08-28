/**
 * streamSimple adapter — runs one agy turn per pi request and translates the
 * reduced outcome into pi AssistantMessageEvents.
 *
 * agy streams response text (reasoning included — agy writes it inline as
 * markdown) as text_delta continuation chunks on agent_response steps; these
 * stream live into pi's text channel. agy tool steps render as native pi
 * tool cards: display-only steps emit a pending card on ACTIVE, then the
 * provider records their result on completion and ends the assistant message
 * with stopReason "toolUse". pi executes the replay-only `agy` wrapper and
 * re-invokes this adapter, which re-attaches to the still-running agy turn via
 * the runtime's turn controller. Native read-only steps still wait for DONE
 * so failed reads are never re-executed as successful pi tools.
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
import { type AgyPiBridge, resolveBridgeResultsFromContext } from "../lib/bridge.ts";
import type { AgyActivity, AgyUsage } from "../lib/reducer.ts";
import type { AgyReplayStore } from "../lib/replay.ts";
import { mapAgyToolToNative } from "../lib/native-tools.ts";
import { restoredPiContextPrompt, WRAPPER_TOOL_NAME } from "../lib/prompt.ts";
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

const MAX_RESTORED_HISTORY_CHARS = 24_000;

/** Serialize the active pi branch before its latest user request. */
export function piHistoryBootstrap(context: Context): string | undefined {
  let latestUser = -1;
  for (let i = context.messages.length - 1; i >= 0; i--) {
    if ((context.messages[i] as { role?: string }).role === "user") {
      latestUser = i;
      break;
    }
  }
  if (latestUser <= 0) return undefined;

  const entries: string[] = [];
  for (const raw of context.messages.slice(0, latestUser)) {
    const message = raw as {
      role?: string;
      toolName?: string;
      content?: unknown;
    };
    const parts = Array.isArray(message.content) ? message.content : [];
    const rendered: string[] = [];
    for (const part of parts as Array<Record<string, unknown>>) {
      if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) {
        rendered.push(part.text);
      } else if (part?.type === "toolCall" && typeof part.name === "string") {
        const args = JSON.stringify(part.arguments ?? {});
        rendered.push(`[tool call: ${part.name}${args === "{}" ? "" : ` ${args}`}]`);
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
  const bounded =
    transcript.length <= MAX_RESTORED_HISTORY_CHARS
      ? transcript
      : `[Earlier history omitted]\n${transcript.slice(-MAX_RESTORED_HISTORY_CHARS)}`;
  return restoredPiContextPrompt(bounded);
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

/**
 * pi's compaction and branch summarization arrive as standalone requests
 * whose only user message is `<conversation>\n…</conversation>\n\n` plus
 * instructions. The agy turn that summarizes it reports the transcript's
 * cached re-reads as usage (observed: 456k context churning 23M cache-read
 * tokens), and agy is subscription-billed anyway — so the resulting
 * per-token dollar figure is fictional. Report no usage for these requests
 * so the `[compaction]` card never shows an inflated bill.
 */
export function isSummarizationRequest(prompt: string): boolean {
  return prompt.startsWith("<conversation>\n");
}

const OVERFLOW_PATTERN = /context (length|window|size).*(exceed|limit)|exceeds.*context/i;

/**
 * agy's own recovery notice: its stream broke mid-turn, agy retried, and the
 * response was still delivered. Only this error may downgrade an ERROR result
 * to success (and only with response text present) — any other ERROR stays a
 * failure so truncated or empty answers never pass silently.
 */
const RECOVERED_INTERRUPTION_PATTERN = /stream was interrupted/i;

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

function agyToolStepKey(activity: { stepId?: number; name: string }): string {
  return activity.stepId === undefined ? `name:${activity.name}` : `step:${activity.stepId}`;
}

/**
 * True for agy `call_mcp_tool` steps that target our own bridge server.
 * Those calls surface as synthetic bridge_call activities (emitted as the
 * real pi tool), so the raw call_mcp_tool step must not render a duplicate
 * display-only card. MCP calls against OTHER servers render normally.
 */
function isBridgedMcpStep(
  activity: {
    name: string;
    args: Record<string, unknown>;
  },
  serverName: string,
): boolean {
  return activity.name === "call_mcp_tool" && activity.args?.ServerName === serverName;
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
  /**
   * Extra prompt text for bootstrap sends (fresh agy process) — used to
   * inject the pi skill catalog. Evaluated once per request.
   */
  getBootstrapSuffix?: () => string | undefined,
  /** Whether a pi tool name is currently active — native re-execution
   * toolCalls are only emitted for active tools (else the wrapper). */
  isActiveTool: (name: string) => boolean = () => true,
  /** Live activity side channel for task/artifact UI that must not wait for
   * the provider message to settle. */
  onActivity?: (activity: AgyActivity) => void,
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
        const unbillable = isSummarizationRequest(prompt);

        const controller = await runtime.runPromise(
          service.beginStreamTurn({
            prompt,
            historyBootstrap: piHistoryBootstrap(context),
            bootstrapSuffix: getBootstrapSuffix?.(),
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
        let textIndex: number | null = null;
        let textBuffer = "";
        type PendingReplayTool = {
          id: string;
          index: number;
          toolCall: {
            type: "toolCall";
            id: string;
            name: string;
            arguments: { tool: string; input: Record<string, unknown> };
          };
        };
        const pendingReplayTools = new Map<string, PendingReplayTool>();

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

        const attachUsage = (u: AgyUsage | undefined, final: boolean) => {
          if (unbillable) return; // summarization turns carry no billable usage
          output.usage = mapUsage(controller.claimUsage(u, final));
          calculateCost(model, output.usage);
        };

        const endWithToolUse = () => {
          closeText();
          attachUsage(usage, false);
          output.stopReason = "toolUse";
          stream.push({ type: "done", reason: "toolUse", message: output });
          stream.end();
        };

        /**
         * Start display-only tools as soon as agy reports ACTIVE. This makes
         * `run_command` render as a pending bash card before a `sleep`, test,
         * or server command finishes. Native read-only calls still wait for
         * DONE because a failed agy read must replay its error, not re-run.
         */
        const emitStartedReplayTool = (
          activity: Extract<AgyActivity, { type: "tool_start" }>,
        ): void => {
          const key = agyToolStepKey(activity);
          if (pendingReplayTools.has(key)) return;
          const native = mapAgyToolToNative(activity.name, activity.args);
          if (native && isActiveTool(native.tool)) return;
          const id = `agy-replay-${++replayCallSeq}`;
          const toolCall = {
            type: "toolCall" as const,
            id,
            name: WRAPPER_TOOL_NAME,
            arguments: { tool: activity.name, input: activity.args },
          };
          output.content.push(toolCall);
          const index = output.content.length - 1;
          pendingReplayTools.set(key, { id, index, toolCall });
          stream.push({ type: "toolcall_start", contentIndex: index, partial: output });
        };

        const recordReplayResult = (
          id: string,
          activity:
            | Extract<AgyActivity, { type: "tool_done" }>
            | Extract<AgyActivity, { type: "tool_error" }>,
        ) => {
          replay.record(
            id,
            activity.type === "tool_error"
              ? { agyTool: activity.name, error: activity.message }
              : {
                  agyTool: activity.name,
                  output: activity.output,
                  durationSeconds: activity.durationSeconds,
                },
          );
        };

        const emitFinishedTool = (
          activity:
            | Extract<Awaited<ReturnType<typeof controller.next>>, { type: "tool_done" }>
            | Extract<Awaited<ReturnType<typeof controller.next>>, { type: "tool_error" }>,
        ) => {
          closeText();
          const key = agyToolStepKey(activity);
          const pending = pendingReplayTools.get(key);
          if (pending) {
            pending.toolCall.arguments = { tool: activity.name, input: activity.args };
            recordReplayResult(pending.id, activity);
            stream.push({
              type: "toolcall_end",
              contentIndex: pending.index,
              toolCall: pending.toolCall,
              partial: output,
            });
            pendingReplayTools.delete(key);
            return;
          }

          // The tool name cannot change after toolcall_start. Wait for the
          // terminal event before choosing native execution so agy failures
          // always replay their real error instead of being re-executed.
          const native =
            activity.type === "tool_done"
              ? mapAgyToolToNative(activity.name, activity.args)
              : undefined;
          const effective = native && isActiveTool(native.tool) ? native : undefined;
          const id = `agy-${effective ? "native" : "replay"}-${++replayCallSeq}`;
          const toolCall = {
            type: "toolCall" as const,
            id,
            name: effective ? effective.tool : WRAPPER_TOOL_NAME,
            arguments: effective ? effective.args : { tool: activity.name, input: activity.args },
          };
          if (!effective) recordReplayResult(id, activity);
          output.content.push(toolCall);
          const index = output.content.length - 1;
          stream.push({ type: "toolcall_start", contentIndex: index, partial: output });
          stream.push({
            type: "toolcall_end",
            contentIndex: index,
            toolCall,
            partial: output,
          });
        };

        const emitIncompleteTools = (resultError?: string): number => {
          const incomplete = controller
            .takeIncompleteTools()
            .filter((activity) => !isBridgedMcpStep(activity, bridge.serverName));
          for (const activity of incomplete) {
            const key = agyToolStepKey(activity);
            const pending = pendingReplayTools.get(key);
            const id = pending?.id ?? `agy-replay-${++replayCallSeq}`;
            replay.record(id, {
              agyTool: activity.name,
              error: agyIncompleteToolError(activity.name, resultError),
            });
            const toolCall = pending?.toolCall ?? {
              type: "toolCall" as const,
              id,
              name: WRAPPER_TOOL_NAME,
              arguments: { tool: activity.name, input: activity.args },
            };
            toolCall.arguments = { tool: activity.name, input: activity.args };
            const index = pending?.index ?? output.content.length;
            if (!pending) {
              output.content.push(toolCall);
              stream.push({ type: "toolcall_start", contentIndex: index, partial: output });
            }
            stream.push({
              type: "toolcall_end",
              contentIndex: index,
              toolCall,
              partial: output,
            });
            pendingReplayTools.delete(key);
          }
          return incomplete.length;
        };

        /**
         * A bridged pi tool must execute immediately or agy blocks waiting for
         * its result. If another agy command is still ACTIVE, close its live
         * card as "running" before yielding to pi; its eventual terminal event
         * will render a separate completion card after re-attachment.
         */
        const closePendingForBridge = () => {
          for (const [key, pending] of pendingReplayTools) {
            const tool = pending.toolCall.arguments.tool;
            replay.record(pending.id, {
              agyTool: tool,
              output: "Started and still running. Track live status and output with /agy-tasks.",
            });
            stream.push({
              type: "toolcall_end",
              contentIndex: pending.index,
              toolCall: pending.toolCall,
              partial: output,
            });
            pendingReplayTools.delete(key);
          }
        };

        while (true) {
          const activity = await controller.next();
          if (activity === null) {
            if (emitIncompleteTools() > 0) {
              endWithToolUse();
              return;
            }
            throw new Error("agy turn ended without a result event.");
          }

          try {
            onActivity?.(activity);
          } catch {
            // UI side channels are best-effort and must never fail the turn.
          }
          switch (activity.type) {
            case "usage": {
              usage = activity.usage;
              break;
            }
            case "tool_start": {
              if (isBridgedMcpStep(activity, bridge.serverName)) break;
              closeText();
              emitStartedReplayTool(activity);
              break;
            }
            case "tool_done": {
              if (isBridgedMcpStep(activity, bridge.serverName)) break;
              emitFinishedTool(activity);
              if (pendingReplayTools.size === 0) {
                endWithToolUse();
                return;
              }
              break;
            }
            case "tool_error": {
              if (isBridgedMcpStep(activity, bridge.serverName)) break;
              emitFinishedTool(activity);
              if (pendingReplayTools.size === 0) {
                endWithToolUse();
                return;
              }
              break;
            }
            case "bridge_call": {
              // agy invoked a pi tool through the bridge: end this message
              // with a toolUse for the REAL pi tool so pi executes it with
              // full ownership (hooks, permissions, rendering, abort).
              closeText();
              closePendingForBridge();
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
              if (emitIncompleteTools(activity.error) > 0) {
                endWithToolUse();
                return;
              }
              attachUsage(activity.usage, true);

              if (activity.response) {
                if (textIndex !== null) {
                  // Deltas already streamed this block; snap it to the
                  // authoritative final text in case of drift so both the
                  // message content and the text_end event agree.
                  if (textBuffer !== activity.response) {
                    const block = output.content[textIndex];
                    if (block.type === "text") block.text = activity.response;
                    textBuffer = activity.response;
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

              const hasResponse =
                Boolean(activity.response?.trim()) ||
                output.content.some((c) => c.type === "text" && Boolean(c.text.trim()));

              // agy flags auto-recovered stream interruptions as ERROR even
              // though the full response was delivered; pi aborts the run on
              // stopReason "error", so complete those turns normally instead.
              const recovered =
                hasResponse && RECOVERED_INTERRUPTION_PATTERN.test(activity.error ?? "");

              if (activity.status === "ERROR" && !recovered) {
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
