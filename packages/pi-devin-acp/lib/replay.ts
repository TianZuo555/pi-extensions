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

export class DevinReplayStore {
  #results = new Map<string, RecordedDevinTool>();

  record(toolCallId: string, result: RecordedDevinTool): void {
    this.#results.set(toolCallId, result);
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
