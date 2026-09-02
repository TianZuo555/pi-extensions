import assert from "node:assert/strict";
import test from "node:test";
import {
  COMPLETION_BATCH_MAX_WAIT_MS,
  COMPLETION_BATCH_QUIET_MS,
  type CompletionBatchTimers,
  createCompletionBatchScheduler,
} from "./src/completion-batcher.ts";

interface ScheduledTimer {
  readonly id: number;
  readonly callback: () => void;
  readonly deadline: number;
  active: boolean;
}

class ManualTimers implements CompletionBatchTimers {
  private now = 0;
  private nextId = 0;
  private readonly scheduled: ScheduledTimer[] = [];

  setTimeout(callback: () => void, delayMs: number) {
    const timer = {
      id: ++this.nextId,
      callback,
      deadline: this.now + delayMs,
      active: true,
    };
    this.scheduled.push(timer);
    return timer.id;
  }

  clearTimeout(handle: unknown) {
    const timer = this.scheduled.find((candidate) => candidate.id === handle);
    if (timer) timer.active = false;
  }

  advance(elapsedMs: number) {
    const target = this.now + elapsedMs;
    while (true) {
      const next = this.scheduled
        .filter((timer) => timer.active && timer.deadline <= target)
        .sort((left, right) => left.deadline - right.deadline || left.id - right.id)[0];
      if (!next) break;
      this.now = next.deadline;
      next.active = false;
      next.callback();
    }
    this.now = target;
  }
}

test("completion batching slides the quiet deadline", () => {
  const timers = new ManualTimers();
  let flushes = 0;
  const scheduler = createCompletionBatchScheduler(() => flushes++, { timers });

  scheduler.schedule();
  timers.advance(COMPLETION_BATCH_QUIET_MS - 1);
  scheduler.schedule();
  timers.advance(1);
  assert.equal(flushes, 0);
  timers.advance(COMPLETION_BATCH_QUIET_MS - 1);
  assert.equal(flushes, 1);
});

test("completion batching keeps sustained arrivals within the maximum hold", () => {
  const timers = new ManualTimers();
  let flushes = 0;
  const scheduler = createCompletionBatchScheduler(() => flushes++, { timers });

  scheduler.schedule();
  timers.advance(900);
  scheduler.schedule();
  timers.advance(900);
  scheduler.schedule();
  timers.advance(900);
  scheduler.schedule();
  timers.advance(COMPLETION_BATCH_MAX_WAIT_MS - 2_700 - 1);
  assert.equal(flushes, 0);
  timers.advance(1);
  assert.equal(flushes, 1);
});

test("clearing completion batching invalidates every pending deadline", () => {
  const timers = new ManualTimers();
  let flushes = 0;
  const scheduler = createCompletionBatchScheduler(() => flushes++, { timers });

  scheduler.schedule();
  scheduler.clear();
  timers.advance(COMPLETION_BATCH_MAX_WAIT_MS * 2);
  assert.equal(flushes, 0);
});
