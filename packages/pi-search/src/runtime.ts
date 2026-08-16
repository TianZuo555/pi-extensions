/**
 * SearchRuntime — Effect v4 service backing grep, find, and multi_grep.
 *
 * Responsibilities: turn a validated tool call into rg/fd arguments, stream the
 * result under a hard match/file cap, and render bounded output. Pagination
 * cursors are held here for the session, so a follow-up page shows the results
 * of the original search rather than re-running it against a tree that may have
 * changed in between.
 */

import { existsSync } from "node:fs";
import * as path from "node:path";
import { Cause, Context, Effect, Exit, Layer, ManagedRuntime, Result } from "effect";
import { Fzf, extendedMatch } from "fzf";
import { minimatch } from "minimatch";
import {
  planConstraints,
  toGlobArgs,
  type ConstraintPlan,
} from "../lib/constraints.ts";
import { createCursorStore, type CursorStore } from "../lib/cursor.ts";
import { classifyPattern } from "../lib/pattern.ts";
import {
  MIXED_EXTERNAL_ROOTS_ERROR,
  WILDCARD_ONLY_ERROR,
} from "../lib/prompt.ts";
import { decodeRgEvent, type RgLine } from "../lib/rg-json.ts";
import { SearchInputError, toThrowable, type SearchError } from "./errors.ts";
import { streamLines } from "./stream.ts";

/**
 * How many raw candidates fd may produce before fuzzy scoring. A fuzzy query
 * has to see the whole candidate set to rank it, but an unbounded walk on a
 * huge tree would dominate the call, so the walk is capped and the cap is
 * reported rather than silently changing which files could win.
 */
export const MAX_FUZZY_CANDIDATES = 20_000;

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
  /** Matches observed while probing one past the requested limit. */
  readonly totalMatched: number;
  /** True when more query matches existed than the requested limit. */
  readonly limitReached: boolean;
  /** True when fd's walk hit MAX_FUZZY_CANDIDATES. */
  readonly candidatesCapped: boolean;
  readonly searchRoot: string;
  readonly hasConstraints: boolean;
}

export interface SearchRuntimeShape {
  readonly grep: (request: GrepRequest) => Effect.Effect<GrepOutcome, SearchError>;
  readonly find: (request: FindRequest) => Effect.Effect<FindOutcome, SearchError>;
  readonly cursors: CursorStore;
}

export class SearchRuntime extends Context.Service<
  SearchRuntime,
  SearchRuntimeShape
>()("pi-tian-search/SearchRuntime") {}

/** Resolve the search root, honouring ~ and absolute paths. */
function resolveRoot(cwd: string, plan: ConstraintPlan): string {
  if (plan.searchRoot === undefined) return cwd;
  const raw = plan.searchRoot;
  const expanded = raw.startsWith("~")
    ? path.join(process.env.HOME ?? "", raw.slice(1))
    : raw;
  return path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
}

function normalizePath(filePath: string): string {
  return filePath.replaceAll("\\", "/").replace(/^\.\//, "");
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
      : plan.include.map((glob) => `${prefix}/${normalizePath(glob)}`);
    return {
      root: cwd,
      plan: { include, exclude: plan.exclude },
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

function buildRgArgs(
  request: GrepRequest,
  plan: ConstraintPlan,
  literal: boolean,
): string[] {
  const args = [
    "--json",
    "--line-number",
    "--color=never",
    "--hidden",
    // .git holds packed objects that match almost any pattern by chance.
    "--glob",
    "!.git/",
  ];

  if (request.caseSensitive === true) args.push("--case-sensitive");
  else args.push("--smart-case");

  if (request.context !== undefined && request.context > 0) {
    args.push("--context", String(request.context));
  }

  args.push(...toGlobArgs(plan));

  // Literal mode covers multi_grep (always literal) and single patterns whose
  // regex syntax does not compile.
  if (literal) args.push("--fixed-strings");

  for (const pattern of request.patterns) args.push("--regexp", pattern);

  // `--` then the root: without the separator a pattern starting with `-`
  // would be read as a flag.
  args.push("--", ".");
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

function buildFdArgs(plan: ConstraintPlan, root: string): string[] {
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

  // fd takes globs as --glob plus a pattern, but we need several include globs
  // at once, so includes are expressed as its --glob pattern list via --and is
  // unavailable; instead we let fd list candidates and filter includes here.
  for (const glob of plan.exclude) {
    // Strip the rg-style leading '!' that fd does not use.
    args.push("--exclude", glob.replace(/^!/, ""));
  }

  return args;
}

/**
 * fd cannot apply several positive include globs in one invocation, so use a
 * maintained glob implementation against the normalized relative paths it
 * streams back. A slashless glob such as `*.ts` has basename semantics, just
 * like rg/fd, and therefore matches at any depth.
 */
function createGlobMatcher(glob: string): (candidate: string) => boolean {
  const normalizedGlob = glob.replaceAll("\\", "/");
  const matchBase = !normalizedGlob.includes("/");
  return (candidate) =>
    minimatch(candidate.replaceAll("\\", "/"), normalizedGlob, {
      dot: true,
      matchBase,
    });
}

const makeSearchRuntime = Effect.gen(function* () {
  const cursors = createCursorStore();

  const grep = (request: GrepRequest): Effect.Effect<GrepOutcome, SearchError> =>
    Effect.suspend((): Effect.Effect<GrepOutcome, SearchError> => {
      const plan = planConstraints(request.path, request.exclude);
      if (plan.hasMixedExternalRoots === true) {
        return Effect.fail(
          new SearchInputError({ message: MIXED_EXTERNAL_ROOTS_ERROR }),
        );
      }
      const scope = createSearchScope(request.cwd, plan);
      const root = scope.root;
      const hasConstraints = plan.include.length + plan.exclude.length > 0 ||
        plan.searchRoot !== undefined;

      // Only single-pattern grep classifies; multi_grep declares literalOnly.
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

      const matches: GrepMatch[] = [];
      const pendingContext: GrepMatch[] = [];
      let matchCount = 0;
      let lastAcceptedMatch: GrepMatch | undefined;

      const onLine = (line: string): boolean => {
        const event: RgLine | undefined = decodeRgEvent(line);
        if (event === undefined) return true;

        const decoded: GrepMatch = {
          path: scope.formatPath(normalizeRgPath(event.path)),
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
          args: buildRgArgs(request, scope.plan, fixedStrings),
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
      const plan = planConstraints(request.path, request.exclude);
      if (plan.hasMixedExternalRoots === true) {
        return Effect.fail(
          new SearchInputError({ message: MIXED_EXTERNAL_ROOTS_ERROR }),
        );
      }
      const scope = createSearchScope(request.cwd, plan);
      const root = scope.root;
      const hasConstraints = plan.include.length + plan.exclude.length > 0 ||
        plan.searchRoot !== undefined;
      const includeMatchers = scope.plan.include.map(createGlobMatcher);

      const candidates: string[] = [];
      let capped = false;

      const onLine = (line: string): boolean => {
        const relative = line.trim();
        if (relative.length === 0) return true;
        if (
          includeMatchers.length > 0 &&
          !includeMatchers.some((matcher) => matcher(relative))
        ) {
          return true;
        }
        candidates.push(scope.formatPath(relative));
        if (candidates.length >= MAX_FUZZY_CANDIDATES) {
          capped = true;
          return false;
        }
        return true;
      };

      return streamLines({
        binary: "fd",
        args: buildFdArgs(scope.plan, root),
        cwd: request.cwd,
        onLine,
        signal: request.signal,
      }).pipe(
        Effect.map(() => {
          const query = request.pattern.trim();

          // An empty query means "everything matching path", so preserve fd's
          // own ordering rather than scoring against nothing.
          if (query.length === 0) {
            return {
              files: candidates.slice(0, request.limit),
              totalMatched: candidates.length,
              limitReached: candidates.length > request.limit,
              candidatesCapped: capped,
              searchRoot: root,
              hasConstraints,
            } satisfies FindOutcome;
          }

          // extendedMatch gives fzf's AND-across-terms behaviour, so
          // "search prompt" narrows without the words being adjacent.
          const fzf = new Fzf(candidates, {
            // Probe one past the requested limit so the result can tell the
            // model that its view is incomplete without ranking every match.
            limit: request.limit + 1,
            match: extendedMatch,
          });
          const ranked = fzf.find(query);
          const limitReached = ranked.length > request.limit;

          return {
            files: ranked.slice(0, request.limit).map((entry) => entry.item),
            totalMatched: ranked.length,
            limitReached,
            candidatesCapped: capped,
            searchRoot: root,
            hasConstraints,
          } satisfies FindOutcome;
        }),
      );
    });

  return SearchRuntime.of({ grep, find, cursors });
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
