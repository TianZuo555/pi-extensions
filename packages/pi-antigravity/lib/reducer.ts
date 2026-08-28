/**
 * Turn reducer — folds parsed agy stream events into provider-facing state.
 *
 * agy emits no assistant-text deltas: `agent_response` steps complete with
 * usage only, and the final text arrives once in the terminal `result` event.
 * Tool steps stream live (ACTIVE -> DONE/ERROR) and are surfaced as
 * structured {@link AgyActivity} events the provider renders as native pi
 * tool cards.
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
  | { type: "text"; delta: string }
  | { type: "usage"; usage: AgyUsage }
  | {
      type: "result";
      status: "OK" | "ERROR" | "UNKNOWN";
      response: string;
      error: string | undefined;
      usage: AgyUsage | undefined;
    };

export interface AgyTurnOutcome {
  /** Conversation id for `--conversation` resume; set by init/result. */
  conversationId: string | undefined;
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
        // agent_response steps stream the response (reasoning included — agy
        // writes it inline as markdown) as continuation chunks on ACTIVE
        // steps plus a final chunk on DONE.
        if (typeof step.text_delta === "string" && step.text_delta) {
          activities.push({ type: "text", delta: step.text_delta });
        }
        if (step.usage) {
          // Running per-response usage; the result event carries the totals.
          outcome.usage = step.usage;
          activities.push({ type: "usage", usage: step.usage });
        }
      }
      break;
    }
    case "result": {
      const result = event.result;
      outcome.finished = true;
      outcome.conversationId = result.conversation_id ?? outcome.conversationId;
      outcome.status =
        result.status === "OK" || result.status === "ERROR" ? result.status : "UNKNOWN";
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
