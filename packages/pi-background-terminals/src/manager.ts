/**
 * TerminalManager — owns the registry of running/settled background
 * terminals.
 *
 * Each terminal is a raw `node:child_process` spawn (own process group on
 * POSIX, no interactive stdin) whose stdout/stderr 'data' callbacks fold into two
 * bounded OutputBuffers. Closing a terminal's scope kills the whole process
 * tree (SIGTERM → SIGKILL escalation).
 *
 * The manager also exposes a synchronous `TerminalReadModel` so the
 * imperative TUI components (which render synchronously) can read snapshots
 * and issue fire-and-forget kills without touching the Effect runtime.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getShellConfig } from "@earendil-works/pi-coding-agent";
import { Context, Deferred, Effect, Exit, FiberSet, Layer, Scope } from "effect";
import {
  ConcurrencyLimitError,
  formatExit,
  SpawnError,
  TerminalLogUnavailableError,
  UnknownTerminalError,
  type TerminalSnapshot,
  type TerminalStatus,
} from "./domain.ts";
import { OutputBuffer } from "./output.ts";
import { createDetachedChildTracker } from "./process-tracker.ts";
import { assignChildJob, preloadChildJobSupport, type ChildJobHandle } from "./win32-job.ts";
import { codePointStart, completeCodePointEnd } from "./utf8.ts";

export const MAX_RUNNING = 8;
export const MAX_TRACKED = 32;
export const DEFAULT_YIELD_TIME_MS = 10_000;
export const MIN_YIELD_TIME_MS = 250;
export const MAX_YIELD_TIME_MS = 30_000;
/** Same upper bound as Pi's built-in bash timeout (Node timer maximum). */
export const MAX_RUNTIME_TIMEOUT_MS = 2_147_483_647;
export const MAX_RUNTIME_TIMEOUT_SECONDS = MAX_RUNTIME_TIMEOUT_MS / 1000;
const MAX_SETTLED_HISTORY = MAX_TRACKED * 4;
/** In-memory retained cap per stream. */
export const RETAINED_PER_STREAM = 2 * 1024 * 1024;
/** Stable startup prefix within the retained cap; the remainder is rolling tail. */
export const HEAD_RETAINED_PER_STREAM = 256 * 1024;
/** Private full-log spills are bounded so a firehose cannot fill the temp disk. */
export const MAX_SPILL_BYTES_PER_STREAM = 256 * 1024 * 1024;
/** Maximum bytes exposed by one model-facing archive read. */
export const MAX_TERMINAL_LOG_READ_BYTES = 64 * 1024;
const STOP_TIMEOUT_MS = 5_000;
/** SIGTERM is normally enough; the second deadline covers a wedged process. */
const FORCE_KILL_AFTER_MS = 2_000;
/** After termination, how long to wait for the natural close→flush→settle
 * path before force-settling (a grandchild can hold the stdio pipes open). */
const SETTLE_GRACE_MS = 1_000;
/** Bound on waiting for spill WriteStreams to flush before settling; a hung
 * filesystem must not leave an exited entry "running" (and kill() waiting).
 * Terminate (≤2.5s) + settle grace (1s) + flush (1.5s) stays inside the 5s
 * scope-close bound, so teardown remains bounded end to end. */
const SPILL_FLUSH_TIMEOUT_MS = 1_500;
const ERROR_TEXT_MAX_LENGTH = 4_096;

function bounded(text: string) {
  return text.slice(0, ERROR_TEXT_MAX_LENGTH);
}

function boundedError(error: unknown) {
  return bounded(error instanceof Error ? error.message : String(error));
}

function boundedSpillError(error: unknown, spillPath: string) {
  return boundedError(error)
    .replaceAll(spillPath, "<private archive>")
    .replaceAll(path.dirname(spillPath), "<private archive directory>");
}

/** Single source of truth for archive file naming: the spill writer creates it
 * and pruning tombstones recognize it. */
function spillFileName(id: string, stream: TerminalLogStream) {
  return `${id}.${stream}.log`;
}

// --- Internal state -----------------------------------------------------------

/** Mutable snapshot; exposed to readers via the readonly TerminalSnapshot type.
 * stdout/stderr are getters over the live OutputBuffers. */
interface MutableSnapshot extends TerminalSnapshot {
  status: TerminalStatus;
  pid?: number;
  settledAt?: number;
  exitCode?: number;
  signal?: string;
  errorText?: string;
}

interface Entry {
  snapshot: MutableSnapshot;
  child: ChildProcess;
  /** Dedicated Windows job containing the whole tree; closing it reaps
   * descendants PID-based kills cannot reach. `undefined` elsewhere or when
   * job support is unavailable. */
  childJob: ChildJobHandle | undefined;
  scope: Scope.Closeable;
  stdoutBuf: OutputBuffer;
  stderrBuf: OutputBuffer;
  spillStreams: fs.WriteStream[];
  /** Immutable file ownership retained even if a spill becomes unavailable. */
  spillPaths: string[];
  /** Set in the same synchronous effect that sends SIGTERM so a natural exit
   * before signaling keeps its truthful status. */
  killSignaled: boolean;
  /** The child emitted 'error' (spawn failure etc.); settles as "failed".
   * Kept separate from errorText, which also carries non-fatal notes
   * (spill failures) that must not flip a clean exit to "failed". */
  processErrored: boolean;
  /** 'exit' event observed (code/signal recorded). */
  exited: boolean;
  /** 'close' event observed (stdio flushed; the settle trigger). */
  stdioClosed: boolean;
  /** A settle-after-spill-flush is in flight; don't start a second one. */
  settling: boolean;
  /** Hard runtime deadline won before a natural process exit. */
  timedOut: boolean;
  /** Cleared on every settle/disposal path. */
  timeoutHandle?: NodeJS.Timeout;
  /** The shell exited without stdio closing; a bounded scope close is queued
   * to reap descendants that still hold the inherited pipes open. */
  exitCleanupStarted: boolean;
  /** Completed exactly once when the entry settles. Kill callers and the scope
   * finalizer can all await the same result without missing a notification. */
  settled: Deferred.Deferred<void>;
}

type ArchiveTombstoneStream = {
  /** True when this stream owned a spill before pruning removed it. */
  readonly archived: boolean;
};

interface ArchiveTombstone {
  readonly reason: "pruned";
  readonly stdout: ArchiveTombstoneStream;
  readonly stderr: ArchiveTombstoneStream;
}

export interface StartOptions {
  readonly command: string;
  readonly title: string;
  readonly cwd: string;
  /** Exact script sent to Bash after Pi's configured command prefix. */
  readonly executionCommand?: string;
  /** Pi's configured Bash path, when present. */
  readonly shellPath?: string;
  /** Environment resolved at the tool boundary, including current PI_* state. */
  readonly env?: NodeJS.ProcessEnv;
  /** Optional hard total runtime timeout. The yield wait is independent. */
  readonly timeoutMs?: number;
}

export interface SettlementWaitResult {
  readonly snapshot: TerminalSnapshot;
  /** True when the process settled before this wait yielded. */
  readonly settled: boolean;
}

export type TerminalLogStream = "stdout" | "stderr";

export interface TerminalLogReadRequest {
  readonly id: string;
  readonly stream: TerminalLogStream;
  readonly offset: number;
  readonly limit: number;
}

export interface TerminalLogReadResult {
  readonly id: string;
  readonly stream: TerminalLogStream;
  readonly offset: number;
  readonly nextOffset: number;
  readonly bytesRead: number;
  readonly size: number;
  readonly settled: boolean;
  readonly complete: boolean;
  readonly text: string;
}

export interface KillResult {
  readonly id: string;
  readonly title: string;
  readonly status: TerminalStatus;
  /** True when the entry was still running when this kill began. */
  readonly wasRunning: boolean;
  /** True when this call initiated the termination AND the entry settled as
   * killed (a natural exit that won the race reports killed: false). */
  readonly killed: boolean;
  /** Final exit rendering ("exit 0", "SIGTERM", ...) captured at settle time,
   * so reports stay accurate even if the entry is pruned afterwards. */
  readonly exit: string;
}

// --- Read model ----------------------------------------------------------------

/** Synchronous bridge for the TUI. Snapshots are live objects; do not mutate. */
export interface TerminalReadModel {
  /** Tracked terminals ordered by creation time, newest first. */
  list(): ReadonlyArray<TerminalSnapshot>;
  get(id: string): TerminalSnapshot | undefined;
  size(): number;
  /** Any-change notification (widget, /ps list). */
  subscribe(listener: () => void): () => void;
  /** Per-terminal notification (/ps detail view). */
  subscribeTo(id: string, listener: () => void): () => void;
  /** Fire-and-forget kill (dashboard/detail `x`). Not marked consumed: the
   * settle still flows back to the model as a follow-up message. */
  requestKill(id: string): void;
  /**
   * Register the settle hook. `consumed` is true when a manager operation is
   * returning that same final state, so it must not also become a follow-up.
   */
  setOnSettled(hook: ((snap: TerminalSnapshot, consumed: boolean) => void) | undefined): void;
}

// --- Service --------------------------------------------------------------------

export interface TerminalManagerShape {
  start(options: StartOptions): Effect.Effect<TerminalSnapshot, SpawnError | ConcurrencyLimitError>;
  waitForSettlement(
    id: string,
    timeoutMs: number,
  ): Effect.Effect<SettlementWaitResult, UnknownTerminalError>;
  status(id: string): Effect.Effect<TerminalSnapshot, UnknownTerminalError>;
  readLog(
    request: TerminalLogReadRequest,
  ): Effect.Effect<TerminalLogReadResult, UnknownTerminalError | TerminalLogUnavailableError>;
  /** Kill running terminals; resolves only after they have settled. */
  kill(ids: ReadonlyArray<string>): Effect.Effect<ReadonlyArray<KillResult>>;
  /** Tracked terminals ordered by creation time, newest first. */
  readonly list: Effect.Effect<ReadonlyArray<TerminalSnapshot>>;
  readonly disposeAll: Effect.Effect<void>;
  readonly view: TerminalReadModel;
}

export class TerminalManager extends Context.Service<TerminalManager, TerminalManagerShape>()(
  "background-terminals/TerminalManager",
) {}

// --- Process helpers ------------------------------------------------------------

function shellInvocation(command: string, shellPath?: string) {
  // Match Pi's built-in bash resolution: installations expect Bash syntax on
  // every platform (Git Bash/MSYS/Cygwin on Windows, Bash→sh fallback on
  // POSIX). Legacy WSL bash accepts the script over a one-shot stdin
  // transport; it is closed immediately and never becomes interactive.
  const config = getShellConfig(shellPath);
  const commandFromStdin = config.commandTransport === "stdin";
  return {
    shell: config.shell,
    args: commandFromStdin ? config.args : [...config.args, command],
    commandInput: commandFromStdin ? command : undefined,
  };
}

/** Signal the whole process group on POSIX so descendants (servers a shell
 * command spawned) die with it; a wedged child must not orphan its tree.
 * Windows has no graceful process-tree signal: taskkill without /F can remove
 * the shell before its descendants, leaving no stable root for escalation.
 * Force the complete tree in the first call so that snapshot-and-kill is
 * atomic. The per-child Job Object (see win32-job.ts) is the reliable
 * backstop: taskkill cannot reach descendants re-parented after the shell
 * exited, so the job close in the teardown path does the actual reaping. */
function killTree(child: ChildProcess, signal: NodeJS.Signals) {
  if (process.platform === "win32" && child.pid) {
    try {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.once("error", () => {
        try {
          child.kill(signal);
        } catch {
          // Process may already be gone.
        }
      });
      killer.once("exit", (code) => {
        if (code === 0) return;
        try {
          child.kill(signal);
        } catch {
          // Process may already be gone.
        }
      });
      killer.unref();
      return;
    } catch {
      // Fall through to the direct signal when taskkill cannot be launched.
    }
  }
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Group may already be gone; fall through to the direct signal.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Process may already be gone.
  }
}

/** Await stdio closure without retaining a listener after interruption. */
function awaitChildClose(child: ChildProcess, closed: () => boolean) {
  return Effect.callback<void>((resume) => {
    if (closed()) {
      resume(Effect.void);
      return;
    }
    const onClose = () => resume(Effect.void);
    child.once("close", onClose);
    return Effect.sync(() => child.off("close", onClose));
  });
}

/** POSIX uses SIGTERM → deadline → SIGKILL. Windows force-kills the tree on
 * the first call, then retains the same bounded wait/retry path. Waiting for
 * stdio closure rather than only the shell's exit detects surviving descendants
 * that inherited the pipes. `onEscalation` fires with the SIGKILL escalation —
 * the Windows job close there releases pipes the dead shell's descendants
 * still hold. */
function terminateChild(
  child: ChildProcess,
  closed: () => boolean,
  onSignal: () => void,
  onEscalation: () => void,
) {
  return Effect.suspend(() => {
    if (closed()) return Effect.void;
    return Effect.gen(function* () {
      yield* Effect.sync(() => {
        onSignal();
        killTree(child, "SIGTERM");
      });
      yield* awaitChildClose(child, closed).pipe(
        Effect.timeout(FORCE_KILL_AFTER_MS),
        Effect.ignore,
      );
      if (closed()) return;
      yield* Effect.sync(() => {
        killTree(child, "SIGKILL");
        onEscalation();
      });
      yield* awaitChildClose(child, closed).pipe(Effect.timeout(500), Effect.ignore);
    });
  });
}

// --- Implementation --------------------------------------------------------------

const makeManager = Effect.gen(function* () {
  // Warm the Windows job-object surface now so per-terminal assignment runs
  // synchronously in the same tick as each spawn (POSIX: resolves at once).
  yield* Effect.promise(preloadChildJobSupport);
  // Scoped detached forker for sync contexts (read-model kills, process-event
  // settlement, pruning). Completed fibers remove themselves; manager scope
  // close interrupts any work that outlives the bounded disposeAll wait.
  const cleanupFibers = yield* FiberSet.make();
  const runCleanup = yield* FiberSet.runtime(cleanupFibers)();
  const detachedChildren = yield* Effect.acquireRelease(
    Effect.sync(createDetachedChildTracker),
    (tracker) => Effect.sync(() => tracker.dispose()),
  );

  const entries = new Map<string, Entry>();
  /** Small immutable tombstones preserve truthful kill reports if pruning
   * races the tool boundary after an id was validated. */
  const settledHistory = new Map<string, Pick<KillResult, "title" | "status" | "exit">>();
  /** Metadata-only records for archives removed by the retention cap. Like
   * settledHistory, this is bounded; it never retains a filesystem path. */
  const archiveTombstones = new Map<string, ArchiveTombstone>();
  /** Internal kill() callers collecting a result (settle → consumed). */
  const killInterest = new Map<string, number>();
  /** Initial bash waits currently entitled to return a settlement. */
  const settlementWaiters = new Map<string, Set<{ consumed: boolean }>>();
  const listeners = new Set<() => void>();
  const idListeners = new Map<string, Set<() => void>>();
  let counter = 0;
  let reserved = 0;
  let disposed = false;
  let spillDir: string | undefined | null;
  let onSettled: ((snap: TerminalSnapshot, consumed: boolean) => void) | undefined;

  const notify = (id?: string) => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // A failed widget/render listener must not corrupt lifecycle state.
      }
    }
    if (id) {
      for (const listener of idListeners.get(id) ?? []) {
        try {
          listener();
        } catch {
          // Same.
        }
      }
    }
  };

  const runningCount = () =>
    [...entries.values()].filter((e) => e.snapshot.status === "running").length;

  const addKillInterest = (ids: ReadonlyArray<string>) => {
    for (const id of ids) killInterest.set(id, (killInterest.get(id) ?? 0) + 1);
  };
  const releaseKillInterest = (ids: ReadonlyArray<string>) => {
    for (const id of ids) {
      const count = (killInterest.get(id) ?? 1) - 1;
      if (count <= 0) killInterest.delete(id);
      else killInterest.set(id, count);
    }
  };

  const closeEntryScope = (entry: Entry) => Scope.close(entry.scope, Exit.void).pipe(Effect.ignore);

  const streamTombstone = (entry: Entry, stream: TerminalLogStream): ArchiveTombstoneStream => ({
    archived: entry.spillPaths.some(
      (candidate) => path.basename(candidate) === spillFileName(entry.snapshot.id, stream),
    ),
  });

  const rememberPrunedArchive = (entry: Entry) => {
    archiveTombstones.set(entry.snapshot.id, {
      reason: "pruned",
      stdout: streamTombstone(entry, "stdout"),
      stderr: streamTombstone(entry, "stderr"),
    });
    while (archiveTombstones.size > MAX_SETTLED_HISTORY) {
      const oldest = archiveTombstones.keys().next().value;
      if (oldest === undefined) break;
      archiveTombstones.delete(oldest);
    }
  };

  const removeEntrySpills = (entry: Entry) =>
    Effect.sync(() => {
      // Record only immutable metadata before unlinking. Tombstones never keep
      // a spill path or file descriptor alive. pruneSettled records first to
      // close the deletion/read race; this guard covers any later caller.
      if (!archiveTombstones.has(entry.snapshot.id)) {
        rememberPrunedArchive(entry);
      }
      for (const spillPath of entry.spillPaths) {
        try {
          fs.rmSync(spillPath, { force: true });
        } catch {
          // Best effort: disposeAll still removes the complete session dir.
        }
      }
      entry.stdoutBuf.spillPath = undefined;
      entry.stderrBuf.spillPath = undefined;
    });

  const pruneSettled = () => {
    if (entries.size <= MAX_TRACKED) return;
    const candidates = [...entries.values()]
      .filter((e) => e.snapshot.status !== "running" && !killInterest.has(e.snapshot.id))
      .sort(
        (a, b) =>
          (a.snapshot.settledAt ?? a.snapshot.createdAt) -
          (b.snapshot.settledAt ?? b.snapshot.createdAt),
      );
    for (const entry of candidates) {
      if (entries.size <= MAX_TRACKED) break;
      // Make the expired-ref fact visible before the async unlink starts.
      rememberPrunedArchive(entry);
      entries.delete(entry.snapshot.id);
      runCleanup(closeEntryScope(entry).pipe(Effect.andThen(removeEntrySpills(entry))));
    }
  };

  const markArchiveCompleteness = (entry: Entry) => {
    const complete = entry.stdioClosed;
    entry.stdoutBuf.archiveComplete = complete && entry.stdoutBuf.spillPath !== undefined;
    entry.stderrBuf.archiveComplete = complete && entry.stderrBuf.spillPath !== undefined;
  };

  /** End all spill streams; resolves when their buffers are flushed to disk
   * (bounded), so a settle notification never points at a partial file. */
  const flushSpillStreams = (entry: Entry) => {
    const streams = entry.spillStreams;
    entry.spillStreams = [];
    return Effect.forEach(
      streams,
      (stream) =>
        Effect.callback<void>((resume) => {
          const done = () => resume(Effect.void);
          try {
            stream.end(done);
          } catch {
            // Best effort; tmpdir contents are disposable.
            done();
          }
        }),
      { concurrency: "unbounded", discard: true },
    ).pipe(
      Effect.timeoutOrElse({
        duration: SPILL_FLUSH_TIMEOUT_MS,
        orElse: () =>
          Effect.sync(() => {
            entry.stdoutBuf.spillPath = undefined;
            entry.stderrBuf.spillPath = undefined;
            entry.snapshot.errorText ??=
              "Full-log spill flush timed out; full output may be incomplete";
          }),
      }),
      Effect.andThen(Effect.sync(() => markArchiveCompleteness(entry))),
    );
  };

  /** Single settle path — idempotent; kill vs natural exit vs error races are
   * resolved by whichever lands first (the second call is a no-op). */
  const settle = (entry: Entry) => {
    const s = entry.snapshot;
    if (s.status !== "running") return;
    if (entry.timeoutHandle) {
      clearTimeout(entry.timeoutHandle);
      entry.timeoutHandle = undefined;
    }
    s.settledAt = Date.now();
    s.status = entry.timedOut
      ? "timed_out"
      : entry.killSignaled
        ? "killed"
        : entry.processErrored
          ? "failed"
          : s.exitCode === 0
            ? "done"
            : "failed";
    settledHistory.set(s.id, {
      title: s.title,
      status: s.status,
      exit: formatExit(s),
    });
    while (settledHistory.size > MAX_SETTLED_HISTORY) {
      const oldest = settledHistory.keys().next().value;
      if (oldest === undefined) break;
      settledHistory.delete(oldest);
    }
    // Mark bash waiters before completing the Deferred: whichever side of
    // the yield/settle race wins owns the result without a duplicate follow-up.
    const waiters = settlementWaiters.get(s.id);
    for (const waiter of waiters ?? []) waiter.consumed = true;
    const consumed = (killInterest.get(s.id) ?? 0) > 0 || (waiters?.size ?? 0) > 0;
    Deferred.doneUnsafe(entry.settled, Effect.void);
    // The tree is final: close the Windows job so detached descendants that
    // no PID path can reach are reaped now rather than at Pi exit.
    entry.childJob?.close();
    notify(s.id);
    try {
      // During teardown, don't queue results into a shutting-down session.
      if (!disposed) onSettled?.(s, consumed);
    } catch {
      // The parent session may be unavailable; settlement stays final.
    }
    pruneSettled();
  };

  /** Flush the spill files, then settle: the completion follow-up (and the
   * kill() resolution) depend on the final capture metadata, so the full
   * archive must be on disk before anyone is told about it. Idempotent via
   * `settling`. */
  const settleAfterFlush = (entry: Entry) => {
    if (entry.settling || entry.snapshot.status !== "running") return;
    entry.settling = true;
    runCleanup(flushSpillStreams(entry).pipe(Effect.andThen(Effect.sync(() => settle(entry)))));
  };

  const scheduleExitCleanup = (entry: Entry) => {
    if (entry.exitCleanupStarted) return;
    entry.exitCleanupStarted = true;
    runCleanup(
      Effect.sleep(SETTLE_GRACE_MS).pipe(
        Effect.andThen(
          Effect.suspend(() =>
            entry.snapshot.status === "running" && !entry.stdioClosed
              ? closeEntryScope(entry).pipe(Effect.timeout(STOP_TIMEOUT_MS), Effect.ignore)
              : Effect.void,
          ),
        ),
      ),
    );
  };

  const resolveSpillDir = () => {
    if (spillDir !== undefined) return spillDir ?? undefined;
    try {
      const base = path.join(os.tmpdir(), "pi-background-terminals");
      fs.mkdirSync(base, { recursive: true, mode: 0o700 });
      fs.chmodSync(base, 0o700);
      spillDir = fs.mkdtempSync(path.join(base, "session-"));
      fs.chmodSync(spillDir, 0o700);
    } catch {
      spillDir = null;
    }
    return spillDir ?? undefined;
  };

  const makeSpill = (
    entry: () => Entry | undefined,
    id: string,
    stream: TerminalLogStream,
    resumeSource: () => void,
  ) => {
    const dir = resolveSpillDir();
    if (!dir) return undefined;
    const spillPath = path.join(dir, spillFileName(id, stream));
    try {
      const file = fs.createWriteStream(spillPath, {
        flags: "a",
        mode: 0o600,
      });
      let broken = false;
      let capped = false;
      let writtenBytes = 0;
      file.on("error", (error) => {
        broken = true;
        resumeSource();
        const current = entry();
        if (current) {
          const buf = stream === "stdout" ? current.stdoutBuf : current.stderrBuf;
          buf.spillPath = undefined;
          current.snapshot.errorText ??= bounded(
            `Full-log spill failed: ${boundedSpillError(error, spillPath)}`,
          );
        }
      });
      return {
        spillPath,
        file,
        write: (chunk: string) => {
          // writableEnded guard: late 'data' after the settle flush must not
          // error the ended stream (and falsely report the spill as broken).
          if (broken || capped || file.writableEnded) return true;
          const chunkBytes = Buffer.byteLength(chunk, "utf8");
          if (writtenBytes + chunkBytes > MAX_SPILL_BYTES_PER_STREAM) {
            capped = true;
            const current = entry();
            if (current) {
              const buf = stream === "stdout" ? current.stdoutBuf : current.stderrBuf;
              buf.spillPath = undefined;
              current.snapshot.errorText ??= bounded(
                `${stream} full-log spill reached the ${MAX_SPILL_BYTES_PER_STREAM}-byte safety limit`,
              );
            }
            return true;
          }
          writtenBytes += chunkBytes;
          const accepted = file.write(chunk);
          if (!accepted) file.once("drain", resumeSource);
          return accepted;
        },
      };
    } catch {
      return undefined;
    }
  };

  const start = (options: StartOptions) =>
    Effect.gen(function* () {
      // Reserve synchronously (before the first yield inside doStart) so
      // parallel tool calls cannot race past the cap.
      yield* Effect.suspend((): Effect.Effect<void, SpawnError | ConcurrencyLimitError> => {
        if (disposed) {
          return new SpawnError({
            message: "Background terminal manager is shutting down.",
            fallbackSafe: false,
          });
        }
        if (runningCount() + reserved >= MAX_RUNNING) {
          return new ConcurrencyLimitError({
            message: `Max ${MAX_RUNNING} background terminals can run concurrently. Stop one from /ps before starting another.`,
          });
        }
        reserved++;
        return Effect.void;
      });

      const doStart = Effect.gen(function* () {
        const invocation = yield* Effect.try({
          try: () =>
            shellInvocation(options.executionCommand ?? options.command, options.shellPath),
          catch: (error) =>
            new SpawnError({
              message: boundedError(error),
              fallbackSafe: true,
            }),
        });
        const child = yield* Effect.try({
          try: () => {
            const spawned = spawn(invocation.shell, invocation.args, {
              cwd: options.cwd,
              env: options.env ?? process.env,
              // No interactive stdin. The sole exception is legacy WSL Bash's
              // one-shot script transport, which is closed immediately below.
              stdio: [invocation.commandInput === undefined ? "ignore" : "pipe", "pipe", "pipe"],
              // Own process group on POSIX → group kill takes the whole tree.
              detached: process.platform !== "win32",
              windowsHide: true,
            });
            if (invocation.commandInput !== undefined) {
              spawned.stdin?.on("error", () => {});
              spawned.stdin?.end(invocation.commandInput);
            }
            return spawned;
          },
          catch: (error) =>
            new SpawnError({
              message: boundedError(error),
              fallbackSafe: true,
            }),
        });

        const childPid = child.pid;
        if (childPid) detachedChildren.track(childPid);
        // Assign the tree to a dedicated Windows job in the same tick as the
        // spawn, before the shell can create descendants. Never fails start:
        // cleanup falls back to the PID-based paths when unavailable.
        const childJob = childPid
          ? yield* Effect.promise(() => assignChildJob(childPid))
          : undefined;
        if (childJob) detachedChildren.trackJob(childJob);

        const id = `bt-${++counter}`;
        const entryRef = () => entries.get(id);
        const stdoutSpill = makeSpill(entryRef, id, "stdout", () => child.stdout?.resume());
        const stderrSpill = makeSpill(entryRef, id, "stderr", () => child.stderr?.resume());
        const stdoutBuf = new OutputBuffer(
          RETAINED_PER_STREAM,
          stdoutSpill?.write,
          HEAD_RETAINED_PER_STREAM,
        );
        const stderrBuf = new OutputBuffer(
          RETAINED_PER_STREAM,
          stderrSpill?.write,
          HEAD_RETAINED_PER_STREAM,
        );
        stdoutBuf.spillPath = stdoutSpill?.spillPath;
        stderrBuf.spillPath = stderrSpill?.spillPath;

        const snapshot: MutableSnapshot = {
          id,
          command: options.command,
          title: options.title,
          cwd: options.cwd,
          pid: child.pid,
          status: "running",
          createdAt: Date.now(),
          timeoutMs: options.timeoutMs,
          get stdout() {
            return stdoutBuf.view();
          },
          get stderr() {
            return stderrBuf.view();
          },
        };

        const scope = yield* Scope.make();
        const settled = yield* Deferred.make<void>();
        const entry: Entry = {
          snapshot,
          child,
          childJob,
          scope,
          stdoutBuf,
          stderrBuf,
          spillStreams: [stdoutSpill?.file, stderrSpill?.file].filter(
            (file): file is fs.WriteStream => file !== undefined,
          ),
          spillPaths: [stdoutSpill?.spillPath, stderrSpill?.spillPath].filter(
            (spillPath): spillPath is string => spillPath !== undefined,
          ),
          killSignaled: false,
          processErrored: false,
          exited: false,
          stdioClosed: false,
          settling: false,
          timedOut: false,
          exitCleanupStarted: false,
          settled,
        };

        // Plain-callback stream plumbing (the codex-backend precedent):
        // setEncoding's internal StringDecoder is multibyte-safe across
        // chunk boundaries.
        child.stdout?.setEncoding("utf8");
        child.stdout?.on("data", (chunk: string) => {
          if (!stdoutBuf.push(chunk)) child.stdout?.pause();
          notify(id);
        });
        child.stderr?.setEncoding("utf8");
        child.stderr?.on("data", (chunk: string) => {
          if (!stderrBuf.push(chunk)) child.stderr?.pause();
          notify(id);
        });
        // Spawn failures (ENOENT etc.) arrive via 'error', not a throw. Node
        // still emits 'close' afterwards (with a bogus errno as code), so
        // record the failure here and let the close path do the one settle.
        child.once("error", (error) => {
          entry.processErrored = true;
          snapshot.errorText ??= boundedError(error);
          entry.exited = true;
          settleAfterFlush(entry);
        });
        // Record code/signal on 'exit'; settle on 'close' so the completion
        // notification always carries the final flushed output.
        child.once("exit", (code, signal) => {
          entry.exited = true;
          snapshot.exitCode = code ?? undefined;
          snapshot.signal = signal ?? undefined;
          // A descendant can keep the pipes open after the shell exits. Give
          // close a short natural grace, then close the scope to terminate
          // the surviving process group and force a bounded settlement.
          scheduleExitCleanup(entry);
        });
        child.once("close", (code, signal) => {
          if (childPid) detachedChildren.untrack(childPid);
          entry.exited = true;
          entry.stdioClosed = true;
          // Only trust close's code/signal when 'exit' never fired (a spawn
          // 'error' close reports the errno, e.g. -2, as its code).
          if (!entry.processErrored) {
            snapshot.exitCode ??= code ?? undefined;
            snapshot.signal ??= signal ?? undefined;
          }
          settleAfterFlush(entry);
        });

        // One teardown path: kill(), requestKill, pruning, disposeAll, and
        // runtime.dispose() all converge on closing this scope.
        yield* Scope.provide(
          Effect.addFinalizer(() =>
            Effect.gen(function* () {
              // Only claim "killed" when we are actually about to signal a
              // live process; a natural exit that already happened (still
              // waiting on 'close') keeps its truthful done/failed status.
              yield* terminateChild(
                child,
                () => entry.stdioClosed,
                () => {
                  entry.killSignaled ||= !entry.exited && entry.snapshot.status === "running";
                },
                () => entry.childJob?.close(),
              );
              // Give the natural close→flush→settle path a bounded grace,
              // then force the settle: a grandchild holding the pipe open
              // (detached into a new group) must not leave the entry
              // "running" forever.
              if (entry.snapshot.status === "running") {
                yield* Deferred.await(entry.settled).pipe(
                  Effect.timeout(SETTLE_GRACE_MS),
                  Effect.ignore,
                );
              }
              if (entry.snapshot.status === "running" && !entry.settling) {
                // Force the settle ourselves. When `settling` is set, the
                // close path's flush→settle is already in flight (bounded by
                // SPILL_FLUSH_TIMEOUT_MS) — settling here first would cite a
                // spill file that is still being flushed.
                if (!entry.stdioClosed) {
                  entry.snapshot.errorText ??=
                    "stdio did not close after termination; output may be incomplete";
                }
                entry.settling = true;
                yield* flushSpillStreams(entry);
                settle(entry);
              }
              // The backstop: whatever the settle path decided, closing the
              // job terminates any descendant still holding stdio pipes —
              // PID-based kills cannot reach the re-parented survivors.
              entry.childJob?.close();
              if (childPid) detachedChildren.untrack(childPid);
            }),
          ),
          scope,
        );

        // disposeAll may have swept the entries map while we were setting up;
        // an entry added after the sweep would never be torn down. Close our
        // own scope (kills the child) and fail instead (subagents precedent).
        if (disposed) {
          yield* closeEntryScope(entry);
          return yield* new SpawnError({
            message: "Background terminal manager shut down while starting.",
            fallbackSafe: false,
          });
        }
        entries.set(id, entry);
        if (options.timeoutMs !== undefined) {
          entry.timeoutHandle = setTimeout(() => {
            if (entry.snapshot.status !== "running") return;
            // Preserve a natural exit that already won but whose descendants
            // still hold stdout/stderr open; the timeout may reap that tree,
            // but must not rewrite the truthful final status.
            entry.timedOut ||= !entry.exited;
            if (entry.timedOut) {
              entry.snapshot.errorText ??= `Command exceeded its ${options.timeoutMs}-ms runtime timeout`;
            }
            runCleanup(closeEntryScope(entry).pipe(Effect.timeout(STOP_TIMEOUT_MS), Effect.ignore));
          }, options.timeoutMs);
          entry.timeoutHandle.unref();
        }
        notify(id);
        return snapshot as TerminalSnapshot;
      });

      // Uninterruptible: between spawn() and entries.set there must be no
      // window where an interrupt (tool abort, runtime dispose) leaves a
      // live child that no scope/registry knows about. All steps are sync.
      return yield* doStart.pipe(
        Effect.uninterruptible,
        Effect.ensuring(
          Effect.sync(() => {
            reserved--;
            notify();
          }),
        ),
      );
    });

  const waitForSettlement = (id: string, timeoutMs: number) =>
    Effect.suspend((): Effect.Effect<SettlementWaitResult, UnknownTerminalError> => {
      const entry = entries.get(id);
      if (!entry) {
        const known = [...entries.keys()];
        return new UnknownTerminalError({
          message: `Unknown terminal id "${id}". Known: ${known.join(", ") || "none"}.`,
        });
      }
      if (entry.snapshot.status !== "running") {
        return Effect.succeed({
          snapshot: entry.snapshot as TerminalSnapshot,
          settled: true,
        });
      }

      const waiter = { consumed: false };
      const removeWaiter = () => {
        const current = settlementWaiters.get(id);
        current?.delete(waiter);
        if (current?.size === 0) settlementWaiters.delete(id);
      };
      const finish = Effect.sync((): SettlementWaitResult => {
        // This synchronous removal linearizes timeout vs settle: a later
        // settle sees no waiter and is therefore delivered as a follow-up.
        removeWaiter();
        return {
          snapshot: entry.snapshot as TerminalSnapshot,
          settled: waiter.consumed || entry.snapshot.status !== "running",
        };
      });
      const waitMs = Math.max(MIN_YIELD_TIME_MS, Math.min(MAX_YIELD_TIME_MS, timeoutMs));

      return Effect.sync(() => {
        let waiters = settlementWaiters.get(id);
        if (!waiters) {
          waiters = new Set();
          settlementWaiters.set(id, waiters);
        }
        waiters.add(waiter);
      }).pipe(
        Effect.andThen(
          Effect.raceFirst(Deferred.await(entry.settled), Effect.sleep(waitMs)).pipe(
            Effect.andThen(finish),
          ),
        ),
        Effect.ensuring(Effect.sync(removeWaiter)),
      );
    });

  const status = (id: string) =>
    Effect.suspend((): Effect.Effect<TerminalSnapshot, UnknownTerminalError> => {
      const entry = entries.get(id);
      if (!entry) {
        const known = [...entries.keys()];
        return new UnknownTerminalError({
          message: `Unknown terminal id "${id}". Known: ${known.join(", ") || "none"}.`,
        });
      }
      return Effect.succeed(entry.snapshot as TerminalSnapshot);
    });

  const readLog = (request: TerminalLogReadRequest) =>
    Effect.suspend(
      (): Effect.Effect<
        TerminalLogReadResult,
        UnknownTerminalError | TerminalLogUnavailableError
      > => {
        const entry = entries.get(request.id);
        if (!entry) {
          const tombstone = archiveTombstones.get(request.id);
          if (tombstone) {
            if (tombstone[request.stream].archived) {
              return new TerminalLogUnavailableError({
                message:
                  `Archive ${request.id}:${request.stream} expired when the terminal was pruned from the ${MAX_TRACKED}-entry retention cap. ` +
                  "It cannot be recovered. Work with the output already available or re-run the command.",
              });
            }
            return new TerminalLogUnavailableError({
              message: `Archive ${request.id}:${request.stream} is unavailable; its output was small enough that the terminal result already contains all of it.`,
            });
          }
          return new UnknownTerminalError({
            message: `Unknown terminal id "${request.id}"; no terminal with that id is tracked in this session.`,
          });
        }
        const buffer = request.stream === "stdout" ? entry.stdoutBuf : entry.stderrBuf;
        const spillPath = buffer.spillPath;
        if (!spillPath) {
          return new TerminalLogUnavailableError({
            message: `Archive ${request.id}:${request.stream} is unavailable.`,
          });
        }
        const offset = Number.isFinite(request.offset)
          ? Math.max(0, Math.floor(request.offset))
          : 0;
        const limit = Number.isFinite(request.limit)
          ? Math.max(1, Math.min(MAX_TERMINAL_LOG_READ_BYTES, Math.floor(request.limit)))
          : MAX_TERMINAL_LOG_READ_BYTES;
        return Effect.try({
          try: () => {
            const size = fs.statSync(spillPath).size;
            const start = Math.min(offset, size);
            const length = Math.min(limit, size - start);
            let raw = Buffer.alloc(0);
            if (length > 0) {
              const fd = fs.openSync(spillPath, "r");
              try {
                const window = Buffer.allocUnsafe(length);
                const bytesRead = fs.readSync(fd, window, 0, length, start);
                raw = window.subarray(0, bytesRead);
              } finally {
                fs.closeSync(fd);
              }
            }
            // Snap both edges to code-point boundaries. Without this a window
            // that splits a multi-byte character decodes to U+FFFD, which
            // silently corrupts the text AND every page stitched after it.
            const leading = start > 0 ? codePointStart(raw) : 0;
            const body = raw.subarray(leading);
            const atEof = start + raw.length >= size;
            const complete = completeCodePointEnd(body);
            // Only trim a split trailing sequence when the rest of it is
            // already on disk. At EOF there is nothing to stitch to, and a
            // window too small to hold one code point must still advance.
            const bytes = atEof || complete === 0 ? body : body.subarray(0, complete);
            const readOffset = start + leading;
            return {
              id: request.id,
              stream: request.stream,
              offset: readOffset,
              nextOffset: readOffset + bytes.length,
              bytesRead: bytes.length,
              size,
              settled: entry.snapshot.status !== "running",
              complete: buffer.archiveComplete === true,
              text: bytes.toString("utf8"),
            } satisfies TerminalLogReadResult;
          },
          catch: () =>
            new TerminalLogUnavailableError({
              message: `Archive ${request.id}:${request.stream} could not be read.`,
            }),
        });
      },
    );

  /** Kill one running entry: close the scope — whose finalizer marks the kill
   * at the signal point, terminates the tree, and force-settles —
   * in a DETACHED fiber. Once the flag is set the termination must actually
   * happen; a tool abort interrupting the caller cannot cancel it (this is
   * what makes "termination continues in the background" truthful). */
  const killEntry = (entry: Entry) =>
    Effect.sync(() => {
      if (entry.snapshot.status !== "running") return;
      runCleanup(closeEntryScope(entry).pipe(Effect.timeout(STOP_TIMEOUT_MS), Effect.ignore));
    });

  const kill = (ids: ReadonlyArray<string>) =>
    Effect.suspend(() => {
      const unique = [...new Set(ids)];
      const byId = new Map(
        unique
          .map((id) => entries.get(id))
          .filter((entry): entry is Entry => entry !== undefined)
          .map((entry) => [entry.snapshot.id, entry]),
      );
      const running = [...byId.values()].filter((entry) => entry.snapshot.status === "running");
      const runningIds = running.map((entry) => entry.snapshot.id);
      // Mark consumed before signaling so this kill's settlements are not
      // ALSO queued as automatic follow-up messages to the model.
      addKillInterest(runningIds);
      const work = Effect.gen(function* () {
        yield* Effect.forEach(running, killEntry, {
          concurrency: "unbounded",
        });
        // Every caller waits on the entries that were running when its kill
        // began. Deferred completion cannot be missed and supports concurrent
        // overlapping/multi-id kill calls.
        yield* Effect.forEach(running, (entry) => Deferred.await(entry.settled), {
          concurrency: "unbounded",
          discard: true,
        });
        // Capture the report BEFORE the ensuring below releases interest and
        // prunes — a just-settled entry must not vanish out from under it.
        return unique.map((id): KillResult => {
          const snapshot = byId.get(id)?.snapshot;
          const history = settledHistory.get(id);
          const status = snapshot?.status ?? history?.status ?? "killed";
          const wasRunning = runningIds.includes(id);
          return {
            id,
            title: snapshot?.title ?? history?.title ?? "?",
            status,
            wasRunning,
            // A natural exit can win the race with our SIGTERM; report what
            // actually happened rather than claiming the kill did it.
            killed: wasRunning && status === "killed",
            exit: snapshot ? formatExit(snapshot) : (history?.exit ?? "unknown"),
          };
        });
      });
      return work.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            releaseKillInterest(runningIds);
            pruneSettled();
          }),
        ),
      );
    });

  const disposeAll = Effect.gen(function* () {
    disposed = true;
    const all = [...entries.values()];
    entries.clear();
    for (const entry of all) {
      if (entry.timeoutHandle) {
        clearTimeout(entry.timeoutHandle);
        entry.timeoutHandle = undefined;
      }
    }
    yield* Effect.forEach(
      all,
      (entry) => closeEntryScope(entry).pipe(Effect.timeout(STOP_TIMEOUT_MS), Effect.ignore),
      { concurrency: "unbounded" },
    );
    // Detached kill/prune/flush work is scoped to the manager. Wait for it
    // within the shutdown bound; the FiberSet finalizer interrupts anything
    // still live when the manager scope closes, so cleanup cannot leak.
    yield* FiberSet.awaitEmpty(cleanupFibers).pipe(Effect.timeout(STOP_TIMEOUT_MS), Effect.ignore);
    yield* Effect.sync(() => {
      // Tombstones are session-scoped metadata; disposal must not retain them.
      archiveTombstones.clear();
      const dir = spillDir;
      spillDir = null;
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    });
    yield* Effect.sync(() => notify());
  });

  const listNewestFirst = () => Array.from(entries.values(), (entry) => entry.snapshot).reverse();

  const view: TerminalReadModel = {
    list: listNewestFirst,
    get: (id) => entries.get(id)?.snapshot,
    size: () => entries.size,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeTo: (id, listener) => {
      let set = idListeners.get(id);
      if (!set) {
        set = new Set();
        idListeners.set(id, set);
      }
      set.add(listener);
      return () => {
        set.delete(listener);
        if (set.size === 0) idListeners.delete(id);
      };
    },
    requestKill: (id) => {
      const entry = entries.get(id);
      if (!entry) return;
      // UI-initiated kills are not "consumed": the killed result still flows
      // back to the model as a follow-up message (subagents precedent).
      runCleanup(killEntry(entry).pipe(Effect.ignore));
    },
    setOnSettled: (hook) => {
      onSettled = hook;
    },
  };

  // Safety net: disposing the ManagedRuntime tears everything down even if
  // the extension forgot to call disposeAll explicitly.
  yield* Effect.addFinalizer(() => disposeAll);

  return TerminalManager.of({
    start,
    waitForSettlement,
    status,
    readLog,
    kill,
    list: Effect.sync(listNewestFirst),
    disposeAll,
    view,
  });
});

export const TerminalManagerLive: Layer.Layer<TerminalManager> = Layer.effect(
  TerminalManager,
  makeManager,
);
