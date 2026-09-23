/**
 * Optional local debug log for studying how grep/find are used and where they
 * mislead: which limits bind, how often globs reject everything, which notices
 * fire, and — joined with the pi session via sessionFile/toolCallId — what the
 * model did next. Strictly opt-in: no file is touched and no session metadata
 * is read unless PI_FIND_DEBUG is set to 1/true/on (PI_FIND_DEBUG_FILE alone
 * does not enable it), and a logging failure never fails a search.
 */

import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import nodePath from "node:path";

/** Bump when a field changes meaning so old and new events are not mixed. */
export const DEBUG_EVENT_VERSION = 2;

/** The active log is rotated to `<file>.1` once it reaches this size. */
export const MAX_DEBUG_LOG_BYTES = 10 * 1024 * 1024;

/** Stable notice identifiers; wording changes must not break aggregation. */
export type NoticeId =
  | "quoted_path"
  | "result_limit"
  | "output_limit"
  | "oversized_record"
  | "timeout"
  | "auto_context"
  | "file_size_limit"
  | "hidden_path"
  | "slash_glob"
  | "glob_prefix"
  | "unreadable_path";

export interface Notice {
  readonly id: NoticeId;
  readonly text: string;
}

/** Outcome of a completed search, beyond what the session log already records. */
export interface SearchStats {
  /** Results shown to the model (matches, or files in files mode). */
  readonly resultCount: number;
  /** Results collected before the output byte budget was applied. */
  readonly collectedCount: number;
  readonly fileCount: number;
  /** The result/file cap stopped the binary early. */
  readonly resultLimitHit: boolean;
  /** The rendered output exceeded the byte budget and was cut. */
  readonly outputLimitHit: boolean;
  readonly timedOut: boolean;
  readonly skippedRecords: number;
  /** Records the binary produced that the glob then rejected. */
  readonly rejectedByGlob: number;
  /** Basename filter handed to rg/fd; "*" means the whole tree was enumerated. */
  readonly prefilter: string;
  /** Bytes of the full text returned to the model: the per-call context cost. */
  readonly outputBytes: number;
  /** First unreadable-path message when the walk skipped paths. */
  readonly pathError?: string;
  /** The grep path named one file, so traversal rules did not apply. */
  readonly explicitFile?: boolean;
  /** Returned grep match lines clipped to the line length cap. */
  readonly clippedLines?: number;
  /** Files rg actually searched; present only for content searches that ran to completion. */
  readonly searchedFiles?: number;
  readonly searchedBytes?: number;
  readonly contextLines?: number;
  /** Context existed but was dropped because it did not fit the output budget. */
  readonly droppedContext?: boolean;
  readonly notices: readonly NoticeId[];
}

export interface SearchDebugEvent extends Partial<SearchStats> {
  readonly v: number;
  readonly ts: string;
  readonly tool: "grep" | "find";
  readonly cwd: string;
  readonly sessionId?: string;
  readonly sessionFile?: string;
  readonly toolCallId: string;
  readonly model?: string;
  readonly params: Record<string, unknown>;
  readonly durationMs: number;
  readonly outcome: "ok" | "error" | "aborted";
  readonly errorTag?: string;
  readonly exitCode?: number;
  readonly error?: string;
}

/** The subset of the pi tool context the log reads; every field is optional so a bare `{ cwd }` works. */
export interface SearchLogContext {
  readonly cwd: string;
  readonly sessionManager?: {
    getSessionId(): string;
    getSessionFile(): string | undefined;
  };
  readonly model?: { readonly provider: string; readonly id: string };
}

export interface SearchLogCall {
  readonly tool: "grep" | "find";
  readonly toolCallId: string;
  readonly params: Record<string, unknown>;
  readonly ctx: SearchLogContext;
}

export function debugEnabled(): boolean {
  const value = process.env.PI_FIND_DEBUG;
  return value === "1" || value === "true" || value === "on";
}

export function debugFile(): string {
  return (
    process.env.PI_FIND_DEBUG_FILE ?? nodePath.join(homedir(), ".pi", "pi-find", "debug.jsonl")
  );
}

function appendEvent(event: SearchDebugEvent): void {
  try {
    const file = debugFile();
    mkdirSync(nodePath.dirname(file), { recursive: true });
    try {
      if (statSync(file).size >= MAX_DEBUG_LOG_BYTES) renameSync(file, `${file}.1`);
    } catch {
      // No log yet.
    }
    appendFileSync(file, `${JSON.stringify(event)}\n`);
  } catch {
    // Debug logging must never break a search.
  }
}

function sessionFields(ctx: SearchLogContext) {
  try {
    return {
      sessionId: ctx.sessionManager?.getSessionId(),
      sessionFile: ctx.sessionManager?.getSessionFile(),
      model: ctx.model === undefined ? undefined : `${ctx.model.provider}/${ctx.model.id}`,
    };
  } catch {
    return {};
  }
}

function failureFields(error: unknown) {
  const cause = error instanceof Error ? error.cause : undefined;
  const typed =
    typeof cause === "object" && cause !== null && "_tag" in cause
      ? (cause as { readonly _tag: string; readonly exitCode?: number })
      : undefined;
  return {
    outcome: error instanceof Error && error.name === "AbortError" ? "aborted" : "error",
    errorTag: typed?._tag,
    exitCode: typed?.exitCode,
    error: error instanceof Error ? error.message : String(error),
  } as const;
}

/**
 * Run one search and, only when debugging is enabled, append its event.
 * The search result and any thrown error pass through unchanged.
 */
export async function withSearchLog<T>(
  call: SearchLogCall,
  run: () => Promise<{ readonly result: T; readonly stats: SearchStats }>,
): Promise<T> {
  if (!debugEnabled()) return (await run()).result;
  const startedAt = Date.now();
  const base = () => ({
    v: DEBUG_EVENT_VERSION,
    ts: new Date(startedAt).toISOString(),
    tool: call.tool,
    cwd: call.ctx.cwd,
    ...sessionFields(call.ctx),
    toolCallId: call.toolCallId,
    params: call.params,
    durationMs: Date.now() - startedAt,
  });
  try {
    const { result, stats } = await run();
    appendEvent({ ...base(), outcome: "ok", ...stats });
    return result;
  } catch (error) {
    appendEvent({ ...base(), ...failureFields(error) });
    throw error;
  }
}
