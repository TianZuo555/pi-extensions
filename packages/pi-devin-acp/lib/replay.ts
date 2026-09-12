/**
 * Replay store for display-only devin tool cards.
 *
 * The provider records each ACP tool_call's terminal state under the
 * synthetic pi toolCall id before ending the assistant message; the
 * registered `devin` wrapper tool looks the record up by id when pi
 * "executes" the call. No tool work ever runs inside pi — results are
 * recorded devin output.
 */

export interface RecordedDevinTool {
  /** ACP kind: read/edit/execute/fetch/search/think/switch_mode/other. */
  kind?: string;
  /** Devin's human-readable tool title. */
  title: string;
  /** Devin-native tool name when exposed (`_meta` inferenceToolName). */
  tool?: string;
  /** Flattened result text for the card body. */
  output?: string;
  /** Diff content when the tool produced an edit. */
  diff?: { path: string; oldText?: string; newText?: string }[];
  error?: string;
}

/**
 * Cap on the recorded result text. Devin tool output is unbounded, and pi
 * persists the wrapper tool's `details` into the session file, so the record —
 * not just the model-visible content — has to be bounded.
 */
export const MAX_RECORDED_OUTPUT_CHARS = 16_000;

/** Hard cap on retained records; unconsumed entries (aborted turns) must not accumulate. */
export const MAX_RECORDED_TOOLS = 256;

export class DevinReplayStore {
  #results = new Map<string, RecordedDevinTool>();

  record(toolCallId: string, result: RecordedDevinTool): void {
    if (this.#results.size >= MAX_RECORDED_TOOLS && !this.#results.has(toolCallId)) {
      const oldest = this.#results.keys().next().value;
      if (oldest !== undefined) this.#results.delete(oldest);
    }
    const output = result.output;
    this.#results.set(
      toolCallId,
      output !== undefined && output.length > MAX_RECORDED_OUTPUT_CHARS
        ? { ...result, output: output.slice(0, MAX_RECORDED_OUTPUT_CHARS) }
        : result,
    );
  }

  /** Consume the recorded result for a tool call id. */
  take(toolCallId: string): RecordedDevinTool | undefined {
    const result = this.#results.get(toolCallId);
    this.#results.delete(toolCallId);
    return result;
  }

  get size(): number {
    return this.#results.size;
  }
}
