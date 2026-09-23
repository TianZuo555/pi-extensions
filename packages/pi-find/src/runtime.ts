/** Effect service backing the deliberately small grep and find tools. */

import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import * as nodePath from "node:path";
import { Cause, Context, Effect, Exit, Layer, ManagedRuntime, Result } from "effect";
import { Minimatch } from "minimatch";
import {
  AUTO_CONTEXT_LINES,
  AUTO_CONTEXT_MAX_MATCHES,
  EMPTY_PATTERN_ERROR,
  GREP_FILE_LIMIT,
  FIND_RESULT_LIMIT,
  findPathNotDirectoryError,
  GREP_RESULT_LIMIT,
  GIT_PATH_ERROR,
  missingSearchPathError,
} from "../lib/prompt.ts";
import { decodeRgEvent } from "../lib/rg-json.ts";
import { SearchInputError, toThrowable, type SearchError } from "./errors.ts";
import { streamLines } from "./stream.ts";

export const MAX_LINE_LENGTH = 400;

export type GrepOutput = "content" | "files";

export interface GrepRequest {
  readonly pattern: string;
  readonly path?: string;
  readonly glob?: string;
  readonly output?: GrepOutput;
  readonly literal?: boolean;
  readonly cwd: string;
  readonly signal?: AbortSignal;
}

export interface GrepMatch {
  readonly path: string;
  readonly lineNumber: number;
  readonly text: string;
}

export interface GrepOutcome {
  readonly output: GrepOutput;
  readonly matches: readonly GrepMatch[];
  readonly context: readonly GrepMatch[];
  readonly files: readonly string[];
  readonly truncated: boolean;
  readonly timedOut: boolean;
  /** Result-carrying records too large to buffer (a clipped context record loses decoration only and is not counted). */
  readonly skippedRecords: number;
}

/** Only enrich sparse, completed searches; never retain orphan context windows. */
export function finalizeGrep(outcome: GrepOutcome): GrepOutcome {
  const complete = !outcome.truncated && !outcome.timedOut && outcome.skippedRecords === 0;
  const include =
    outcome.output === "content" &&
    complete &&
    outcome.matches.length >= 1 &&
    outcome.matches.length <= AUTO_CONTEXT_MAX_MATCHES;
  return {
    ...outcome,
    context: include
      ? outcome.context.filter((row) =>
          outcome.matches.some(
            (match) =>
              match.path === row.path &&
              Math.abs(match.lineNumber - row.lineNumber) <= AUTO_CONTEXT_LINES,
          ),
        )
      : [],
  };
}

export interface FindRequest {
  readonly pattern: string;
  readonly path?: string;
  readonly cwd: string;
  readonly signal?: AbortSignal;
}

export interface FindOutcome {
  readonly files: readonly string[];
  readonly truncated: boolean;
  readonly timedOut: boolean;
  /** Records too large to buffer; they are dropped because a partial path is not a path. */
  readonly skippedRecords: number;
}

export interface SearchRuntimeShape {
  readonly grep: (request: GrepRequest) => Effect.Effect<GrepOutcome, SearchError>;
  readonly find: (request: FindRequest) => Effect.Effect<FindOutcome, SearchError>;
}

export class SearchRuntime extends Context.Service<SearchRuntime, SearchRuntimeShape>()(
  "pi-find/SearchRuntime",
) {}

function normalizeResultPath(filePath: string): string {
  const native = nodePath.normalize(filePath);
  const normalized = process.platform === "win32" ? native.replaceAll("\\", "/") : native;
  return normalized.replace(/^\.\//, "");
}

export function clipLine(text: string, matchStart = 0, matchEnd = matchStart): string {
  if (text.length <= MAX_LINE_LENGTH) return text;
  // Keep the first match visible, with balanced surrounding text when it fits.
  const padding = Math.floor(
    (MAX_LINE_LENGTH - Math.min(matchEnd - matchStart, MAX_LINE_LENGTH)) / 2,
  );
  let start = Math.max(0, Math.min(matchStart - padding, text.length - MAX_LINE_LENGTH));
  let end = start + MAX_LINE_LENGTH;
  // Never split a Unicode surrogate pair at either edge of the excerpt.
  if (/[\uDC00-\uDFFF]/.test(text[start] ?? "")) start += 1;
  if (/[\uDC00-\uDFFF]/.test(text[end] ?? "")) end -= 1;
  return `${start > 0 ? "… " : ""}${text.slice(start, end)}${end < text.length ? "…" : ""} (${text.length} chars)`;
}

function searchTarget(
  cwd: string,
  requestedPath: string | undefined,
  requireDirectory: boolean,
): { readonly argument: string; readonly root: string } | SearchInputError {
  let argument = (requestedPath ?? ".").replace(/^@/, "");
  if (argument === "~") argument = homedir();
  else if (
    argument.startsWith("~/") ||
    (process.platform === "win32" && argument.startsWith("~\\"))
  ) {
    argument = nodePath.join(homedir(), argument.slice(2));
  }
  const absolute = nodePath.resolve(cwd, argument);
  let isDirectory: boolean;
  try {
    isDirectory = statSync(absolute).isDirectory();
  } catch {
    return new SearchInputError({ message: missingSearchPathError(argument) });
  }
  // realpath catches symlink aliases to .git, but a component we lack
  // permission to resolve must not read as "path does not exist".
  let resolved = absolute;
  try {
    resolved = realpathSync(absolute);
  } catch {
    // keep the stat-verified path
  }
  if ([absolute, resolved].some((path) => normalizeResultPath(path).split("/").includes(".git"))) {
    return new SearchInputError({ message: GIT_PATH_ERROR });
  }
  if (requireDirectory && !isDirectory) {
    return new SearchInputError({ message: findPathNotDirectoryError(argument) });
  }
  return {
    argument,
    root: isDirectory ? absolute : nodePath.dirname(absolute),
  };
}

function isInsideGitRepository(root: string): boolean {
  for (let current = root; ; ) {
    if (existsSync(nodePath.join(current, ".git"))) return true;
    const parent = nodePath.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

function isExplicitHiddenPath(searchPath: string | undefined): boolean {
  if (searchPath === undefined) return false;
  return searchPath
    .replaceAll("\\", "/")
    .split("/")
    .some((segment) => segment.startsWith(".") && segment !== "." && segment !== "..");
}

/** Files larger than this are skipped: giant blobs (caches, bundles, sourcemaps) are what turns a broad search into an overnight scan. Matches OMP's native grep ceiling. */
const GREP_MAX_FILESIZE = "4M";

/** The glob without its optional leading negation marker. */
function globBody(pattern: string): string {
  return pattern.startsWith("!") ? pattern.slice(1) : pattern;
}

/**
 * Safe basename prefilter only; complex globs are left to Minimatch. Negated
 * globs cannot be expressed as a file-type filter, so they scan everything and
 * let Minimatch remove the exclusions.
 */
function basenamePrefilter(pattern: string | undefined): string {
  if (pattern === undefined || pattern.startsWith("!")) return "*";
  const basename = pattern.split("/").at(-1);
  // Restrict the entire pattern: a brace/extglob alternative can contain slashes.
  return /^[a-zA-Z0-9_./*?-]+$/.test(pattern) && basename ? basename : "*";
}

export function buildRgArgs(request: GrepRequest, searchRoot: string): string[] {
  const args = [
    "--no-config",
    "--case-sensitive",
    "--color=never",
    "--max-filesize",
    GREP_MAX_FILESIZE,
  ];
  if (request.output === "files") {
    args.push("--files-with-matches", "--null");
  } else {
    args.push("--json", "--line-number", "--context", String(AUTO_CONTEXT_LINES));
  }
  if (request.literal) args.push("--fixed-strings");
  if (!isInsideGitRepository(searchRoot)) args.push("--no-require-git");
  const prefilter = basenamePrefilter(request.glob);
  if (prefilter !== "*") args.push("--type-add", `pifind:${prefilter}`, "--type", "pifind");
  if (!isExplicitHiddenPath(request.path)) args.push("--glob", "!.*");
  args.push("--glob", "!.git/", "--regexp", request.pattern, "--", request.path ?? ".");
  return args;
}

export function buildFdArgs(request: FindRequest, searchRoot: string): string[] {
  const args = [
    "--type",
    "f",
    "--print0",
    "--color=never",
    "--ignore-case",
    "--glob",
    "--exclude",
    ".git",
  ];
  if (!isInsideGitRepository(searchRoot)) args.push("--no-require-git");
  args.push("--", basenamePrefilter(request.pattern), request.path ?? ".");
  return args;
}

/**
 * Compile one glob into a result-path predicate.
 *
 * A leading `!` excludes instead of includes. Slash globs have exactly one
 * base: the search root (the parent directory for an explicit grep file).
 * Basename globs match at any depth. cwd is only used to resolve result paths.
 */
function pathMatcher(pattern: string | undefined, root: string, cwd: string, nocase: boolean) {
  const negated = pattern?.startsWith("!") === true;
  const body = pattern === undefined ? undefined : globBody(pattern);
  const matcher =
    body === undefined || body.length === 0
      ? undefined
      : new Minimatch(body, {
          dot: true,
          matchBase: !body.includes("/"),
          nonegate: true,
          nocomment: true,
          nocase,
        });
  return (file: string): boolean => {
    if (matcher === undefined) return true;
    const absolute = nodePath.resolve(cwd, file);
    const matched = matcher.match(normalizeResultPath(nodePath.relative(root, absolute)));
    return negated ? !matched : matched;
  };
}

const makeSearchRuntime = Effect.gen(function* () {
  const grep = (request: GrepRequest): Effect.Effect<GrepOutcome, SearchError> =>
    Effect.suspend<GrepOutcome, SearchError, never>(() => {
      if (request.pattern.length === 0) {
        return Effect.fail(new SearchInputError({ message: EMPTY_PATTERN_ERROR }));
      }
      if (request.glob !== undefined && globBody(request.glob).length === 0) {
        return Effect.fail(new SearchInputError({ message: EMPTY_PATTERN_ERROR }));
      }
      const target = searchTarget(request.cwd, request.path, false);
      if (target instanceof SearchInputError) return Effect.fail(target);

      const accepts = pathMatcher(request.glob, target.root, request.cwd, false);
      const output = request.output ?? "content";
      const matches: GrepMatch[] = [];
      const context: GrepMatch[] = [];
      const files = new Set<string>();
      let skippedRecords = 0;
      return streamLines({
        binary: "rg",
        args: buildRgArgs({ ...request, path: target.argument }, target.root),
        delimiter: output === "files" ? "\0" : "\n",
        cwd: request.cwd,
        signal: request.signal,
        onLine(line, clipped) {
          // A clipped context record loses decoration only; a clipped match
          // or path loses a result. The record type is in the retained head.
          if (clipped) {
            if (output === "files" || !line.startsWith('{"type":"context"')) {
              skippedRecords += 1;
            }
            return true;
          }
          if (output === "files") {
            if (line.length === 0 || !accepts(line)) return true;
            const file = normalizeResultPath(line);
            if (files.has(file)) return true;
            if (files.size >= GREP_FILE_LIMIT) return false;
            files.add(file);
            return true;
          }
          const event = decodeRgEvent(line);
          if (event === undefined || !accepts(event.path)) return true;
          // Once any record was dropped, do not accumulate context for unseen
          // matches. Together with the match/context caps this bounds memory.
          if (event.isContext && (skippedRecords > 0 || matches.length > AUTO_CONTEXT_MAX_MATCHES))
            return true;
          if (!event.isContext && matches.length >= GREP_RESULT_LIMIT) return false;
          const row = {
            path: normalizeResultPath(event.path),
            lineNumber: event.lineNumber,
            text: clipLine(event.text, event.matchStart, event.matchEnd),
          };
          if (event.isContext) {
            context.push(row);
          } else {
            matches.push(row);
            files.add(row.path);
            // One pass, no rereads: keep a small speculative context buffer,
            // then discard it as soon as this is no longer a sparse search.
            if (matches.length > AUTO_CONTEXT_MAX_MATCHES) context.length = 0;
          }
          return true;
        },
      }).pipe(
        Effect.map((result) =>
          finalizeGrep({
            output,
            matches,
            context,
            files: [...files].sort(),
            truncated: result.stoppedEarly,
            timedOut: result.timedOut,
            skippedRecords,
          }),
        ),
      );
    });

  const find = (request: FindRequest): Effect.Effect<FindOutcome, SearchError> =>
    Effect.suspend<FindOutcome, SearchError, never>(() => {
      if (globBody(request.pattern).length === 0) {
        return Effect.fail(new SearchInputError({ message: EMPTY_PATTERN_ERROR }));
      }
      const target = searchTarget(request.cwd, request.path, true);
      if (target instanceof SearchInputError) return Effect.fail(target);

      const accepts = pathMatcher(request.pattern, target.root, request.cwd, true);
      const files: string[] = [];
      let sawOverflow = false;
      let skippedRecords = 0;
      return streamLines({
        binary: "fd",
        args: buildFdArgs({ ...request, path: target.argument }, target.root),
        delimiter: "\0",
        cwd: request.cwd,
        signal: request.signal,
        onLine(line, clipped) {
          // A clipped record is a partial path; a partial path is not a result.
          if (clipped) {
            skippedRecords += 1;
            return true;
          }
          const file = line;
          if (file.length === 0 || !accepts(file)) return true;
          if (files.length >= FIND_RESULT_LIMIT) {
            sawOverflow = true;
            return false;
          }
          files.push(normalizeResultPath(file));
          return true;
        },
      }).pipe(
        Effect.map(
          (result) =>
            ({
              files: files.sort(),
              truncated: sawOverflow || result.stoppedEarly,
              timedOut: result.timedOut,
              skippedRecords,
            }) satisfies FindOutcome,
        ),
      );
    });

  return SearchRuntime.of({ grep, find });
});

export const SearchRuntimeLive: Layer.Layer<SearchRuntime> = Layer.effect(
  SearchRuntime,
  makeSearchRuntime,
);

export function createSearchRuntime() {
  return ManagedRuntime.make(SearchRuntimeLive);
}

export type SearchRuntimeInstance = ReturnType<typeof createSearchRuntime>;

export async function runSearch<A>(
  runtime: SearchRuntimeInstance,
  effect: Effect.Effect<A, SearchError>,
  options: { signal?: AbortSignal } = {},
): Promise<A> {
  const exit = await runtime.runPromiseExit(
    effect,
    options.signal ? { signal: options.signal } : undefined,
  );
  if (Exit.isSuccess(exit)) return exit.value;

  if (Cause.hasInterruptsOnly(exit.cause)) {
    const aborted = new Error("search aborted");
    aborted.name = "AbortError";
    throw aborted;
  }

  const failure = Cause.findFail(exit.cause);
  if (Result.isSuccess(failure)) throw toThrowable(failure.success.error);

  const [first] = Cause.prettyErrors(exit.cause);
  throw new Error(first?.message ?? Cause.pretty(exit.cause));
}
