/**
 * DevinTurnController — one ACP prompt turn shared across sequential pi
 * provider calls.
 *
 * The provider ends its assistant message at each completed devin tool call
 * (stopReason "toolUse") so pi can render tool cards and execute the
 * display-only replay wrapper. pi then re-invokes the provider, which
 * re-attaches to the same controller and keeps consuming buffered updates
 * while `session/prompt` is still running underneath.
 */

import type { DevinConfigOption } from "../lib/acp-client.ts";
import type { DevinToolView } from "../lib/tool-content.ts";

export interface DevinUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedReadTokens?: number;
  /** Context occupancy: `used` of `size` tokens. */
  contextUsed?: number;
  contextSize?: number;
}

export interface DevinTurnStats {
  toolCalls?: number;
  filesChanged?: number;
  commandsRun?: number;
  inputTokens?: number;
  outputTokens?: number;
  ttftMs?: number;
  tokensPerSec?: number;
  totalTimeMs?: number;
  modelLabel?: string;
}

export type DevinActivity =
  | { type: "text"; delta: string; messageId?: string }
  | { type: "thought"; delta: string; messageId?: string }
  | { type: "tool_start"; view: DevinToolView }
  | { type: "tool_update"; view: DevinToolView }
  | { type: "usage"; usage: DevinUsage }
  | { type: "mode"; modeId: string }
  | { type: "config"; options: DevinConfigOption[] }
  | { type: "title"; title: string }
  | {
      type: "commands";
      commands: { name: string; description?: string; hint?: string }[];
    }
  | { type: "plan"; entries: { content: string; status?: string }[] }
  | { type: "compaction" }
  | { type: "result"; stopReason: string; usage?: DevinUsage }
  | { type: "stopped"; stats: DevinTurnStats };

type Waiter = (activity: DevinActivity | null, error: Error | undefined) => void;

export const TERMINAL_TOOL_STATUSES = new Set(["completed", "failed"]);

export class DevinTurnController {
  /** The base user prompt text, used to match provider re-attachment. */
  readonly prompt: string;
  /** Assigned once the ACP session id is known (session/new or load). */
  sessionId: string;
  /**
   * Latest usage_update seen this turn, carried across pi message
   * boundaries so each re-entered segment reports the cumulative counters.
   */
  lastUsage?: DevinUsage;
  #queue: DevinActivity[] = [];
  #waiters: Waiter[] = [];
  #closed = false;
  #failure: Error | undefined;
  #incompleteTools = new Map<string, DevinToolView>();

  constructor(prompt: string, sessionId: string) {
    this.prompt = prompt;
    this.sessionId = sessionId;
  }

  isClosed(): boolean {
    return this.#closed;
  }

  hasPending(): boolean {
    return this.#queue.length > 0;
  }

  push(activity: DevinActivity): void {
    if (this.#closed) return;
    let delivered = activity;
    if (activity.type === "tool_start") {
      this.#incompleteTools.set(activity.view.id, activity.view);
    } else if (activity.type === "tool_update") {
      // Updates carry only changed fields (no title/kind/locations) — merge
      // over the started view so cards keep the full picture.
      const started = this.#incompleteTools.get(activity.view.id);
      if (started) {
        delivered = { ...activity, view: { ...started, ...activity.view } };
      }
      if (TERMINAL_TOOL_STATUSES.has(activity.view.status ?? "")) {
        this.#incompleteTools.delete(activity.view.id);
      } else if (started && delivered.type === "tool_update") {
        this.#incompleteTools.set(activity.view.id, delivered.view);
      }
    }
    const waiter = this.#waiters.shift();
    if (waiter) waiter(delivered, undefined);
    else this.#queue.push(delivered);
  }

  /** Tool calls that never reached a terminal status. */
  takeIncompleteTools(): DevinToolView[] {
    const tools = [...this.#incompleteTools.values()];
    this.#incompleteTools.clear();
    return tools;
  }

  /**
   * Keep the terminal result pending while pi executes incomplete-tool
   * replay. Unlike push(), this also works after the turn closed.
   */
  deferResult(result: Extract<DevinActivity, { type: "result" }>): void {
    this.#queue.unshift(result);
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
   * Resolve the next activity, waiting when the queue is empty.
   * Returns null when the turn ended; rejects when the turn failed.
   */
  next(): Promise<DevinActivity | null> {
    return new Promise<DevinActivity | null>((resolve, reject) => {
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
