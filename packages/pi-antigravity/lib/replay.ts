/**
 * Replay store for display-only agy tool cards.
 *
 * The provider records each completed agy tool step under the synthetic pi
 * toolCall id before ending the assistant message; the registered `agy`
 * wrapper tool looks the record up by id when pi "executes" the call. No
 * tool work ever runs inside pi — results are recorded agy output.
 */

export interface RecordedAgyTool {
  agyTool: string;
  output?: string;
  error?: string;
  durationSeconds?: number;
}

export class AgyReplayStore {
  #results = new Map<string, RecordedAgyTool>();

  record(toolCallId: string, result: RecordedAgyTool): void {
    this.#results.set(toolCallId, result);
  }

  /** Consume the recorded result for a tool call id. */
  take(toolCallId: string): RecordedAgyTool | undefined {
    const result = this.#results.get(toolCallId);
    this.#results.delete(toolCallId);
    return result;
  }

  get size(): number {
    return this.#results.size;
  }
}

/** One-line bounded summary of recorded agy tool arguments for card display. */
export function summarizeAgyArgs(input: unknown): string {
  if (input === undefined || input === null) return "";
  let json: string;
  try {
    json = JSON.stringify(input);
  } catch {
    return "";
  }
  if (!json || json === "{}" || json === "[]") return "";
  return json.length > 96 ? `${json.slice(0, 95)}…` : json;
}
