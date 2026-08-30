import { spawn, type ChildProcess } from "node:child_process";
import {
  AgySpawnError,
  AgyStallError,
  buildDriverAgyArgs,
  runAgyTurn,
  type AgyTurnRequest,
} from "./agy-client.ts";
import { killAgyTree, signalAgyTree, trackAgyChild, untrackAgyChild } from "./agy-children.ts";
import { AgyCompatibilityError, checkAgyBinary } from "./agy-diagnostics.ts";
import { parseAgyLine } from "./events.ts";
import { applyEvent, newTurnOutcome, type AgyTurnOutcome } from "./reducer.ts";

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
  toolActive: boolean;
  conversationReported: boolean;
  overallTimer?: NodeJS.Timeout;
  stallTimer?: NodeJS.Timeout;
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
    if (checked && !checked.ok) throw new AgyCompatibilityError(checked);
    const binary = request.binary ?? checked?.binary;
    if (!binary) throw new AgySpawnError("agy binary resolution returned no executable.", "");
    const nextConfig = processConfig(request, binary, checked?.version, checked?.revision);
    if (this.#child) {
      const cause = recycleCause(request, this.#config, nextConfig, this.#boundConversationId);
      if (cause) await this.close("recycle", cause);
      else this.#reusedTurns += 1;
    }
    if (!this.#child) await this.#start(request, nextConfig);
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
      toolActive: false,
      conversationReported: false,
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
      const child = this.#child;
      if (this.#active !== turn || !child) return;
      this.#detachChild(child, "dead");
      killAgyTree(child);
      this.#settleTurn(turn, {
        error: new AgySpawnError(
          `agy turn timed out after ${Math.round(overallMs / 1000)}s`,
          this.#stderrTail,
        ),
      });
    }, overallMs);

    const onAbort = () => {
      const child = this.#child;
      if (this.#active !== turn) return;
      if (child) {
        this.#detachChild(child, "dead");
        killAgyTree(child);
      }
      this.#settleTurn(turn, { outcome: abortOutcome() });
    };
    turn.abortHandler = onAbort;
    turn.request.signal?.addEventListener("abort", onAbort, { once: true });
    this.#rearmStall(turn);
  }

  #rearmStall(turn: ActiveTurn): void {
    if (this.#active !== turn) return;
    if (turn.stallTimer) clearTimeout(turn.stallTimer);
    const baseMs = turn.request.inactivityTimeoutMs ?? 120_000;
    if (baseMs <= 0) return;
    const toolMs = turn.request.toolInactivityTimeoutMs ?? Math.max(baseMs, 300_000);
    const budgetMs = turn.toolActive ? toolMs : baseMs;
    turn.stallTimer = setTimeout(() => {
      const child = this.#child;
      if (this.#active !== turn || !child) return;
      this.#detachChild(child, "dead");
      killAgyTree(child);
      this.#settleTurn(turn, { error: new AgyStallError(budgetMs, turn.toolActive) });
    }, budgetMs);
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
      this.#detachChild(child, "dead");
      killAgyTree(child);
      this.#stdoutBuffer = "";
      this.#settleTurn(turn, {
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
      if (activity.type === "tool_start") turn.toolActive = true;
      else if (activity.type === "tool_done" || activity.type === "tool_error") {
        turn.toolActive = false;
      }
      turn.request.onActivity?.(activity);
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
      this.#settleTurn(turn, {
        error: new AgySpawnError(
          `agy exited with code ${code ?? signal ?? "signal"} before producing a result${tail ? `: ${tail}` : ""}`,
          this.#stderrTail,
        ),
      });
    }
  }

  #settleTurn(turn: ActiveTurn, result: { outcome: AgyTurnOutcome } | { error: unknown }): void {
    if (this.#active !== turn) return;
    if (turn.overallTimer) clearTimeout(turn.overallTimer);
    if (turn.stallTimer) clearTimeout(turn.stallTimer);
    if (turn.abortHandler) turn.request.signal?.removeEventListener("abort", turn.abortHandler);
    this.#active = undefined;
    if (this.#child) this.#state = "ready";
    if ("error" in result) turn.reject(result.error);
    else turn.resolve(result.outcome);
  }

  #detachChild(child: DriverChild, nextState: AgyDriverState): void {
    if (this.#child !== child) return;
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
