/**
 * Turn reducer — folds parsed agy stream events into provider-facing state.
 *
 * agy emits no assistant-text deltas: `agent_response` steps complete with
 * usage only, and the final text arrives once in the terminal `result` event.
 * Tool steps, however, stream live (ACTIVE -> DONE/ERROR), so they are
 * surfaced as one-line activity strings the provider can display while the
 * turn runs.
 */

import type { AgyStepUpdate, AgyUsage, ParsedAgyEvent } from "./events.ts";
import { parseAgyLine } from "./events.ts";

export interface AgyTurnOutcome {
  /** Conversation id for `--conversation` resume; set by init/result. */
  conversationId: string | undefined;
  status: "OK" | "ERROR" | "UNKNOWN";
  /** Final assistant text (empty until the result event). */
  response: string;
  /** Error message when status is ERROR. */
  error: string | undefined;
  usage: AgyUsage | undefined;
  /** Live tool-activity lines, appended as tool steps stream in. */
  toolLines: string[];
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
    toolLines: [],
    finished: false,
  };
}

function summarizeParams(step: AgyStepUpdate): string {
  const params = step.tool_info?.parameters;
  if (!params) return "";
  const pick =
    params.AbsolutePath ??
    params.Path ??
    params.CommandLine ??
    params.Query ??
    params.Pattern ??
    params.Url;
  if (typeof pick === "string") {
    const short = pick.length > 72 ? `…${pick.slice(-71)}` : pick;
    return ` ${short}`;
  }
  const json = JSON.stringify(params);
  if (!json || json === "{}") return "";
  return ` ${json.length > 72 ? `${json.slice(0, 71)}…` : json}`;
}

function summarizeOutput(output: string | undefined): string {
  if (!output) return "";
  const oneLine = output.replace(/\s+/g, " ").trim();
  if (!oneLine) return "";
  return ` → ${oneLine.length > 60 ? `${oneLine.slice(0, 59)}…` : oneLine}`;
}

export type { AgyUsage };
/** Fold one parsed event into the outcome; returns new activity lines (if any). */
export function applyEvent(outcome: AgyTurnOutcome, event: ParsedAgyEvent): string[] {
  const lines: string[] = [];
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
          const line = `⏺ ${name}${summarizeParams(step)}`;
          outcome.toolLines.push(line);
          lines.push(line);
        } else if (step.state === "DONE") {
          const secs =
            typeof step.duration_seconds === "number"
              ? ` (${step.duration_seconds.toFixed(2)}s)`
              : "";
          const line = `✓ ${name}${secs}${summarizeOutput(step.output)}`;
          outcome.toolLines.push(line);
          lines.push(line);
        } else if (step.state === "ERROR") {
          const message = step.error?.message ?? "tool error";
          const line = `✗ ${name}: ${message.replace(/\s+/g, " ").slice(0, 160)}`;
          outcome.toolLines.push(line);
          lines.push(line);
        }
      } else if (step.step_type === "agent_response" && step.usage) {
        // Running per-response usage; the result event carries the totals.
        outcome.usage = step.usage;
      }
      break;
    }
    case "result": {
      const result = event.result;
      outcome.finished = true;
      outcome.conversationId = result.conversation_id ?? outcome.conversationId;
      outcome.status = result.status === "OK" || result.status === "ERROR" ? result.status : "UNKNOWN";
      outcome.response = result.response ?? "";
      outcome.error = result.error;
      outcome.usage = result.usage ?? outcome.usage;
      break;
    }
    case "unknown":
      break;
  }
  return lines;
}

/** Parse a full NDJSON document (test helper) and reduce it. */
export function reduceAgyStream(text: string): AgyTurnOutcome {
  const outcome = newTurnOutcome();
  for (const line of text.split("\n")) {
    applyEvent(outcome, parseAgyLine(line));
  }
  return outcome;
}

