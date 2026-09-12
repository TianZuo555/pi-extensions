/** Effect service backing the deliberately small grep and find tools. */

import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import * as nodePath from "node:path";
import { Cause, Context, Effect, Exit, Layer, ManagedRuntime, Result } from "effect";
import { Minimatch } from "minimatch";
import {
  EMPTY_PATTERN_ERROR,
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

export interface GrepRequest {
  readonly pattern: string;
  readonly path?: string;
  readonly glob?: string;
  readonly cwd: string;
  readonly signal?: AbortSignal;
}

export interface GrepMatch {
  readonly path: string;
  readonly lineNumber: number;
  readonly text: string;
}

export interface GrepOutcome {
  readonly matches: readonly GrepMatch[];
  readonly truncated: boolean;
  readonly timedOut: boolean;
  /** Records too large to buffer; the whole record is dropped because a partial one cannot be decoded. */
  readonly skippedRecords: number;
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

function clipLine(text: string): string {
  if (text.length <= MAX_LINE_LENGTH) return text;
  return `${text.slice(0, MAX_LINE_LENGTH)}… (${text.length} chars)`;
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
    "--json",
    "--line-number",
    "--color=never",
    "--max-filesize",
    GREP_MAX_FILESIZE,
  ];
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
    "--case-sensitive",
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
 * A leading `!` excludes instead of includes, like ripgrep's own globs. Slash
 * globs are matched against both the search root and the cwd: callers pass
 * `path` as the scope and write globs from either place, and both spellings
 * can only ever match results inside that scope.
 */
function pathMatcher(pattern: string | undefined, root: string, cwd: string) {
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
          nocase: false,
        });
  return (file: string): boolean => {
    if (matcher === undefined) return true;
    const absolute = nodePath.resolve(cwd, file);
    const matched =
      matcher.match(normalizeResultPath(nodePath.relative(root, absolute))) ||
      matcher.match(normalizeResultPath(nodePath.relative(cwd, absolute)));
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

      const accepts = pathMatcher(request.glob, target.root, request.cwd);
      const matches: GrepMatch[] = [];
      let sawOverflow = false;
      let skippedRecords = 0;
      return streamLines({
        binary: "rg",
        args: buildRgArgs({ ...request, path: target.argument }, target.root),
        cwd: request.cwd,
        signal: request.signal,
        onLine(line, clipped) {
          // A clipped JSON record cannot be decoded, and its head is not a match.
          if (clipped) {
            skippedRecords += 1;
            return true;
          }
          const event = decodeRgEvent(line);
          if (event === undefined || !accepts(event.path)) return true;
          if (matches.length >= GREP_RESULT_LIMIT) {
            sawOverflow = true;
            return false;
          }
          matches.push({
            path: normalizeResultPath(event.path),
            lineNumber: event.lineNumber,
            text: clipLine(event.text),
          });
          return true;
        },
      }).pipe(
        Effect.map(
          (result) =>
            ({
              matches,
              truncated: sawOverflow || result.stoppedEarly,
              timedOut: result.timedOut,
              skippedRecords,
            }) satisfies GrepOutcome,
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

      const accepts = pathMatcher(request.pattern, target.root, request.cwd);
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
              files,
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
