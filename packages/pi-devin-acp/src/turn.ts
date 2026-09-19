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

/**
 * One server-rendered usage row (`responseDimensions`): self-describing
 * label/value grouped under `groupTitle` — the same payload devin's own
 * /session-stats lists, so new dimensions show up without a client update.
 */
export interface DevinResponseDimension {
  uid?: string;
  groupTitle?: string;
  label?: string;
  kind?: {
    type?: string;
    value?: unknown;
    prefix?: string;
    tail?: string;
    pluralTail?: string;
  };
}

export interface DevinUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  /** Context occupancy: `used` of `size` tokens. */
  contextUsed?: number;
  contextSize?: number;
  /** Cumulative session cost (`usage_update.cost`). */
  cost?: { amount: number; currency: string };
  /** Cumulative billed totals from `usage_update` _meta. */
  totalCreditCost?: number;
  totalAcuCost?: number;
  dimensions?: DevinResponseDimension[];
  /**
   * Set when the token fields are the turn's cumulative sums (turn_stats
   * responseDimensions) rather than a last-request snapshot. Authoritative:
   * later snapshots must not overwrite them.
   */
  cumulative?: boolean;
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
  /** Billed cost of the stopped turn (agent_stopped stats). */
  creditCost?: number;
  acuCost?: number;
  dimensions?: DevinResponseDimension[];
}

/**
 * Merge usage snapshots. Update payloads omit fields they do not carry, and
 * those omissions must not clobber values an earlier update established.
 */
export function mergeDevinUsage(
  base: DevinUsage | undefined,
  next: DevinUsage | undefined,
): DevinUsage {
  const merged: DevinUsage = { ...(base ?? {}) };
  for (const [key, value] of Object.entries(next ?? {})) {
    if (value !== undefined) merged[key as keyof DevinUsage] = value;
  }
  return merged;
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
  /**
   * `_cognition.ai/connection_retry`: devin is retrying its backend stream
   * while the prompt request stays pending. `isStreamRetry` distinguishes
   * "Connection failed" (stream creation) from "Connection lost" (mid-stream).
   */
  | { type: "retry"; attempt: number; maxAttempts?: number; isStreamRetry?: boolean }
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
   * Client-supplied user message id stamped on this turn's session/prompt.
   * Devin echoes it as turnClientMessageId in `_cognition.ai/turn_stats`,
   * which lets the cumulative per-turn token sums be matched to exactly
   * this turn (replayed or superseded-turn stats carry other ids).
   */
  turnClientMessageId?: string;
  #queue: DevinActivity[] = [];
  #waiters: Waiter[] = [];
  #closed = false;
  #failure: Error | undefined;
  #incompleteTools = new Map<string, DevinToolView>();
  /**
   * Billable token totals observed this turn. usage_update and
   * PromptResponse.usage each report ONE internal request, so they
   * accumulate; turn_stats' cumulativeMetric sums are authoritative and
   * replace the accumulated total.
   */
  #seenTokens = {
    inputTokens: 0,
    outputTokens: 0,
    cachedReadTokens: 0,
    cachedWriteTokens: 0,
  };
  /** Token totals already persisted on this turn's pi messages. */
  #billedTokens = {
    inputTokens: 0,
    outputTokens: 0,
    cachedReadTokens: 0,
    cachedWriteTokens: 0,
  };
  #seenCumulative = false;
  /**
   * Token signature of the last accumulated request snapshot. Devin emits
   * every request's usage_update twice (identical) and PromptResponse.usage
   * echoes the last request — consecutive-identical snapshots accumulate
   * once.
   */
  #lastRequestKey?: string;
  /**
   * Latest context occupancy snapshot (`usage_update.used`/`size`). These
   * are point-in-time gauges, not billed deltas — the newest value always
   * wins and rides along on every emitted usage so pi's context checks see
   * devin's real fill level instead of accumulated prompt sums.
   */
  #contextUsed?: number;
  #contextSize?: number;
  /**
   * Last single request's input+output size — the occupancy estimate used
   * when devin never reports contextUsed (e.g. before the first
   * usage_update with `used` arrives).
   */
  #lastRequestTokens = 0;

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
      if (!TERMINAL_TOOL_STATUSES.has(activity.view.status ?? "")) {
        this.#incompleteTools.set(activity.view.id, activity.view);
      }
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
   * Fold a usage snapshot into the turn's billable total.
   *
   * usage_update and PromptResponse.usage report a single internal request
   * — and devin emits each request's update twice (identical), while the
   * prompt response echoes the last request — so request snapshots
   * accumulate after consecutive-identical dedup. Context-only updates carry
   * no token fields and are ignored without touching the dedup baseline.
   * turn_stats' cumulative sums are authoritative: they replace the
   * accumulated total, and once they land request-level snapshots stop
   * accumulating (their tokens are already inside the cumulative sum).
   */
  recordUsage(next: DevinUsage | undefined): void {
    if (!next) return;
    if (next.contextUsed !== undefined) this.#contextUsed = next.contextUsed;
    if (next.contextSize !== undefined) this.#contextSize = next.contextSize;
    if (next.cumulative) {
      this.#seenTokens.inputTokens = next.inputTokens ?? this.#seenTokens.inputTokens;
      this.#seenTokens.outputTokens = next.outputTokens ?? this.#seenTokens.outputTokens;
      this.#seenTokens.cachedReadTokens =
        next.cachedReadTokens ?? this.#seenTokens.cachedReadTokens;
      this.#seenTokens.cachedWriteTokens =
        next.cachedWriteTokens ?? this.#seenTokens.cachedWriteTokens;
      this.#seenCumulative = true;
      return;
    }
    if (this.#seenCumulative) return;
    if (
      next.inputTokens === undefined &&
      next.outputTokens === undefined &&
      next.cachedReadTokens === undefined &&
      next.cachedWriteTokens === undefined
    ) {
      return;
    }
    const tokens = {
      inputTokens: next.inputTokens ?? 0,
      outputTokens: next.outputTokens ?? 0,
      cachedReadTokens: next.cachedReadTokens ?? 0,
      cachedWriteTokens: next.cachedWriteTokens ?? 0,
    };
    const key = `${tokens.inputTokens}/${tokens.outputTokens}/${tokens.cachedReadTokens}/${tokens.cachedWriteTokens}`;
    if (key === this.#lastRequestKey) return;
    this.#lastRequestKey = key;
    this.#lastRequestTokens = tokens.inputTokens + tokens.outputTokens;
    this.#seenTokens.inputTokens += tokens.inputTokens;
    this.#seenTokens.outputTokens += tokens.outputTokens;
    this.#seenTokens.cachedReadTokens += tokens.cachedReadTokens;
    this.#seenTokens.cachedWriteTokens += tokens.cachedWriteTokens;
  }

  /**
   * The not-yet-persisted share of the turn's billable total. Every pi
   * assistant message of the turn (replay segment or terminal) bills only
   * what earlier ones did not, so the session log sums to the authoritative
   * total while the footer fills live. A field whose observed total drops
   * below what was already billed (e.g. a cumulative set smaller than the
   * accumulated requests) bills zero rather than a negative correction —
   * the excess stays in the log.
   */
  takeBillableUsage(): DevinUsage {
    const billable: DevinUsage = {};
    const take = (
      key: "inputTokens" | "outputTokens" | "cachedReadTokens" | "cachedWriteTokens",
    ) => {
      const delta = this.#seenTokens[key] - this.#billedTokens[key];
      if (delta <= 0) return;
      billable[key] = delta;
      this.#billedTokens[key] = this.#seenTokens[key];
    };
    take("inputTokens");
    take("outputTokens");
    take("cachedReadTokens");
    take("cachedWriteTokens");
    // Occupancy is a snapshot, not a delta: the latest known value rides on
    // every message (even one with no new billed tokens) so pi's context
    // gauge and compaction threshold see devin's real fill level. Without a
    // report, the last single request's size is the best estimate — never
    // the accumulated sums, which read as context size to pi's checks.
    const occupancy =
      this.#contextUsed ?? (this.#lastRequestTokens > 0 ? this.#lastRequestTokens : undefined);
    if (occupancy !== undefined) billable.contextUsed = occupancy;
    if (this.#contextSize !== undefined) billable.contextSize = this.#contextSize;
    return billable;
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
