/**
 * agy stream-json NDJSON event types, captured from `agy --print
 * --output-format stream-json` (agy 1.1.17). Event shapes are parsed
 * tolerantly: unknown fields are kept, unknown event names are surfaced as
 * `unknown` so callers can ignore or log them without crashing.
 */

/** First event of every stream: session capabilities and tool inventory. */
export interface AgyInit {
  cwd?: string;
  tools?: string[];
  permission_mode?: string;
}

/** Per-step usage reported on DONE `agent_response` steps and in the result. */
export interface AgyUsage {
  input_tokens?: number;
  output_tokens?: number;
  thinking_tokens?: number;
  cache_read_tokens?: number;
  total_tokens?: number;
}

export interface AgyToolError {
  type?: string;
  message?: string;
}

/** Live parameters of an ACTIVE tool step. */
export interface AgyToolInfo {
  name?: string;
  parameters?: Record<string, unknown>;
  /** Tool output on DONE steps (agy nests it here, not at the step top level). */
  output?: string;
  /** Error detail on ERROR steps (agy nests it here, not at the step top level). */
  error?: AgyToolError;
}

export type AgyStepState = "ACTIVE" | "DONE" | "ERROR" | string;
export type AgyStepType =
  | "user_input"
  | "checkpoint"
  | "agent_response"
  | "tool"
  | (string & {});

export interface AgyStepUpdate {
  conversation_id?: string;
  step_index?: number;
  state?: AgyStepState;
  step_type?: AgyStepType;
  tool_name?: string;
  tool_info?: AgyToolInfo;
  duration_seconds?: number;
  usage?: AgyUsage;
  output?: string;
  /** Continuation chunk of the response text on agent_response steps. */
  text_delta?: string;
  error?: AgyToolError;
}

export type AgyResultStatus = "OK" | "ERROR" | string;

/** Terminal event of every stream: final text, status, and cumulative usage. */
export interface AgyResult {
  conversation_id?: string;
  status?: AgyResultStatus;
  response?: string;
  error?: string;
  duration_seconds?: number;
  num_turns?: number;
  usage?: AgyUsage;
}

export type AgyEvent =
  | { event: "init"; conversation_id?: string; init: AgyInit }
  | {
      event: "step_update";
      conversation_id?: string;
      step_update: AgyStepUpdate;
    }
  | { event: "result"; conversation_id?: string; result: AgyResult }
  | { event: string; [k: string]: unknown };

/** Parsed, discriminated view used by the reducer. */
export type ParsedAgyEvent =
  | { kind: "init"; conversationId: string | undefined; init: AgyInit }
  | { kind: "step"; step: AgyStepUpdate }
  | { kind: "result"; result: AgyResult }
  | { kind: "unknown"; raw: unknown };

/**
 * Parse one NDJSON line into a {@link ParsedAgyEvent}. Never throws: invalid
 * JSON or unrecognized shapes become `unknown`.
 */
export function parseAgyLine(line: string): ParsedAgyEvent {
  const trimmed = line.trim();
  if (!trimmed) return { kind: "unknown", raw: line };
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return { kind: "unknown", raw: line };
  }
  if (typeof obj !== "object" || obj === null) return { kind: "unknown", raw: obj };
  const rec = obj as Record<string, unknown>;
  if (rec.event === "init" && rec.init && typeof rec.init === "object") {
    return {
      kind: "init",
      conversationId: typeof rec.conversation_id === "string" ? rec.conversation_id : undefined,
      init: rec.init as AgyInit,
    };
  }
  if (
    rec.event === "step_update" &&
    rec.step_update &&
    typeof rec.step_update === "object"
  ) {
    return { kind: "step", step: rec.step_update as AgyStepUpdate };
  }
  if (rec.event === "result" && rec.result && typeof rec.result === "object") {
    return { kind: "result", result: rec.result as AgyResult };
  }
  return { kind: "unknown", raw: obj };
}
