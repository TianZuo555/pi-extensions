/**
 * Turn reducer — folds parsed agy stream events into provider-facing state.
 *
 * agy streams assistant text deltas on `agent_response` steps (the visible
 * answer — thought text is never exposed by print mode) and the final text
 * also arrives in the terminal `result` event. Tool steps stream live
 * (ACTIVE -> DONE/ERROR) and are surfaced as structured {@link AgyActivity}
 * events the provider renders as native pi tool cards.
 */

import type { AgyUsage, ParsedAgyEvent } from "./events.ts";
import { parseAgyLine } from "./events.ts";

export type AgyActivity =
  | { type: "tool_start"; stepId?: number; name: string; args: Record<string, unknown> }
  | {
      type: "tool_done";
      stepId?: number;
      name: string;
      args: Record<string, unknown>;
      output?: string;
      durationSeconds?: number;
    }
  | {
      type: "tool_error";
      stepId?: number;
      name: string;
      args: Record<string, unknown>;
      message: string;
    }
  | {
      /** Synthetic — pushed by the bridge when agy invokes a `pi__*` tool.
       * Never produced by applyEvent. */
      type: "bridge_call";
      id: string;
      name: string;
      args: Record<string, unknown>;
    }
  | {
      /** Synthetic — pushed by the runtime when a stalled agy turn is killed
       * and retried. Never produced by applyEvent. */
      type: "stall";
      /** 1-based retry number. */
      retry: number;
      maxRetries: number;
      stalledMs: number;
      toolActive: boolean;
    }
  | { type: "text"; delta: string }
  | {
      /** agy's own collapsed reasoning line — thought text is never streamed,
       * only its token count (and the response step's duration) are. */
      type: "thought";
      tokens: number;
      durationSeconds?: number;
    }
  | { type: "usage"; usage: AgyUsage }
  | {
      /** Terminal status, already normalized: anything agy did not explicitly
       * report as successful arrives as "ERROR". */
      type: "result";
      status: "OK" | "ERROR";
      response: string;
      error: string | undefined;
      usage: AgyUsage | undefined;
    };

export interface AgyTurnOutcome {
  /** Conversation id for `--conversation` resume; set by init/result. */
  conversationId: string | undefined;
  /** "UNKNOWN" until the result event lands; then "OK" or "ERROR". */
  status: "OK" | "ERROR" | "UNKNOWN";
  /** Final assistant text (empty until the result event). */
  response: string;
  /** Error message when status is ERROR. */
  error: string | undefined;
  usage: AgyUsage | undefined;
  /** Structured activity events, appended as the stream unfolds. */
  activities: AgyActivity[];
  /** True once the result event has been seen. */
  finished: boolean;
}

export function newTurnOutcome(): AgyTurnOutcome {
  return {
    conversationId: undefined,
    status: "UNKNOWN",
    response: "",
    error: undefined,
    usage: undefined,
    activities: [],
    finished: false,
  };
}

export type { AgyUsage };
/** Fold one parsed event into the outcome; returns new activity events (if any). */
export function applyEvent(outcome: AgyTurnOutcome, event: ParsedAgyEvent): AgyActivity[] {
  const activities: AgyActivity[] = [];
  switch (event.kind) {
    case "init": {
      outcome.conversationId = event.conversationId ?? outcome.conversationId;
      break;
    }
    case "step": {
      const step = event.step;
      if (step.conversation_id && !outcome.conversationId) {
        outcome.conversationId = step.conversation_id;
      }
      if (step.step_type === "tool") {
        const name = step.tool_name ?? step.tool_info?.name ?? "tool";
        if (step.state === "ACTIVE") {
          activities.push({
            type: "tool_start",
            stepId: step.step_index,
            name,
            args: step.tool_info?.parameters ?? {},
          });
        } else if (step.state === "DONE") {
          activities.push({
            type: "tool_done",
            stepId: step.step_index,
            name,
            // agy nests tool output under tool_info on DONE steps.
            output: step.output ?? step.tool_info?.output,
            durationSeconds:
              typeof step.duration_seconds === "number" ? step.duration_seconds : undefined,
            // Kept so call_mcp_tool completions can be correlated with the
            // bridged server (ServerName) by the provider.
            args: step.tool_info?.parameters ?? {},
          });
        } else if (step.state === "ERROR") {
          // agy puts the error detail under tool_info on ERROR steps (e.g.
          // generate_image 429 rate limits); step.error is often absent.
          const message = step.error?.message ?? step.tool_info?.error?.message ?? "tool error";
          activities.push({
            type: "tool_error",
            stepId: step.step_index,
            name,
            args: step.tool_info?.parameters ?? {},
            message: message.replace(/\s+/g, " ").slice(0, 160),
          });
        }
      } else if (step.step_type === "agent_response") {
        // agent_response steps stream the visible answer text as continuation
        // chunks on ACTIVE steps plus a final chunk on DONE. agy never exposes
        // thought text in print mode; thinking_tokens in usage is the only
        // reasoning trace.
        if (typeof step.text_delta === "string" && step.text_delta) {
          activities.push({ type: "text", delta: step.text_delta });
        }
        if (step.usage) {
          // Running per-response usage; the result event carries the totals.
          outcome.usage = step.usage;
          activities.push({ type: "usage", usage: step.usage });
          const thoughtTokens = step.usage.thinking_tokens;
          if (step.state === "DONE" && typeof thoughtTokens === "number" && thoughtTokens > 0) {
            activities.push({
              type: "thought",
              tokens: thoughtTokens,
              durationSeconds:
                typeof step.duration_seconds === "number" ? step.duration_seconds : undefined,
            });
          }
        }
      }
      break;
    }
    case "result": {
      const result = event.result;
      outcome.finished = true;
      outcome.conversationId = result.conversation_id ?? outcome.conversationId;
      // Fail closed: only an explicitly successful status completes the turn.
      // agy >= 1.1.22 reports SUCCESS (older builds: OK); FAILURE, CANCELLED,
      // and TIMEOUT all exist too, and an unrecognized status must never be
      // rendered as a normal answer.
      outcome.status = result.status === "SUCCESS" || result.status === "OK" ? "OK" : "ERROR";
      outcome.response = result.response ?? "";
      outcome.error = result.error;
      outcome.usage = result.usage ?? outcome.usage;
      activities.push({
        type: "result",
        status: outcome.status,
        response: outcome.response,
        error: outcome.error,
        usage: outcome.usage,
      });
      break;
    }
    case "unknown":
      break;
  }
  outcome.activities.push(...activities);
  return activities;
}

/** Parse a full NDJSON document (test helper) and reduce it. */
export function reduceAgyStream(text: string): AgyTurnOutcome {
  const outcome = newTurnOutcome();
  for (const line of text.split("\n")) {
    applyEvent(outcome, parseAgyLine(line));
  }
  return outcome;
}
