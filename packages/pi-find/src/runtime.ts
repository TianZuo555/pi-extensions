/**
 * SearchRuntime — Effect v4 service backing grep and find.
 *
 * Responsibilities: turn a validated tool call into rg/fd arguments, stream the
 * result under a hard match/file cap, and render bounded output.
 */

import { existsSync, statSync } from "node:fs";
import * as path from "node:path";
import { Cause, Context, Effect, Exit, Layer, ManagedRuntime, Result } from "effect";
import { minimatch } from "minimatch";
import {
  planConstraints,
  type ConstraintPlan,
} from "../lib/constraints.ts";
import { classifyPattern, isSmartCaseInsensitive } from "../lib/pattern.ts";
import {
  EMPTY_PATTERN_ERROR,
  FIND_WILDCARD_ONLY_ERROR,
  MIXED_EXTERNAL_PATH_ERROR,
  WILDCARD_ONLY_ERROR,
} from "../lib/prompt.ts";
import { decodeRgEvent, type RgLine } from "../lib/rg-json.ts";
import { SearchInputError, toThrowable, type SearchError } from "./errors.ts";
import { streamLines } from "./stream.ts";

/** Long lines are clipped so one minified file cannot flood the result. */
export const MAX_LINE_LENGTH = 400;

export interface GrepRequest {
  readonly patterns: readonly string[];
  readonly literalOnly: boolean;
  readonly path?: string | readonly string[];
  readonly exclude?: string | readonly string[];
  readonly caseSensitive?: boolean;
  readonly context?: number;
  readonly limit: number;
  readonly cwd: string;
  readonly signal?: AbortSignal;
}

export interface GrepMatch {
  readonly path: string;
  readonly lineNumber: number;
  readonly text: string;
  readonly isMatch: boolean;
}

export interface GrepOutcome {
  readonly matches: readonly GrepMatch[];
  /** True when rg had more to give than the limit allowed. */
  readonly truncated: boolean;
  readonly searchRoot: string;
  readonly hasConstraints: boolean;
}

export interface FindRequest {
  readonly pattern: string;
  readonly path?: string | readonly string[];
  readonly exclude?: string | readonly string[];
  readonly limit: number;
  readonly cwd: string;
  readonly signal?: AbortSignal;
}

export interface FindOutcome {
  readonly files: readonly string[];
  /** True when more query matches existed than the requested limit. */
  readonly limitReached: boolean;
  readonly searchRoot: string;
  readonly hasConstraints: boolean;
}

export interface SearchRuntimeShape {
  readonly grep: (request: GrepRequest) => Effect.Effect<GrepOutcome, SearchError>;
  readonly find: (request: FindRequest) => Effect.Effect<FindOutcome, SearchError>;
}

export class SearchRuntime extends Context.Service<
  SearchRuntime,
  SearchRuntimeShape
>()("pi-tian-find/SearchRuntime") {}

/** Resolve the already-normalized search root against the request cwd. */
function resolveRoot(cwd: string, plan: ConstraintPlan): string {
  if (plan.searchRoot === undefined) return cwd;
  return path.isAbsolute(plan.searchRoot)
    ? plan.searchRoot
    : path.resolve(cwd, plan.searchRoot);
}

function normalizePath(filePath: string): string {
  return filePath.replaceAll("\\", "/").replace(/^\.\//, "");
}

const RG_INCLUDE_TYPE = "pifind";
const SIMPLE_EXTENSION_GLOB = /^\*\.[A-Za-z0-9_+-][A-Za-z0-9_.+-]*$/;

/**
 * Ripgrep file types preserve ignore rules, unlike positive --glob filters.
 * Use them only when every include alternative is a simple extension glob;
 * the combined type is a file-selection hint and client-side matchers remain
 * authoritative for exact semantics.
 */
export function rgTypeGlobs(
  includeGlobs: readonly string[],
): readonly string[] | undefined {
  if (
    includeGlobs.length === 0 ||
    !includeGlobs.every((glob) => SIMPLE_EXTENSION_GLOB.test(glob))
  ) {
    return undefined;
  }
  return [...new Set(includeGlobs)];
}

function isWithin(base: string, candidate: string): boolean {
  const relative = path.relative(base, candidate);
  return relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative));
}

interface SearchScope {
  readonly root: string;
  readonly plan: ConstraintPlan;
  readonly formatPath: (relativePath: string) => string;
}

/**
 * Keep every in-workspace search cwd-relative. External searches run at their
 * own root and return absolute paths so downstream read/edit calls can use the
 * result directly.
 */
function createSearchScope(cwd: string, plan: ConstraintPlan): SearchScope {
  const requestedRoot = resolveRoot(cwd, plan);
  if (plan.searchRoot === undefined) {
    return { root: cwd, plan, formatPath: normalizePath };
  }

  if (isWithin(cwd, requestedRoot)) {
    const prefix = normalizePath(path.relative(cwd, requestedRoot));
    const include = prefix.length === 0
      ? plan.include
      : plan.include.length === 0
      ? [`${prefix}/**`]
      : plan.include.map((glob) => {
          if (glob.startsWith("/")) {
            return `/${prefix}/${normalizePath(glob.slice(1))}`;
          }
          return `${prefix}/${normalizePath(glob)}`;
        });
    const searchDirs = prefix.length === 0
      ? plan.searchDirs
      : [prefix];
    return {
      root: cwd,
      plan: { include, exclude: plan.exclude, searchDirs },
      formatPath: normalizePath,
    };
  }

  return {
    root: requestedRoot,
    plan,
    formatPath: (relativePath) =>
      normalizePath(path.resolve(requestedRoot, normalizePath(relativePath))),
  };
}

function clipLine(text: string): string {
  if (text.length <= MAX_LINE_LENGTH) return text;
  return `${text.slice(0, MAX_LINE_LENGTH)}… (${text.length} chars)`;
}

/**
 * rg reports paths relative to the `.` root we hand it, so they arrive as
 * `./src/a.ts`. Strip the prefix: the model compares these against paths from
 * find and read, which never carry it.
 */
function normalizeRgPath(filePath: string): string {
  return normalizePath(filePath);
}

/**
 * Exclude globs whose engine-level meaning provably coincides with the
 * client-side matcher, in the engine's own spelling (leading '/' stripped).
 *
 * Engine excludes apply to directories as well as files: a slashless glob
 * like '*.min.js' prunes a directory named cache.min.js entirely, taking
 * keep.ts inside with it, and 'vendor' prunes nested src/vendor — both
 * over-exclude relative to the file-path matchers, which stay authoritative.
 * Only globs with directory-closure semantics are pushed: '**' and anything
 * ending in '/**'. For those, any directory the engine prunes for matching
 * the glob has every file beneath it matching the same glob client-side, so
 * results cannot diverge. Everything else (basename globs, exact files,
 * anchored single segments) is filtered client-side only.
 */
function pushableExcludeGlob(glob: string): string | undefined {
  const stripped = glob.startsWith("/") ? glob.slice(1) : glob;
  if (stripped === "**") return stripped;
  return stripped.endsWith("/**") ? stripped : undefined;
}

export function buildRgArgs(
  request: GrepRequest,
  literal: boolean,
  root: string,
  searchDirs: readonly string[] | undefined,
  includeGlobs: readonly string[],
  excludeGlobs: readonly string[],
): string[] {
  const args = [
    "--json",
    "--line-number",
    "--color=never",
    "--hidden",
  ];

  // Like fd, rg normally ignores .gitignore files outside a Git repository.
  // Preserve the tool's advertised ignore semantics for external/temp trees.
  if (!isInsideGitRepository(root)) args.push("--no-require-git");

  if (request.caseSensitive === true) args.push("--case-sensitive");
  else args.push("--smart-case");

  if (request.context !== undefined && request.context > 0) {
    args.push("--context", String(request.context));
  }

  const typeGlobs = rgTypeGlobs(includeGlobs);
  for (const glob of typeGlobs ?? []) {
    args.push("--type-add", `${RG_INCLUDE_TYPE}:${glob}`);
  }
  if (typeGlobs !== undefined) args.push("--type", RG_INCLUDE_TYPE);

  // Literal mode covers pattern arrays and single patterns whose regex syntax
  // does not compile.
  if (literal) args.push("--fixed-strings");

  for (const pattern of request.patterns) args.push("--regexp", pattern);

  // Client-side include matching remains authoritative because positive rg
  // globs override .gitignore. The custom type above is only a file-selection
  // hint for simple extension globs.
  //
  // Excludes are pushed down for traversal pruning: a negative --glob only
  // removes candidates — unlike positive globs it never re-includes
  // gitignored files — and rg keeps anchored globs anchored even alongside
  // positional search paths (verified empirically). Only directory-closure
  // globs ('**' and '/**'-suffixed) are forwarded, so pruning a directory
  // never removes files the client-side matchers would keep. Keep .git as a
  // final engine-level exclusion because packed objects are both large and
  // likely to match.
  for (const glob of excludeGlobs) {
    const pushable = pushableExcludeGlob(glob);
    if (pushable !== undefined) args.push("--glob", `!${pushable}`);
  }
  args.push("--glob", "!.git/");

  // Explicit directory constraints become positional paths. This preserves
  // ignore-file behavior and lets rg prune traversal like fd does.
  args.push("--", ...(searchDirs ?? ["."]));
  return args;
}

function isInsideGitRepository(root: string): boolean {
  for (let current = root;;) {
    if (existsSync(path.join(current, ".git"))) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

function resolveSearchDirs(
  plan: ConstraintPlan,
  root: string,
): readonly string[] | undefined {
  if (
    plan.searchDirs.length === 0 ||
    plan.searchDirs.includes(".") ||
    plan.searchDirs.includes("")
  ) {
    return undefined;
  }

  const existing: string[] = [];
  for (const dir of plan.searchDirs) {
    try {
      if (statSync(path.resolve(root, dir)).isDirectory()) existing.push(dir);
    } catch (error) {
      const code = error instanceof Error && "code" in error
        ? String((error as NodeJS.ErrnoException).code)
        : undefined;
      // Missing paths are valid empty constraints. For permission and other
      // failures, let the search engine inspect the path and surface its error.
      if (code !== "ENOENT" && code !== "ENOTDIR") existing.push(dir);
    }
  }
  return existing;
}

export function buildFdArgs(
  root: string,
  searchDirs: readonly string[] | undefined,
  excludeGlobs: readonly string[],
): string[] {
  const args = [
    "--type",
    "f",
    "--hidden",
    "--base-directory",
    root,
    "--exclude",
    ".git",
  ];

  // fd otherwise ignores .gitignore files when the root is outside a Git
  // repository. Inside a repository, retaining its default preserves nested
  // repository ignore boundaries.
  if (!isInsideGitRepository(root)) args.push("--no-require-git");

  // Excludes are pushed down for traversal pruning only when the walk covers
  // the whole root: with --search-path, fd re-anchors --exclude per search
  // path (verified: 'sub/**' excluded src/sub but left keep/sub standing),
  // which does not share this tool's root-relative namespace. Anchoring and
  // skip decisions live in pushableExcludeGlob; the client-side matchers
  // above stay authoritative in every case.
  // (The '.git' literal above is fd's own default-exclude spelling, not a
  // pushed user glob.)
  if (searchDirs === undefined || searchDirs.length === 0) {
    for (const glob of excludeGlobs) {
      const pushable = pushableExcludeGlob(glob);
      if (pushable !== undefined) args.push("--exclude", pushable);
    }
  }

  // Relative search paths are resolved by fd against --base-directory. Missing
  // paths were removed above so a typo cannot degrade into a full-root walk.
  for (const dir of searchDirs ?? []) {
    args.push("--search-path", dir);
  }

  return args;
}

/**
 * Directory constraints prune traversal through rg positional paths or fd's
 * `--search-path`. All include and exclude globs are applied to root-relative
 * candidate paths here so both engines retain ignore-file behavior and exactly
 * the same anchoring. A slashless glob such as `*.ts` has basename semantics
 * and therefore matches at any depth.
 */
function createGlobMatcher(glob: string): (candidate: string) => boolean {
  const normalizedGlob = glob.replaceAll("\\", "/");
  if (normalizedGlob.startsWith("/")) {
    return (candidate) =>
      minimatch(`/${candidate.replaceAll("\\", "/")}`, normalizedGlob, {
        dot: true,
      });
  }
  const matchBase = !normalizedGlob.includes("/");
  return (candidate) =>
    minimatch(candidate.replaceAll("\\", "/"), normalizedGlob, {
      dot: true,
      matchBase,
    });
}

/**
 * One whitespace-separated term of a find pattern, matched against the
 * formatted path. Literal terms are smart-case substring matches; terms with
 * regex syntax are compiled as JavaScript regex and fall back to a literal
 * substring when they do not compile — the same policy as grep, where an
 * uncompilable pattern is text the caller wants to find, not an error.
 */
function createTermMatcher(term: string): (candidate: string) => boolean {
  const insensitive = isSmartCaseInsensitive(term);
  const literalIncludes = (candidate: string): boolean =>
    (insensitive ? candidate.toLowerCase() : candidate).includes(
      insensitive ? term.toLowerCase() : term,
    );

  if (classifyPattern(term).mode === "literal") return literalIncludes;

  try {
    const regex = new RegExp(term, insensitive ? "i" : "");
    return (candidate) => regex.test(candidate);
  } catch {
    return literalIncludes;
  }
}

const makeSearchRuntime = Effect.gen(function* () {
  const grep = (request: GrepRequest): Effect.Effect<GrepOutcome, SearchError> =>
    Effect.suspend((): Effect.Effect<GrepOutcome, SearchError> => {
      if (
        request.patterns.length === 0 ||
        request.patterns.some((p) => p.length === 0)
      ) {
        return Effect.fail(
          new SearchInputError({ message: EMPTY_PATTERN_ERROR }),
        );
      }

      const planning = planConstraints(request.path, request.exclude, request.cwd);
      if (planning.kind === "invalid") {
        return Effect.fail(
          new SearchInputError({ message: MIXED_EXTERNAL_PATH_ERROR }),
        );
      }
      const plan = planning.plan;
      const scope = createSearchScope(request.cwd, plan);
      const root = scope.root;
      const hasConstraints = plan.include.length + plan.exclude.length > 0 ||
        plan.searchRoot !== undefined;

      // Only single-pattern grep classifies; multi-pattern declares literalOnly.
      // Patterns with regex syntax are tried as regex first. If rg's own
      // parser rejects one, the stream below retries it literally.
      let literal = request.literalOnly;
      if (!request.literalOnly && request.patterns.length === 1) {
        const classified = classifyPattern(request.patterns[0]!);
        if (classified.wildcardOnly) {
          return Effect.fail(
            new SearchInputError({ message: WILDCARD_ONLY_ERROR }),
          );
        }
        literal = classified.mode === "literal";
      }

      const searchDirs = resolveSearchDirs(scope.plan, root);
      if (searchDirs !== undefined && searchDirs.length === 0) {
        return Effect.succeed({
          matches: [],
          truncated: false,
          searchRoot: root,
          hasConstraints,
        } satisfies GrepOutcome);
      }

      const includeMatchers = scope.plan.include.map(createGlobMatcher);
      const excludeMatchers = scope.plan.exclude.map(createGlobMatcher);
      const matches: GrepMatch[] = [];
      const pendingContext: GrepMatch[] = [];
      const seenEvents = new Set<string>();
      let matchCount = 0;
      let lastAcceptedMatch: GrepMatch | undefined;

      const onLine = (line: string): boolean => {
        const event: RgLine | undefined = decodeRgEvent(line);
        if (event === undefined) return true;

        const relativePath = normalizeRgPath(event.path);
        if (
          includeMatchers.length > 0 &&
          !includeMatchers.some((matcher) => matcher(relativePath))
        ) {
          return true;
        }
        if (
          excludeMatchers.length > 0 &&
          excludeMatchers.some((matcher) => matcher(relativePath))
        ) {
          return true;
        }

        const eventKey = `${relativePath}\0${event.lineNumber}\0${event.kind}`;
        if (seenEvents.has(eventKey)) return true;
        seenEvents.add(eventKey);

        const decoded: GrepMatch = {
          path: scope.formatPath(relativePath),
          lineNumber: event.lineNumber,
          text: clipLine(event.text),
          isMatch: event.kind === "match",
        };

        if (!decoded.isMatch) {
          pendingContext.push(decoded);
          return true;
        }

        // Only real matches count towards the limit; context lines ride along
        // so a limit of 20 means 20 hits regardless of the context setting.
        matchCount += 1;
        if (matchCount > request.limit) {
          // rg emits leading context before the probe match. Retain only lines
          // that are also valid trailing context for the last accepted match;
          // otherwise a context-only second file leaks into the result.
          if (lastAcceptedMatch !== undefined && request.context !== undefined) {
            matches.push(
              ...pendingContext.filter((context) =>
                context.path === lastAcceptedMatch!.path &&
                context.lineNumber > lastAcceptedMatch!.lineNumber &&
                context.lineNumber <= lastAcceptedMatch!.lineNumber + request.context!
              ),
            );
          }
          pendingContext.length = 0;
          return false;
        }

        matches.push(...pendingContext, decoded);
        pendingContext.length = 0;
        lastAcceptedMatch = decoded;
        return true;
      };

      const runRg = (fixedStrings: boolean) =>
        streamLines({
          binary: "rg",
          args: buildRgArgs(
            request,
            fixedStrings,
            root,
            searchDirs,
            scope.plan.include,
            scope.plan.exclude,
          ),
          cwd: root,
          onLine,
          signal: request.signal,
        });

      return runRg(literal).pipe(
        Effect.catch((error) => {
          if (
            !literal && error._tag === "SearchProcessError" &&
            /regex parse error/i.test(error.message)
          ) {
            matches.length = 0;
            pendingContext.length = 0;
            seenEvents.clear();
            matchCount = 0;
            lastAcceptedMatch = undefined;
            return runRg(true);
          }
          return Effect.fail(error);
        }),
        Effect.map((result) => {
          const truncated = result.stoppedEarly || matchCount > request.limit;
          // When the process completed naturally, pending lines are trailing
          // context for the final accepted match.
          if (matchCount <= request.limit) matches.push(...pendingContext);
          return {
            matches,
            truncated,
            searchRoot: root,
            hasConstraints,
          } satisfies GrepOutcome;
        }),
      );
    });

  const find = (request: FindRequest): Effect.Effect<FindOutcome, SearchError> =>
    Effect.suspend((): Effect.Effect<FindOutcome, SearchError> => {
      const planning = planConstraints(request.path, request.exclude, request.cwd);
      if (planning.kind === "invalid") {
        return Effect.fail(
          new SearchInputError({ message: MIXED_EXTERNAL_PATH_ERROR }),
        );
      }
      const plan = planning.plan;
      const query = request.pattern.trim();
      if (classifyPattern(query).wildcardOnly) {
        return Effect.fail(
          new SearchInputError({ message: FIND_WILDCARD_ONLY_ERROR }),
        );
      }
      const scope = createSearchScope(request.cwd, plan);
      const root = scope.root;
      const hasConstraints = plan.include.length + plan.exclude.length > 0 ||
        plan.searchRoot !== undefined;
      const fdSearchDirs = resolveSearchDirs(scope.plan, root);
      if (fdSearchDirs !== undefined && fdSearchDirs.length === 0) {
        return Effect.succeed({
          files: [],
          limitReached: false,
          searchRoot: root,
          hasConstraints,
        } satisfies FindOutcome);
      }

      const includeMatchers = scope.plan.include.map(createGlobMatcher);
      const excludeMatchers = scope.plan.exclude.map(createGlobMatcher);
      const termMatchers = query
        .split(/\s+/)
        .filter((term) => term.length > 0)
        .map(createTermMatcher);

      const files: string[] = [];
      const seen = new Set<string>();

      const onLine = (line: string): boolean => {
        // readline already removes LF. Preserve legitimate leading/trailing
        // spaces in filenames while tolerating a CRLF-producing fd wrapper.
        const relative = line.endsWith("\r") ? line.slice(0, -1) : line;
        if (relative.length === 0) return true;
        if (
          includeMatchers.length > 0 &&
          !includeMatchers.some((matcher) => matcher(relative))
        ) {
          return true;
        }
        if (
          excludeMatchers.length > 0 &&
          excludeMatchers.some((matcher) => matcher(relative))
        ) {
          return true;
        }
        const formatted = scope.formatPath(relative);
        if (!termMatchers.every((matcher) => matcher(formatted))) return true;
        if (seen.has(formatted)) return true;
        seen.add(formatted);
        files.push(formatted);
        // Probe one past the requested limit so the result can tell the
        // model that its view is incomplete without walking the rest of
        // the tree; the walk itself stops as soon as the probe is in.
        return files.length <= request.limit;
      };

      return streamLines({
        binary: "fd",
        args: buildFdArgs(root, fdSearchDirs, scope.plan.exclude),
        cwd: request.cwd,
        onLine,
        signal: request.signal,
      }).pipe(
        Effect.map(() => ({
          files: files.slice(0, request.limit),
          limitReached: files.length > request.limit,
          searchRoot: root,
          hasConstraints,
        } satisfies FindOutcome)),
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

/**
 * Run a search effect and surface failures as the plain Errors pi's tool
 * contract expects, preserving AbortError so a cancelled turn is not reported
 * as a search failure.
 */
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
  if (Result.isSuccess(failure)) {
    throw toThrowable(failure.success.error);
  }

  const [first] = Cause.prettyErrors(exit.cause);
  throw new Error(first?.message ?? Cause.pretty(exit.cause));
}
