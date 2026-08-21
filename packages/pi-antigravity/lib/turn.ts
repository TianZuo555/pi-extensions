/**
 * AgyTurnController — one agy turn shared across sequential pi requests.
 *
 * The provider ends its assistant message at each completed agy tool step
 * (stopReason "toolUse") so pi can render native tool cards and execute the
 * display-only replay wrapper. pi then re-invokes the provider, which
 * re-attaches to the same controller and keeps consuming buffered events
 * while the agy process continues running underneath.
 */

import type { AgyActivity } from "./reducer.ts";

type Waiter = (activity: AgyActivity | null, error: Error | undefined) => void;

export class AgyTurnController {
  readonly prompt: string;
  #queue: AgyActivity[] = [];
  #waiters: Waiter[] = [];
  #closed = false;
  #failure: Error | undefined;

  constructor(prompt: string) {
    this.prompt = prompt;
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
    const waiter = this.#waiters.shift();
    if (waiter) waiter(activity, undefined);
    else this.#queue.push(activity);
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
