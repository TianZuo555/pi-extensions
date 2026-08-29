/**
 * AgyTurnController — one agy turn shared across sequential pi requests.
 *
 * The provider ends its assistant message at each completed agy tool step
 * (stopReason "toolUse") so pi can render native tool cards and execute the
 * display-only replay wrapper. pi then re-invokes the provider, which
 * re-attaches to the same controller and keeps consuming buffered events
 * while the agy process continues running underneath.
 */

import type { AgyActivity, AgyUsage } from "./reducer.ts";

type Waiter = (activity: AgyActivity | null, error: Error | undefined) => void;

export class AgyTurnController {
  readonly prompt: string;
  #queue: AgyActivity[] = [];
  #waiters: Waiter[] = [];
  #closed = false;
  #failure: Error | undefined;
  #incompleteTools = new Map<string, Extract<AgyActivity, { type: "tool_start" }>>();
  #reportedUsage: AgyUsage;
  #thoughtReported = false;

  constructor(prompt: string, conversationUsage: AgyUsage = {}) {
    this.prompt = prompt;
    // agy's terminal result counters are cumulative across every resumed turn
    // in the conversation. Begin at the previous result so a result-only turn
    // claims only its new work instead of the whole conversation again.
    this.#reportedUsage = { ...conversationUsage };
  }

  isClosed(): boolean {
    return this.#closed;
  }

  /** True when unconsumed events are buffered (e.g. after the process exited). */
  hasPending(): boolean {
    return this.#queue.length > 0;
  }

  push(activity: AgyActivity): void {
    if (this.#closed) return;
    let delivered = activity;
    if (activity.type === "tool_start") {
      this.#incompleteTools.set(toolStepKey(activity), activity);
    } else if (activity.type === "tool_done" || activity.type === "tool_error") {
      const key = toolStepKey(activity);
      const started = this.#incompleteTools.get(key);
      if (started) delivered = { ...activity, args: { ...started.args, ...activity.args } };
      this.#incompleteTools.delete(key);
    }
    const waiter = this.#waiters.shift();
    if (waiter) waiter(delivered, undefined);
    else this.#queue.push(delivered);
  }

  /** Tool starts that never produced a DONE/ERROR event. */
  takeIncompleteTools(): Array<Extract<AgyActivity, { type: "tool_start" }>> {
    const tools = [...this.#incompleteTools.values()];
    this.#incompleteTools.clear();
    return tools;
  }

  /** Show at most one synthetic thought summary per logical agy turn. */
  claimThought(): boolean {
    if (this.#thoughtReported) return false;
    this.#thoughtReported = true;
    return true;
  }

  /**
   * Attribute usage exactly once across the several pi messages that make up
   * one agy turn. Step usage is per response; the result usage is cumulative
   * across the resumed agy conversation.
   */
  claimUsage(usage: AgyUsage | undefined, final: boolean): AgyUsage | undefined {
    if (!usage) return undefined;
    if (final) {
      const claimed = subtractUsage(usage, this.#reportedUsage);
      // The result is the authoritative conversation total. Assign it rather
      // than adding the delta so counter resets after agy's own compaction heal.
      this.#reportedUsage = { ...usage };
      return claimed;
    }
    this.#reportedUsage = addUsage(this.#reportedUsage, usage);
    return { ...usage };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter(null, undefined);
  }

  fail(error: Error): void {
    if (this.#closed) return;
    this.#failure = error;
    for (const waiter of this.#waiters.splice(0)) waiter(null, error);
    this.#closed = true;
  }

  /**
   * Resolve the next activity, waiting for one when the queue is empty.
   * Returns null when the turn ended; rejects when the turn failed.
   */
  next(): Promise<AgyActivity | null> {
    return new Promise<AgyActivity | null>((resolve, reject) => {
      const queued = this.#queue.shift();
      if (queued !== undefined) {
        resolve(queued);
        return;
      }
      if (this.#failure) {
        reject(this.#failure);
        return;
      }
      if (this.#closed) {
        resolve(null);
        return;
      }
      this.#waiters.push((activity, error) => {
        if (error) reject(error);
        else if (activity) resolve(activity);
        else resolve(null);
      });
    });
  }
}

function toolStepKey(activity: { stepId?: number; name: string }): string {
  return activity.stepId === undefined ? `name:${activity.name}` : `step:${activity.stepId}`;
}

const USAGE_KEYS = [
  "input_tokens",
  "output_tokens",
  "thinking_tokens",
  "cache_read_tokens",
  "total_tokens",
] as const;

function addUsage(left: AgyUsage, right: AgyUsage): AgyUsage {
  const out: AgyUsage = {};
  for (const key of USAGE_KEYS) {
    const value = (left[key] ?? 0) + (right[key] ?? 0);
    if (value > 0 || left[key] !== undefined || right[key] !== undefined) out[key] = value;
  }
  return out;
}

function subtractUsage(total: AgyUsage, reported: AgyUsage): AgyUsage {
  const out: AgyUsage = {};
  for (const key of USAGE_KEYS) {
    if (total[key] === undefined) continue;
    const previous = reported[key] ?? 0;
    // agy can reset counters when it compacts internally. In that case the
    // current value is all new usage rather than a negative delta.
    out[key] = total[key] < previous ? total[key] : total[key] - previous;
  }
  return out;
}
