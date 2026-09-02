export const COMPLETION_BATCH_QUIET_MS = 1_000;
export const COMPLETION_BATCH_MAX_WAIT_MS = 3_000;

export interface CompletionBatchTimers {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface CompletionBatchScheduler {
  /** Start a batch or slide its quiet deadline without extending its maximum hold. */
  schedule(): void;
  /** Resolve a quiet expiry held while busy. Returns whether a group was active. */
  notifyIdle(): boolean;
  /** Cancel every pending deadline. Stale timer callbacks become no-ops. */
  clear(): void;
}

interface TimerRegistration {
  readonly handle: unknown;
  readonly groupGeneration: number;
  readonly timerGeneration: number;
}

const systemTimers: CompletionBatchTimers = {
  setTimeout(callback, delayMs) {
    return setTimeout(callback, delayMs);
  },
  clearTimeout(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export function createCompletionBatchScheduler(
  onFlush: () => void,
  options: {
    readonly timers?: CompletionBatchTimers;
    readonly quietMs?: number;
    readonly maxWaitMs?: number;
    readonly isIdle?: () => boolean;
  } = {},
): CompletionBatchScheduler {
  const timers = options.timers ?? systemTimers;
  const quietMs = options.quietMs ?? COMPLETION_BATCH_QUIET_MS;
  const maxWaitMs = options.maxWaitMs ?? COMPLETION_BATCH_MAX_WAIT_MS;
  const isIdle = options.isIdle ?? (() => true);
  let nextGroupGeneration = 0;
  let activeGroupGeneration = 0;
  let nextTimerGeneration = 0;
  let quietTimer: TimerRegistration | undefined;
  let maximumTimer: TimerRegistration | undefined;
  let quietExpiredWhileBusy = false;

  const cancelQuietTimer = () => {
    if (!quietTimer) return;
    timers.clearTimeout(quietTimer.handle);
    quietTimer = undefined;
  };

  const cancelMaximumTimer = () => {
    if (!maximumTimer) return;
    timers.clearTimeout(maximumTimer.handle);
    maximumTimer = undefined;
  };

  const detachGroup = () => {
    activeGroupGeneration = 0;
    quietExpiredWhileBusy = false;
    cancelQuietTimer();
    cancelMaximumTimer();
  };

  const flushFromTimer = (
    kind: "quiet" | "maximum",
    groupGeneration: number,
    timerGeneration: number,
  ) => {
    if (activeGroupGeneration !== groupGeneration) return;
    const registration = kind === "quiet" ? quietTimer : maximumTimer;
    if (
      !registration ||
      registration.groupGeneration !== groupGeneration ||
      registration.timerGeneration !== timerGeneration
    ) {
      return;
    }
    if (kind === "quiet" && !isIdle()) {
      quietTimer = undefined;
      quietExpiredWhileBusy = true;
      return;
    }
    // Detach before delivery so a synchronous settlement starts a new group.
    detachGroup();
    onFlush();
  };

  const armTimer = (kind: "quiet" | "maximum", groupGeneration: number, delayMs: number) => {
    const timerGeneration = ++nextTimerGeneration;
    const handle = timers.setTimeout(
      () => flushFromTimer(kind, groupGeneration, timerGeneration),
      delayMs,
    );
    const registration = { handle, groupGeneration, timerGeneration };
    if (kind === "quiet") quietTimer = registration;
    else maximumTimer = registration;
  };

  return {
    schedule() {
      if (activeGroupGeneration === 0) {
        activeGroupGeneration = ++nextGroupGeneration;
        armTimer("maximum", activeGroupGeneration, maxWaitMs);
      }
      // A later arrival supersedes a quiet expiry held while busy.
      quietExpiredWhileBusy = false;
      cancelQuietTimer();
      armTimer("quiet", activeGroupGeneration, quietMs);
    },
    notifyIdle() {
      const hadActiveGroup = activeGroupGeneration !== 0;
      if (hadActiveGroup && quietExpiredWhileBusy && isIdle()) {
        detachGroup();
        onFlush();
      }
      return hadActiveGroup;
    },
    clear() {
      detachGroup();
    },
  };
}
