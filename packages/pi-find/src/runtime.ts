/** Effect service backing the deliberately small grep and find tools. */

import { existsSync, statSync } from "node:fs";
import * as nodePath from "node:path";
import { Cause, Context, Effect, Exit, Layer, ManagedRuntime, Result } from "effect";
import {
  EMPTY_PATTERN_ERROR,
  FIND_RESULT_LIMIT,
  findPathNotDirectoryError,
  GREP_RESULT_LIMIT,
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
}

export interface SearchRuntimeShape {
  readonly grep: (request: GrepRequest) => Effect.Effect<GrepOutcome, SearchError>;
  readonly find: (request: FindRequest) => Effect.Effect<FindOutcome, SearchError>;
}

export class SearchRuntime extends Context.Service<SearchRuntime, SearchRuntimeShape>()(
  "pi-find/SearchRuntime",
) {}

function normalizeResultPath(filePath: string): string {
  const normalized = nodePath.normalize(filePath).replaceAll("\\", "/");
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
  const argument = requestedPath ?? ".";
  const absolute = nodePath.resolve(cwd, argument);
  let isDirectory: boolean;
  try {
    isDirectory = statSync(absolute).isDirectory();
  } catch {
    return new SearchInputError({ message: missingSearchPathError(argument) });
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
  for (let current = root;;) {
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

export function buildRgArgs(request: GrepRequest, searchRoot: string): string[] {
  const args = ["--json", "--line-number", "--color=never"];
  if (!isInsideGitRepository(searchRoot)) args.push("--no-require-git");
  if (request.glob !== undefined) {
    args.push("--type-add", `pifind:${request.glob}`, "--type", "pifind");
  }
  if (!isExplicitHiddenPath(request.path)) args.push("--glob", "!.*");
  args.push("--glob", "!.git/", "--regexp", request.pattern, "--", request.path ?? ".");
  return args;
}

export function buildFdArgs(request: FindRequest, searchRoot: string): string[] {
  const args = ["--type", "f", "--glob", request.pattern, "--exclude", ".git"];
  if (!isInsideGitRepository(searchRoot)) args.push("--no-require-git");
  args.push("--", request.path ?? ".");
  return args;
}

const makeSearchRuntime = Effect.gen(function* () {
  const grep = (request: GrepRequest): Effect.Effect<GrepOutcome, SearchError> =>
    Effect.suspend<GrepOutcome, SearchError, never>(() => {
      if (request.pattern.length === 0) {
        return Effect.fail(new SearchInputError({ message: EMPTY_PATTERN_ERROR }));
      }
      if (request.glob !== undefined && request.glob.length === 0) {
        return Effect.fail(new SearchInputError({ message: EMPTY_PATTERN_ERROR }));
      }
      const target = searchTarget(request.cwd, request.path, false);
      if (target instanceof SearchInputError) return Effect.fail(target);

      const matches: GrepMatch[] = [];
      let sawOverflow = false;
      return streamLines({
        binary: "rg",
        args: buildRgArgs(request, target.root),
        cwd: request.cwd,
        signal: request.signal,
        onLine(line) {
          const event = decodeRgEvent(line);
          if (event === undefined) return true;
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
        Effect.map((result) => ({
          matches,
          truncated: sawOverflow || result.stoppedEarly,
        } satisfies GrepOutcome)),
      );
    });

  const find = (request: FindRequest): Effect.Effect<FindOutcome, SearchError> =>
    Effect.suspend<FindOutcome, SearchError, never>(() => {
      if (request.pattern.length === 0) {
        return Effect.fail(new SearchInputError({ message: EMPTY_PATTERN_ERROR }));
      }
      const target = searchTarget(request.cwd, request.path, true);
      if (target instanceof SearchInputError) return Effect.fail(target);

      const files: string[] = [];
      let sawOverflow = false;
      return streamLines({
        binary: "fd",
        args: buildFdArgs(request, target.root),
        cwd: request.cwd,
        signal: request.signal,
        onLine(line) {
          const file = line.endsWith("\r") ? line.slice(0, -1) : line;
          if (file.length === 0) return true;
          if (files.length >= FIND_RESULT_LIMIT) {
            sawOverflow = true;
            return false;
          }
          files.push(normalizeResultPath(file));
          return true;
        },
      }).pipe(
        Effect.map((result) => ({
          files,
          truncated: sawOverflow || result.stoppedEarly,
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
