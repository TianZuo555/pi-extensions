import { spawn, type ChildProcess } from "node:child_process";
import {
  AgySpawnError,
  AgyStallError,
  buildDriverAgyArgs,
  runAgyTurn,
  type AgyTurnRequest,
} from "./agy-client.ts";
import {
  killAgyTree,
  signalAgyDetachedGroup,
  signalAgyTree,
  trackAgyChild,
  untrackAgyChild,
} from "./agy-children.ts";
import { AgyCompatibilityError, checkAgyBinary } from "./agy-diagnostics.ts";
import { parseAgyLine } from "./events.ts";
import { AGY_PARKED_TURN_ERROR } from "./prompt.ts";
import {
  agyGroupLeadingDescendants,
  agyGroupSurvivors,
  agyHasRunningToolProcess,
  agyTurnTranscriptVerdict,
  recordAgyTaskOrphans,
  recordAgyTaskOrphansAsync,
  type AgyTranscriptVerdict,
} from "./tasks.ts";
import { agyToolStepKey, trackActiveToolStep } from "./tool-steps.ts";
import { applyEvent, newTurnOutcome, type AgyActivity, type AgyTurnOutcome } from "./reducer.ts";

export type AgyDriverState = "idle" | "starting" | "ready" | "running" | "stopping" | "dead";
export type AgyExecutorCloseReason = "recycle" | "abort" | "shutdown";
export type AgyRecycleCause =
  | "binary"
  | "cwd"
  | "model"
  | "effort"
  | "agent"
  | "mode"
  | "bridge-catalog"
  | "conversation"
  | "conversation-reset"
  | "session-tree"
  | "restore"
  | "reset"
  | "background-task"
  | "unspecified";

export interface AgyProcessConfigSnapshot {
  binary: string;
  binaryVersion?: string;
  binaryRevision?: string;
  cwd?: string;
  model?: string;
  effort?: string;
  agent?: string;
  mode?: string;
  bridgeRevision?: string;
}

export interface AgyExecutorStats {
  spawnCount: number;
  submittedTurns: number;
  reusedTurns: number;
  recycleCount: number;
  currentProcessTurns: number;
  recycleReasons: Record<string, number>;
  lastRecycleReason?: AgyRecycleCause;
}

export interface AgyExecutorSnapshot {
  mode: "persistent" | "one-shot";
  state: AgyDriverState;
  pid?: number;
  conversationId?: string;
  config?: AgyProcessConfigSnapshot;
  lifecycle: string[];
  stats?: AgyExecutorStats;
}

export interface AgyTurnExecutor {
  run(request: AgyTurnRequest): Promise<AgyTurnOutcome>;
  snapshot(): AgyExecutorSnapshot;
  close(reason: AgyExecutorCloseReason, cause?: AgyRecycleCause): Promise<void>;
}

interface ActiveTurn {
  generation: number;
  request: AgyTurnRequest;
  outcome: AgyTurnOutcome;
  activeTools: Set<string>;
  conversationReported: boolean;
  overallTimer?: NodeJS.Timeout;
  deadlineAt: number;
  stallTimer?: NodeJS.Timeout;
  /** Stall budgets already forgiven because a tool process was verifiably alive. */
  stallGraces: number;
  /** Parked-turn checks already consumed (see #onStallExpired). */
  parkedChecks: number;
  /**
   * Positive evidence that agy finished this turn's work and is only waiting
   * on background tasks: the transcript's newest step is a final answer while a
   * tool step is still ACTIVE (see #onParkedWatch). Tasks keep running when
   * this turn ends — including when the user aborts it. agy's own
   * "waiting for background task(s)" notice would be a faster signal but is
   * print-mode only: the persistent stream-json process never prints it.
   */
  parkedOnBackgroundWork: boolean;
  /** Early parked-answer watch, armed only while a tool step is ACTIVE. */
  parkedWatchTimer?: NodeJS.Timeout;
  /** Watch interval for this turn (0 disables the early watch). */
  parkedWatchMs: number;
  /** Total silence across every expired budget — the honest stall duration. */
  silenceMs: number;
  /** Bumped on every rearm so an in-flight liveness probe can be discarded. */
  stallEpoch: number;
  abortHandler?: () => void;
  resolve: (outcome: AgyTurnOutcome) => void;
  reject: (error: unknown) => void;
}

type DriverChild = ChildProcess & {
  stdin: NonNullable<ChildProcess["stdin"]>;
  stdout: NonNullable<ChildProcess["stdout"]>;
  stderr: NonNullable<ChildProcess["stderr"]>;
};

const STDERR_LIMIT = 8_192;
const STDOUT_LINE_LIMIT = 8 * 1024 * 1024;
const LIFECYCLE_LIMIT = 24;
const GRACEFUL_CLOSE_MS = 250;
const TERM_CLOSE_MS = 500;
/**
 * A parked turn keeps polling for a short while before it is ended: the
 * withheld result only flows when the background work exits, so these brief
 * renewals give a nearly-finished task a chance to complete normally.
 */
const STALL_PARKED_POLL_MS = 10_000;
const STALL_PARKED_LIMIT = 2;
/**
 * While a tool step is ACTIVE, poll the off-stream transcript this often for a
 * final answer agy is withholding. agy emits nothing on stdout for the whole
 * duration of a background task, so waiting for the stall budget to expire
 * would park the turn for minutes after the answer was already written.
 */
const PARKED_WATCH_MS = 5_000;

function processConfig(
  request: AgyTurnRequest,
  binary: string,
  binaryVersion?: string,
  binaryRevision?: string,
): AgyProcessConfigSnapshot {
  return {
    binary,
    binaryVersion,
    binaryRevision,
    cwd: request.cwd,
    model: request.model,
    effort: request.effort,
    agent: request.agent,
    mode: request.mode,
    bridgeRevision: request.bridgeRevision,
  };
}

function recycleCause(
  request: AgyTurnRequest,
  current: AgyProcessConfigSnapshot | undefined,
  next: AgyProcessConfigSnapshot,
  boundConversationId: string | undefined,
): AgyRecycleCause | undefined {
  if (!current) return "unspecified";
  if (
    current.binary !== next.binary ||
    current.binaryVersion !== next.binaryVersion ||
    current.binaryRevision !== next.binaryRevision
  )
    return "binary";
  if (current.cwd !== next.cwd) return "cwd";
  if (current.model !== next.model) return "model";
  if (current.effort !== next.effort) return "effort";
  if (current.agent !== next.agent) return "agent";
  if (current.mode !== next.mode) return "mode";
  if (current.bridgeRevision !== next.bridgeRevision) return "bridge-catalog";
  if (request.conversationId === undefined) {
    return boundConversationId === undefined ? undefined : "conversation-reset";
  }
  return request.conversationId === boundConversationId ? undefined : "conversation";
}

function abortOutcome(): AgyTurnOutcome {
  const outcome = newTurnOutcome();
  outcome.status = "ERROR";
  outcome.error = "agy turn was aborted.";
  outcome.finished = true;
  return outcome;
}

/**
 * step_index values of the stream's still-ACTIVE tool steps — the transcript
 * check orders agy's finished response against them. Returns [] when any
 * active step carries no id: an unorderable step cannot prove the finished
 * response is ours, so the parked check declines instead of guessing.
 */
function activeStepIndexes(activeTools: Set<string>): number[] {
  const indexes: number[] = [];
  for (const key of activeTools) {
    if (!key.startsWith("step:")) return [];
    const index = Number.parseInt(key.slice(5), 10);
    if (!Number.isInteger(index) || Number.isNaN(index)) return [];
    indexes.push(index);
  }
  return indexes;
}

/** One long-lived stream-json agy process, serialized to one logical turn at a time. */
export class AgyDriverSession implements AgyTurnExecutor {
  #state: AgyDriverState = "idle";
  #child: DriverChild | undefined;
  #generation = 0;
  #stdoutBuffer = "";
  #stderrTail = "";
  #boundConversationId: string | undefined;
  #config: AgyProcessConfigSnapshot | undefined;
  #active: ActiveTurn | undefined;
  #queueTail: Promise<void> = Promise.resolve();
  #lifecycle: string[] = [];
  #spawnCount = 0;
  #submittedTurns = 0;
  #reusedTurns = 0;
  #recycleCount = 0;
  #currentProcessTurns = 0;
  #recycleReasons = new Map<AgyRecycleCause, number>();
  #lastRecycleReason: AgyRecycleCause | undefined;
  #shutdown = false;
  #recycling: Promise<void> = Promise.resolve();
  /**
   * Consecutive tool-stall budgets a turn may survive on process evidence
   * alone, reset whenever an ACTIVE step completes — a finished tool is real
   * progress, so only uninterrupted silence counts toward the ceiling.
   */
  #stallGraceLimit = 12;
  /** Test seam for the "is a tool process alive?" probe. */
  #probeToolProcess: (agyPids: number[]) => Promise<boolean> = agyHasRunningToolProcess;
  /** Test seam for the "did agy already finish the answer?" transcript check. */
  #probeTurnParked: (
    conversationId: string | undefined,
    activeStepIndexes: number[],
  ) => Promise<AgyTranscriptVerdict | undefined> = agyTurnTranscriptVerdict;
  #parkedPollMs = STALL_PARKED_POLL_MS;
  #parkedLimit = STALL_PARKED_LIMIT;
  /** Early parked-answer watch interval; 0 disables it (stall budget only). */
  #parkedWatchMs = PARKED_WATCH_MS;
  /**
   * Async orphan-scan queue for tool-start activity. A `ps` snapshot is a
   * subprocess spawn, so the line handler must not run it synchronously;
   * scans coalesce because one fresh table already captures every
   * group-leading child agy currently has — only the latest request needs a
   * trailing run.
   */
  #orphanScanPending: { pid: number; conversationId: string } | undefined;
  #orphanScanRunning = false;
  #orphanScanTail: Promise<void> = Promise.resolve();

  /** Test hook: override the tool-liveness probe and its grace ceiling. */
  setStallLivenessProbe(
    probe: (agyPids: number[]) => Promise<boolean>,
    graceLimit = this.#stallGraceLimit,
  ): void {
    this.#probeToolProcess = probe;
    this.#stallGraceLimit = graceLimit;
  }

  /** Test hook: override the transcript parked-turn probe and its pacing. */
  setTurnParkedProbe(
    probe: (
      conversationId: string | undefined,
      activeStepIndexes: number[],
    ) => Promise<AgyTranscriptVerdict | undefined>,
    options: { pollMs?: number; limit?: number; watchMs?: number } = {},
  ): void {
    this.#probeTurnParked = probe;
    this.#parkedPollMs = options.pollMs ?? STALL_PARKED_POLL_MS;
    this.#parkedLimit = options.limit ?? STALL_PARKED_LIMIT;
    this.#parkedWatchMs = options.watchMs ?? PARKED_WATCH_MS;
  }

  snapshot(): AgyExecutorSnapshot {
    return {
      mode: "persistent",
      state: this.#state,
      pid: this.#child?.pid,
      conversationId: this.#boundConversationId,
      config: this.#config ? { ...this.#config } : undefined,
      lifecycle: [...this.#lifecycle],
      stats: {
        spawnCount: this.#spawnCount,
        submittedTurns: this.#submittedTurns,
        reusedTurns: this.#reusedTurns,
        recycleCount: this.#recycleCount,
        currentProcessTurns: this.#currentProcessTurns,
        recycleReasons: Object.fromEntries(
          [...this.#recycleReasons.entries()].sort(([left], [right]) => left.localeCompare(right)),
        ),
        lastRecycleReason: this.#lastRecycleReason,
      },
    };
  }

  async run(request: AgyTurnRequest): Promise<AgyTurnOutcome> {
    let release!: () => void;
    const previous = this.#queueTail;
    this.#queueTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      if (this.#shutdown) throw new AgySpawnError("agy driver is shut down.", this.#stderrTail);
      if (request.signal?.aborted) return abortOutcome();
      return await this.#runExclusive(request);
    } finally {
      release();
    }
  }

  async close(reason: AgyExecutorCloseReason, cause?: AgyRecycleCause): Promise<void> {
    if (reason === "shutdown") this.#shutdown = true;
    await this.#recycling;
    const child = this.#child;
    if (!child) {
      this.#state = reason === "shutdown" ? "dead" : "idle";
      return;
    }

    if (reason === "recycle") this.#recordRecycle(cause ?? "unspecified");
    this.#log(`close:${reason}${cause ? `:${cause}` : ""}`);
    if (this.#active || reason === "abort") {
      const active = this.#active;
      this.#detachChild(child, "dead");
      killAgyTree(child);
      if (active) this.#settleTurn(active, { outcome: abortOutcome() });
      return;
    }

    this.#state = "stopping";
    // Record orphans BEFORE asking agy to exit: stdin.end can make agy exit
    // immediately, and once it does its children re-parent and their
    // conversation provenance is unrecoverable.
    recordAgyTaskOrphans(child.pid, this.#boundConversationId);
    try {
      child.stdin.end();
    } catch {
      // Already closed.
    }
    if (await this.#waitUntilChildChanges(child, GRACEFUL_CLOSE_MS)) return;
    signalAgyTree(child, "SIGTERM");
    if (await this.#waitUntilChildChanges(child, TERM_CLOSE_MS)) return;
    this.#detachChild(child, "dead");
    killAgyTree(child);
  }

  async #runExclusive(request: AgyTurnRequest): Promise<AgyTurnOutcome> {
    const checked = request.binary ? undefined : await checkAgyBinary();
    if (request.signal?.aborted) return abortOutcome();
    if (this.#shutdown) throw new AgySpawnError("agy driver is shut down.", this.#stderrTail);
    if (checked && !checked.ok) throw new AgyCompatibilityError(checked);
    const binary = request.binary ?? checked?.binary;
    if (!binary) throw new AgySpawnError("agy binary resolution returned no executable.", "");
    const nextConfig = processConfig(request, binary, checked?.version, checked?.revision);
    if (this.#child) {
      const cause = recycleCause(request, this.#config, nextConfig, this.#boundConversationId);
      if (cause) await this.close("recycle", cause);
      else this.#reusedTurns += 1;
    }
    if (request.signal?.aborted) return abortOutcome();
    if (this.#shutdown) throw new AgySpawnError("agy driver is shut down.", this.#stderrTail);
    if (!this.#child) await this.#start(request, nextConfig);
    if (request.signal?.aborted) {
      await this.close("abort");
      return abortOutcome();
    }
    const child = this.#child;
    if (!child) throw new AgySpawnError("agy driver failed to start.", this.#stderrTail);

    const turn = this.#createTurn(request);
    const outcomePromise = new Promise<AgyTurnOutcome>((resolve, reject) => {
      turn.resolve = resolve;
      turn.reject = reject;
    });
    this.#active = turn;
    this.#state = "running";
    this.#submittedTurns += 1;
    this.#currentProcessTurns += 1;
    this.#armTurnTimers(turn);
    if (this.#active !== turn) return outcomePromise;
    try {
      await this.#writeUserEvent(child, request.prompt);
    } catch (error) {
      this.#detachChild(child, "dead");
      killAgyTree(child);
      this.#settleTurn(turn, {
        error: new AgySpawnError(
          `failed to write to agy driver (${error instanceof Error ? error.message : String(error)}).`,
          this.#stderrTail,
        ),
      });
    }
    return outcomePromise;
  }

  async #start(request: AgyTurnRequest, config: AgyProcessConfigSnapshot): Promise<void> {
    this.#state = "starting";
    this.#generation += 1;
    const generation = this.#generation;
    this.#stdoutBuffer = "";
    this.#stderrTail = "";
    this.#boundConversationId = request.conversationId;
    this.#config = config;
    const doSpawn = request.spawnOverride ?? spawn;
    let child: DriverChild;
    try {
      child = doSpawn(
        config.binary,
        buildDriverAgyArgs({
          conversationId: request.conversationId,
          model: request.model,
          effort: request.effort,
          cwd: request.cwd,
          timeoutMs: request.timeoutMs,
          inactivityTimeoutMs: request.inactivityTimeoutMs,
          toolInactivityTimeoutMs: request.toolInactivityTimeoutMs,
          signal: request.signal,
          agent: request.agent,
          mode: request.mode,
          bridgeRevision: request.bridgeRevision,
          binary: config.binary,
          onActivity: request.onActivity,
          onConversation: request.onConversation,
          spawnOverride: request.spawnOverride,
        }),
        {
          cwd: request.cwd,
          stdio: ["pipe", "pipe", "pipe"],
          detached: true,
          windowsHide: true,
        },
      ) as DriverChild;
    } catch (error) {
      this.#state = "dead";
      this.#config = undefined;
      this.#boundConversationId = undefined;
      throw new AgySpawnError(
        `failed to start agy driver (${error instanceof Error ? error.message : String(error)}).`,
        this.#stderrTail,
      );
    }
    this.#child = child;
    this.#spawnCount += 1;
    this.#currentProcessTurns = 0;
    trackAgyChild(child);
    this.#log(`spawn:${child.pid ?? "unknown"}`);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.#onStdout(generation, chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => this.#onStderr(generation, chunk));
    child.on("error", (error: Error) => this.#onChildError(generation, error));
    child.on("close", (code, signal) => this.#onChildClose(generation, code, signal));
    this.#state = "ready";
  }

  #createTurn(request: AgyTurnRequest): ActiveTurn {
    return {
      generation: this.#generation,
      request,
      outcome: newTurnOutcome(),
      activeTools: new Set(),
      conversationReported: false,
      deadlineAt: performance.now() + (request.timeoutMs ?? 600_000),
      stallGraces: 0,
      parkedChecks: 0,
      parkedOnBackgroundWork: false,
      parkedWatchMs: request.parkedWatchMs ?? this.#parkedWatchMs,
      silenceMs: 0,
      stallEpoch: 0,
      resolve: () => {},
      reject: () => {},
    };
  }

  #writeUserEvent(child: DriverChild, prompt: string): Promise<void> {
    const line = `${JSON.stringify({ event: "user", message: { role: "user", content: prompt } })}\n`;
    return new Promise((resolve, reject) => {
      let callbackDone = false;
      let writeReturned = false;
      let drainDone = true;
      let settled = false;
      const cleanup = () => {
        child.stdin.off("error", onError);
        child.stdin.off("close", onClose);
        child.stdin.off("drain", onDrain);
      };
      const finish = () => {
        if (!settled && writeReturned && callbackDone && drainDone) {
          settled = true;
          cleanup();
          resolve();
        }
      };
      const onError = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const onClose = () =>
        onError(new Error("agy driver stdin closed before the user event was written."));
      const onDrain = () => {
        drainDone = true;
        finish();
      };
      child.stdin.once("error", onError);
      child.stdin.once("close", onClose);
      try {
        const accepted = child.stdin.write(line, (error?: Error | null) => {
          if (error) {
            onError(error);
            return;
          }
          callbackDone = true;
          finish();
        });
        writeReturned = true;
        if (!accepted) {
          drainDone = false;
          child.stdin.once("drain", onDrain);
        }
        finish();
      } catch (error) {
        onError(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  #armTurnTimers(turn: ActiveTurn): void {
    const overallMs = turn.request.timeoutMs ?? 600_000;
    turn.overallTimer = setTimeout(() => {
      if (this.#active !== turn || !this.#child) return;
      void this.#terminateTurn(turn, {
        error: new AgySpawnError(
          `agy turn timed out after ${Math.round(overallMs / 1000)}s`,
          this.#stderrTail,
        ),
      });
    }, overallMs);

    const onAbort = () => {
      if (this.#active !== turn) return;
      void this.#terminateTurn(turn);
    };
    turn.abortHandler = onAbort;
    turn.request.signal?.addEventListener("abort", onAbort, { once: true });
    if (turn.request.signal?.aborted) onAbort();
    this.#rearmStall(turn);
  }

  /**
   * End the turn because its owner gave up on it (abort, overall deadline,
   * stall, protocol failure): reap the command process groups agy spawned for
   * this turn, then agy itself. A turn that was parked on background work is
   * the exception — that work was already handed to the background, so the
   * user aborting the *turn* must not kill the dev server they asked for.
   * agy is still alive here, which is the only moment ancestry can attribute
   * its group-leading children.
   */
  async #terminateTurn(
    turn: ActiveTurn,
    result: { outcome: AgyTurnOutcome } | { error: unknown } = { outcome: abortOutcome() },
    child: DriverChild | undefined = this.#child,
  ): Promise<void> {
    if (child) {
      this.#detachChild(child, "dead");
      if (!turn.parkedOnBackgroundWork) await this.#reapTurnTaskGroups(child);
      killAgyTree(child);
    }
    this.#settleTurn(turn, result);
  }

  /**
   * SIGTERM every process group agy spawned for this turn's commands, then
   * SIGKILL the groups still holding members after a short grace. agy >= 1.2.0
   * runs each `run_command` as its own group leader, so killing agy's own
   * group (`killAgyTree`) leaves them running as orphans. Group-addressed
   * only: a bare pid could name a reused process once the leader is gone.
   */
  async #reapTurnTaskGroups(child: DriverChild): Promise<void> {
    if (child.pid === undefined || process.platform === "win32") return;
    const leaders = await agyGroupLeadingDescendants([child.pid]).catch(() => []);
    if (leaders.length === 0) return;
    for (const pid of leaders) {
      this.#log(`turn-command:SIGTERM:${pid}`);
      signalAgyDetachedGroup(pid, "SIGTERM");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, TERM_CLOSE_MS));
    for (const pgid of await agyGroupSurvivors(leaders).catch(() => [])) {
      this.#log(`turn-command:SIGKILL:${pgid}`);
      signalAgyDetachedGroup(pgid, "SIGKILL");
    }
  }

  #stallBudgetMs(turn: ActiveTurn): number {
    const baseMs = turn.request.inactivityTimeoutMs ?? 120_000;
    if (baseMs <= 0) return 0;
    return turn.activeTools.size > 0
      ? (turn.request.toolInactivityTimeoutMs ?? Math.max(baseMs, 300_000))
      : baseMs;
  }

  #rearmStall(turn: ActiveTurn): void {
    if (this.#active !== turn) return;
    if (turn.stallTimer) clearTimeout(turn.stallTimer);
    // Any rearm invalidates an in-flight liveness probe: its answer describes
    // a window that new stream activity has already superseded.
    turn.stallEpoch += 1;
    const budgetMs = this.#stallBudgetMs(turn);
    if (budgetMs <= 0) {
      this.#armParkedWatch(turn, 0);
      return;
    }
    const epoch = turn.stallEpoch;
    turn.stallTimer = setTimeout(() => {
      void this.#onStallExpired(turn, budgetMs, epoch);
    }, budgetMs);
    // Stream activity superseded any parked verdict, so the early watch starts
    // its silence window over.
    this.#armParkedWatch(turn, turn.parkedWatchMs);
  }

  /**
   * Arm (or disarm) the early parked-answer watch. It only runs while a tool
   * step is ACTIVE — the only state where agy can hold a finished answer off
   * the stream — and `delayMs <= 0` disables it.
   */
  #armParkedWatch(turn: ActiveTurn, delayMs: number): void {
    if (turn.parkedWatchTimer) clearTimeout(turn.parkedWatchTimer);
    turn.parkedWatchTimer = undefined;
    if (this.#active !== turn || delayMs <= 0) return;
    if (turn.activeTools.size === 0 || this.#child === undefined) return;
    const epoch = turn.stallEpoch;
    turn.parkedWatchTimer = setTimeout(() => void this.#onParkedWatch(turn, epoch), delayMs);
  }

  /**
   * Check the off-stream transcript while a tool step is still ACTIVE: agy
   * withholds the result event until every background task exits (~25-day print
   * timeout), but it keeps appending the agent's final answer to the
   * transcript. A final answer here means the remaining silence is task
   * bookkeeping, not work — so the turn can end instead of stalling for the
   * whole tool budget. Cheap enough to poll: one tail read of the newest step.
   */
  async #onParkedWatch(turn: ActiveTurn, epoch: number): Promise<void> {
    const child = this.#child;
    if (this.#active !== turn || !child || turn.stallEpoch !== epoch) return;
    if (turn.activeTools.size === 0 || child.pid === undefined) return;
    const verdict = await this.#probeTurnParked(
      turn.outcome.conversationId ?? this.#boundConversationId,
      activeStepIndexes(turn.activeTools),
    ).catch(() => undefined);
    // A settled turn, or a watch rearmed by new stream activity, invalidates
    // this verdict.
    if (this.#active !== turn || turn.stallEpoch !== epoch) return;
    if (!verdict?.finished) {
      this.#armParkedWatch(turn, turn.parkedWatchMs);
      return;
    }
    turn.parkedOnBackgroundWork = true;
    this.#enterParkedGrace(turn, verdict, epoch);
  }

  /**
   * The transcript already holds a final answer: renew briefly so a
   * nearly-finished task can still deliver the real result event, then end the
   * turn with the answer the transcript kept.
   */
  #enterParkedGrace(turn: ActiveTurn, verdict: AgyTranscriptVerdict, epoch: number): void {
    // The early watch can reach here while the tool stall budget is still
    // pending: dropping that handle would leak a timer that keeps the process
    // alive (and pi's print mode from exiting) until it finally fires.
    if (turn.parkedWatchTimer) clearTimeout(turn.parkedWatchTimer);
    turn.parkedWatchTimer = undefined;
    if (turn.stallTimer) clearTimeout(turn.stallTimer);
    turn.stallTimer = undefined;
    if (
      turn.parkedChecks < this.#parkedLimit &&
      performance.now() + this.#parkedPollMs < turn.deadlineAt
    ) {
      turn.parkedChecks += 1;
      this.#log(`stall:task-parked:${turn.parkedChecks}`);
      turn.stallTimer = setTimeout(
        () => void this.#onStallExpired(turn, this.#parkedPollMs, epoch),
        this.#parkedPollMs,
      );
      return;
    }
    this.#finishParkedTurn(turn, verdict);
  }

  /** Poll finality during a forgiven budget without consuming extra liveness graces. */
  #scheduleGraceCheck(turn: ActiveTurn, remainingMs: number, epoch: number): void {
    const delayMs = Math.min(this.#parkedPollMs, remainingMs);
    if (turn.stallTimer) clearTimeout(turn.stallTimer);
    turn.stallTimer = setTimeout(
      () => void this.#onStallExpired(turn, delayMs, epoch, remainingMs - delayMs),
      delayMs,
    );
  }

  /**
   * Silence alone does not prove a hang. agy emits no stdout while a tool step
   * is ACTIVE, so a slow quiet command (a cold `cargo build`) is
   * indistinguishable from a wedged process by timing alone — and a turn whose
   * agent already finished but parked on background work looks identical too.
   * Before killing a turn mid-tool, check the transcript agy keeps appending
   * to off-stream: a finished answer means the wait is task bookkeeping and
   * the turn should end gracefully, not stall. Otherwise look for positive
   * evidence of work — a live group-leading child — and extend the budget
   * while it holds, bounded by #stallGraceLimit so a tool doing only
   * in-process work (agy's `schedule`, `search_web`) still terminates.
   */
  async #onStallExpired(
    turn: ActiveTurn,
    budgetMs: number,
    epoch: number,
    graceRemainingMs = 0,
  ): Promise<void> {
    const child = this.#child;
    if (this.#active !== turn || !child || turn.stallEpoch !== epoch) return;
    turn.silenceMs += budgetMs;
    const toolActive = turn.activeTools.size > 0;

    if (toolActive && child.pid !== undefined) {
      // Each probe awaited, so re-check state before acting on a stale answer.
      // A settled turn needs nothing. A bumped epoch means stream activity (or
      // another expiry) already rearmed the watchdog: these verdicts describe a
      // superseded window and must never kill the turn.
      const stale = () => this.#active !== turn || turn.stallEpoch !== epoch;
      const verdict = await this.#probeTurnParked(
        turn.outcome.conversationId ?? this.#boundConversationId,
        activeStepIndexes(turn.activeTools),
      ).catch(() => undefined);
      if (stale()) return;
      if (verdict?.finished) {
        turn.parkedOnBackgroundWork = true;
        this.#enterParkedGrace(turn, verdict, epoch);
        return;
      }
      turn.parkedChecks = 0;
      if (graceRemainingMs > 0) {
        this.#scheduleGraceCheck(turn, graceRemainingMs, epoch);
        return;
      }
      if (turn.stallGraces < this.#stallGraceLimit) {
        const working = await this.#probeToolProcess([child.pid]).catch(() => false);
        if (stale()) return;
        if (working) {
          turn.stallGraces += 1;
          this.#log(`stall:tool-alive:${turn.stallGraces}`);
          // A second full tool budget can exceed the remaining overall
          // deadline. Keep checking the off-stream answer while it runs.
          this.#scheduleGraceCheck(turn, this.#stallBudgetMs(turn), epoch);
          return;
        }
      }
    }

    await this.#terminateTurn(
      turn,
      { error: new AgyStallError(turn.silenceMs, toolActive) },
      child,
    );
  }

  /**
   * agy's transcript shows the agent's answer is final, yet the result event
   * stays withheld while background work keeps running — bounded by a
   * --print-timeout we set to ~25 days, so waiting is not an option. End the
   * turn normally: still-ACTIVE tool steps replay through the provider's
   * incomplete-tool path, which already points the user at /agy-tasks. The
   * agy child is then recycled like any backgrounded turn; the detached task
   * process survives as an orphan pi can still see and stop.
   */
  #finishParkedTurn(turn: ActiveTurn, verdict: AgyTranscriptVerdict): void {
    this.#log("stall:task-parked:settle");
    // The transcript keeps the answer agy withheld — surface it instead of
    // ending the turn empty.
    const answer = verdict.response ?? "";
    const result: AgyActivity = {
      type: "result",
      status: "OK",
      response: answer,
      error: AGY_PARKED_TURN_ERROR,
      usage: turn.outcome.usage,
    };
    turn.outcome.activities.push(result);
    turn.request.onActivity?.(result);
    turn.outcome.status = "OK";
    turn.outcome.response = answer;
    turn.outcome.error = AGY_PARKED_TURN_ERROR;
    turn.outcome.finished = true;
    this.#settleTurn(turn, { outcome: turn.outcome });
  }

  #onStdout(generation: number, chunk: string): void {
    if (generation !== this.#generation) return;
    if (this.#active) this.#rearmStall(this.#active);
    this.#stdoutBuffer += chunk;
    for (;;) {
      const newline = this.#stdoutBuffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.#stdoutBuffer.slice(0, newline).replace(/\r$/, "");
      this.#stdoutBuffer = this.#stdoutBuffer.slice(newline + 1);
      this.#handleLine(generation, line);
    }
    if (Buffer.byteLength(this.#stdoutBuffer, "utf8") > STDOUT_LINE_LIMIT) {
      const child = this.#child;
      const turn = this.#active;
      if (!child || !turn) {
        this.#stdoutBuffer = this.#stdoutBuffer.slice(-STDOUT_LINE_LIMIT);
        return;
      }
      this.#stdoutBuffer = "";
      void this.#terminateTurn(turn, {
        error: new AgySpawnError(
          `agy driver emitted an unterminated stdout line larger than ${STDOUT_LINE_LIMIT} bytes.`,
          this.#stderrTail,
        ),
      });
    }
  }

  #onStderr(generation: number, chunk: string): void {
    if (generation !== this.#generation) return;
    this.#stderrTail = (this.#stderrTail + chunk).slice(-STDERR_LIMIT);
    if (this.#active) this.#rearmStall(this.#active);
  }

  #handleLine(generation: number, line: string): void {
    const turn = this.#active;
    if (!turn || turn.generation !== generation) {
      if (line.trim()) this.#log("stdout:idle");
      return;
    }
    const parsed = parseAgyLine(line);
    if (!turn.conversationReported) {
      const id =
        parsed.kind === "init"
          ? parsed.conversationId
          : parsed.kind === "step"
            ? parsed.step.conversation_id
            : parsed.kind === "result"
              ? parsed.result.conversation_id
              : undefined;
      if (id) {
        turn.conversationReported = true;
        this.#boundConversationId = id;
        turn.request.onConversation?.(id);
      }
    }
    for (const activity of applyEvent(turn.outcome, parsed)) {
      // agy can repeat the same ACTIVE step line; only a genuinely new tool
      // start may have spawned a process group worth recording. Repeated
      // updates for a step already tracked skip the scan, but a NEW tool
      // start never does — a missed snapshot means an agy crash later leaves
      // the worker orphaned and unrecorded.
      const newToolStart =
        activity.type === "tool_start" && !turn.activeTools.has(agyToolStepKey(activity));
      trackActiveToolStep(turn.activeTools, activity);
      // Snapshot task-shaped children while agy can still be their parent:
      // a later unexpected agy exit re-parents them and the linkage is gone.
      // The scan is queued async so a `ps` spawn never blocks line handling.
      if (newToolStart && this.#child) {
        this.#queueOrphanScan(
          this.#child.pid,
          turn.outcome.conversationId ?? this.#boundConversationId,
        );
      }
      turn.request.onActivity?.(activity);
    }
    // A completed step is real progress: stall counters only measure a
    // consecutive silence streak, so they reset when the active set drains.
    if (turn.activeTools.size === 0) {
      turn.stallGraces = 0;
      turn.parkedChecks = 0;
    }
    if (turn.outcome.conversationId) this.#boundConversationId = turn.outcome.conversationId;
    if (turn.outcome.finished) {
      this.#settleTurn(turn, { outcome: turn.outcome });
    } else {
      this.#rearmStall(turn);
    }
  }

  #onChildError(generation: number, error: Error): void {
    if (generation !== this.#generation) return;
    const child = this.#child;
    if (child) this.#detachChild(child, "dead");
    const turn = this.#active;
    if (turn) {
      this.#settleTurn(turn, {
        error: new AgySpawnError(`agy driver failed (${error.message}).`, this.#stderrTail),
      });
    }
  }

  /**
   * Queue a process-table snapshot for a fresh tool start. Recording is
   * advisory, so the `ps` spawn must not sit inside the line handler: one
   * scan already captures every group-leading child agy currently has, so
   * requests coalesce and only the latest needs a trailing run.
   */
  #queueOrphanScan(pid: number | undefined, conversationId: string | undefined): void {
    if (pid === undefined || !conversationId) return;
    this.#orphanScanPending = { pid, conversationId };
    if (this.#orphanScanRunning) return;
    this.#orphanScanRunning = true;
    this.#orphanScanTail = (async () => {
      try {
        for (;;) {
          const pending = this.#orphanScanPending;
          this.#orphanScanPending = undefined;
          if (!pending) break;
          await recordAgyTaskOrphansAsync(pending.pid, pending.conversationId);
        }
      } finally {
        this.#orphanScanRunning = false;
      }
    })();
  }

  #onChildClose(generation: number, code: number | null, signal: NodeJS.Signals | null): void {
    if (generation !== this.#generation) return;
    if (this.#stdoutBuffer.trim() && this.#active) {
      this.#handleLine(generation, this.#stdoutBuffer.replace(/\r$/, ""));
    }
    this.#stdoutBuffer = "";
    const child = this.#child;
    if (child) this.#detachChild(child, "dead");
    this.#log(`close:${code ?? signal ?? "unknown"}`);
    const turn = this.#active;
    if (turn) {
      const tail = this.#stderrTail.trim().split("\n").slice(-3).join("\n");
      // Only append canned recovery hints when agy left no diagnostics of
      // its own — a real stderr tail beats boilerplate.
      const hint = tail
        ? `: ${tail}`
        : ` (no stderr${this.#config?.model ? ` model=${this.#config.model}` : ""}${
            this.#boundConversationId ? ` conv=${this.#boundConversationId.slice(0, 8)}` : ""
          }). The cause is unknown. Try /agy-reset before retrying, or set PI_ANTIGRAVITY_DRIVER=0 for one-shot mode. Check for commands still running before retrying; use pi's own bash for long-lived commands.`;
      const settle = () =>
        this.#settleTurn(turn, {
          error: new AgySpawnError(
            `agy exited with code ${code ?? signal ?? "signal"} before producing a result${hint}`,
            this.#stderrTail,
          ),
        });
      // Let any queued orphan snapshot land before reporting the turn dead:
      // its scan was scheduled while this agy could still be the parent.
      if (this.#orphanScanRunning || this.#orphanScanPending) {
        void this.#orphanScanTail.then(settle, settle);
      } else {
        settle();
      }
    }
  }

  #settleTurn(turn: ActiveTurn, result: { outcome: AgyTurnOutcome } | { error: unknown }): void {
    if (this.#active !== turn) return;
    if (turn.overallTimer) clearTimeout(turn.overallTimer);
    if (turn.stallTimer) clearTimeout(turn.stallTimer);
    if (turn.parkedWatchTimer) clearTimeout(turn.parkedWatchTimer);
    turn.parkedWatchTimer = undefined;
    if (turn.abortHandler) turn.request.signal?.removeEventListener("abort", turn.abortHandler);
    this.#active = undefined;
    const child = this.#child;
    // Both successful and failed terminal results can leave ACTIVE tools.
    // Quarantine this process immediately, but let outstanding commands handle
    // SIGTERM before forcing group cleanup. Resolving only afterwards keeps
    // queued turns from spawning a replacement while cleanup is in progress.
    if (child && !("error" in result) && turn.activeTools.size > 0) {
      this.#log(`recycle:background-task:${turn.activeTools.size}`);
      this.#recordRecycle("background-task");
      this.#recycling = this.#recycleIncompleteChild(child);
      void this.#recycling.then(() => turn.resolve(result.outcome), turn.reject);
      return;
    }
    if (child) this.#state = "ready";
    if ("error" in result) turn.reject(result.error);
    else turn.resolve(result.outcome);
  }

  async #recycleIncompleteChild(child: DriverChild): Promise<void> {
    this.#detachChild(child, "stopping");
    // Detached from reuse/event handling, but still owned by the death hooks.
    trackAgyChild(child);
    this.#log("background-task:SIGTERM");
    signalAgyTree(child, "SIGTERM");
    // A closed driver/stdio does not prove its descendants exited. Give the
    // whole group a bounded grace period, then reap any survivors even if the
    // leader has already gone. Windows escalates via taskkill /T here.
    await new Promise<void>((resolve) => setTimeout(resolve, TERM_CLOSE_MS));
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        child.off("close", finish);
        resolve();
      };
      const timer = setTimeout(finish, TERM_CLOSE_MS);
      child.once("close", finish);
      killAgyTree(child);
      if (child.exitCode !== null || child.signalCode !== null) finish();
    });
    this.#log("background-task:cleanup-complete");
    this.#state = this.#shutdown ? "dead" : "idle";
  }

  #detachChild(child: DriverChild, nextState: AgyDriverState): void {
    if (this.#child !== child) return;
    if (this.#active?.parkedWatchTimer) clearTimeout(this.#active.parkedWatchTimer);
    if (this.#active) this.#active.parkedWatchTimer = undefined;
    // The child is about to be killed or has died: snapshot its task-shaped
    // descendants as proven orphans of this conversation — the last moment
    // ancestry can attribute them (afterwards they re-parent to launchd).
    recordAgyTaskOrphans(
      child.pid,
      this.#active?.outcome.conversationId ?? this.#boundConversationId,
    );
    untrackAgyChild(child);
    this.#child = undefined;
    this.#currentProcessTurns = 0;
    this.#state = nextState;
    this.#generation += 1;
  }

  #recordRecycle(cause: AgyRecycleCause): void {
    this.#recycleCount += 1;
    this.#lastRecycleReason = cause;
    this.#recycleReasons.set(cause, (this.#recycleReasons.get(cause) ?? 0) + 1);
  }

  #waitUntilChildChanges(child: DriverChild, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const deadline = setTimeout(() => resolve(this.#child !== child), timeoutMs);
      child.once("close", () => {
        clearTimeout(deadline);
        resolve(true);
      });
    });
  }

  #log(message: string): void {
    this.#lifecycle.push(`${new Date().toISOString()} ${message}`);
    if (this.#lifecycle.length > LIFECYCLE_LIMIT) this.#lifecycle.shift();
  }
}

export class AgyOneShotExecutor implements AgyTurnExecutor {
  #state: AgyDriverState = "idle";
  #activeAbort: AbortController | undefined;
  #lifecycle: string[] = [];
  #submittedTurns = 0;

  async run(request: AgyTurnRequest): Promise<AgyTurnOutcome> {
    const activeAbort = new AbortController();
    this.#submittedTurns += 1;
    this.#activeAbort = activeAbort;
    this.#state = "running";
    const signal = request.signal
      ? AbortSignal.any([request.signal, activeAbort.signal])
      : activeAbort.signal;
    try {
      return await runAgyTurn({ ...request, signal });
    } finally {
      if (this.#activeAbort === activeAbort) this.#activeAbort = undefined;
      this.#state = "idle";
    }
  }

  snapshot(): AgyExecutorSnapshot {
    return {
      mode: "one-shot",
      state: this.#state,
      lifecycle: [...this.#lifecycle],
      stats: {
        spawnCount: this.#submittedTurns,
        submittedTurns: this.#submittedTurns,
        reusedTurns: 0,
        recycleCount: 0,
        currentProcessTurns: this.#state === "running" ? 1 : 0,
        recycleReasons: {},
      },
    };
  }

  async close(reason: AgyExecutorCloseReason, cause?: AgyRecycleCause): Promise<void> {
    this.#lifecycle.push(`${new Date().toISOString()} close:${reason}${cause ? `:${cause}` : ""}`);
    if (this.#lifecycle.length > LIFECYCLE_LIMIT) this.#lifecycle.shift();
    this.#activeAbort?.abort();
    this.#activeAbort = undefined;
    this.#state = reason === "shutdown" ? "dead" : "idle";
  }
}

export function createAgyTurnExecutor(env: NodeJS.ProcessEnv = process.env): AgyTurnExecutor {
  return env.PI_ANTIGRAVITY_DRIVER === "0" ? new AgyOneShotExecutor() : new AgyDriverSession();
}
