/**
 * Path-constraint DSL shared by grep and find.
 *
 * The model writes one string for `path` and one for `exclude`, and we turn
 * those into a root-relative matching and traversal plan shared by grep and
 * find. Three shapes are accepted, distinguished without touching the filesystem so the same parse
 * works for excludes (which never name an existing path) and for constraints
 * pointing outside the workspace:
 *
 *   directory prefix   `src/`, `src/foo/`   → everything beneath it
 *   bare filename      `main.rs`            → that filename at any depth (raw glob)
 *   glob               `*.ts`, `src/**\/*.cc`, `{src,lib}/**`
 *
 * A slashless glob or bare filename (e.g. `main.rs` or `*.ts`) natively has
 * basename semantics in both ripgrep and fd, matching at any directory depth
 * without needing a leading `**\/` prefix. A token whose last segment has no dot
 * (`Dockerfile`, `src/LICENSE`) is ambiguous between an extensionless file and
 * a directory; it carries both readings so neither can silently match nothing.
 * External absolute, ~/, or ../ roots are resolved to a concrete external search
 * root so both grep and find operate consistently.
 */

import { statSync } from "node:fs";
import { homedir } from "node:os";
import * as nodePath from "node:path";
import { minimatch } from "minimatch";

/** Characters that make a token a glob rather than a literal path. */
const GLOB_CHARS = /[*?[\]{}]/;

export type ConstraintKind = "directory" | "filename" | "glob" | "ambiguous";

export interface ParsedConstraint {
  readonly kind: ConstraintKind;
  /** The token as written by the model, trimmed. */
  readonly raw: string;
  /** Root-relative matcher globs representing this constraint. */
  readonly globs: readonly string[];
}

/**
 * Split a constraint field into tokens. A string uses commas as separators;
 * array elements are already tokens and remain verbatim, so paths containing
 * spaces or commas are expressible. Brace globs are protected:
 * `{src,lib}/**` contains a comma that must not split.
 */
export function splitConstraints(input: string | readonly string[]): string[] {
  if (Array.isArray(input)) {
    return input
      .filter((part): part is string => typeof part === "string")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
  }

  const tokens: string[] = [];
  let depth = 0;
  let current = "";
  const flush = () => {
    const token = current.trim();
    if (token.length > 0) tokens.push(token);
    current = "";
  };

  for (const char of input as string) {
    if (char === "{") depth++;
    else if (char === "}") depth = Math.max(0, depth - 1);

    // Inside braces a comma belongs to the glob alternation, not to us.
    if (depth === 0 && char === ",") {
      flush();
      continue;
    }
    current += char;
  }
  flush();
  return tokens;
}

/** Expand leading ~ using the operating system's homedir. */
function expandHome(raw: string): string {
  if (raw === "~") return homedir();
  if (raw.startsWith("~/") || raw.startsWith("~\\")) {
    return nodePath.join(homedir(), raw.slice(2));
  }
  return raw;
}

/** Strip trailing slashes, preserving Windows drive root like C:/ */
function trimTrailingSlashes(raw: string): string {
  if (/^[A-Za-z]:[\\/]+$/.test(raw)) {
    return `${raw.slice(0, 2)}/`;
  }
  return raw.replace(/[\\/]+$/, "");
}

/** Normalize paths without glob metacharacters, preserving UNC root if present. */
function normalizeLexicalPath(raw: string): string {
  const isUnc = raw.startsWith("\\\\") || raw.startsWith("//");
  const posix = raw.replaceAll("\\", "/");
  const hasTrailingSlash = posix.endsWith("/");
  let normalized = nodePath.posix.normalize(posix);
  if (isUnc && !normalized.startsWith("//")) {
    normalized = `/${normalized}`;
  }
  return hasTrailingSlash && !normalized.endsWith("/") && normalized !== "."
    ? `${normalized}/`
    : normalized;
}

/** Normalize the static directory prefix before any glob metacharacters. */
function normalizeConstraintToken(raw: string): string {
  const expanded = expandHome(raw);
  const posix = expanded.replaceAll("\\", "/");
  const firstMagic = posix.search(GLOB_CHARS);
  if (firstMagic === -1) {
    return normalizeLexicalPath(posix);
  }
  const lastSlashBeforeMagic = posix.slice(0, firstMagic).lastIndexOf("/");
  if (lastSlashBeforeMagic === -1) {
    return posix;
  }
  const staticPrefix = posix.slice(0, lastSlashBeforeMagic + 1);
  const globSuffix = posix.slice(lastSlashBeforeMagic + 1);
  const normalizedPrefix = normalizeLexicalPath(staticPrefix);
  if (normalizedPrefix === "." || normalizedPrefix === "./" || normalizedPrefix === "") {
    return globSuffix;
  }
  const prefixWithSlash = normalizedPrefix.endsWith("/") ? normalizedPrefix : `${normalizedPrefix}/`;
  return `${prefixWithSlash}${globSuffix}`;
}

function isDotDotOnly(raw: string): boolean {
  const segments = raw.replace(/\/+$/, "").split("/");
  return segments.length > 0 && segments.every((s) => s === "..");
}

/**
 * Classify one token. `!` prefixes are accepted and dropped: the model is
 * told a leading `!` is optional in `exclude`, and tolerating it in both
 * fields avoids a class of silent no-op filters.
 */
export function parseConstraint(token: string): ParsedConstraint | undefined {
  let raw = token.trim();
  if (raw.startsWith("!")) raw = raw.slice(1).trim();
  // Pi's built-ins accept model-emitted @path references. Match that behavior
  // so replacing the built-ins does not turn a common path spelling into a
  // literal directory named "@src".
  if (raw.startsWith("@")) raw = raw.slice(1).trim();
  if (raw.length === 0) return undefined;

  raw = normalizeConstraintToken(raw);

  // '.' or empty string after stripping represents the current workspace root directory
  if (raw === "." || raw === "./" || raw === "") {
    return { kind: "directory", raw: "./", globs: ["**"] };
  }

  // Pure '..' sequence (e.g. '..', '../..', '../../../') represents a parent directory
  if (isDotDotOnly(raw)) {
    const dir = raw.endsWith("/") ? raw : `${raw}/`;
    return { kind: "directory", raw: dir, globs: [`${dir}**`] };
  }

  if (GLOB_CHARS.test(raw)) {
    return { kind: "glob", raw, globs: [raw] };
  }

  if (raw.endsWith("/")) {
    const dir = trimTrailingSlashes(raw);
    const glob = dir.endsWith("/") ? `${dir}**` : `${dir}/**`;
    return { kind: "directory", raw, globs: [glob] };
  }

  // A dot in the last segment means a filename.
  const lastSlash = raw.lastIndexOf("/");
  const lastSegment = raw.slice(lastSlash + 1);
  if (lastSegment.includes(".")) {
    return { kind: "filename", raw, globs: [raw] };
  }

  // No dot in the last segment: `Dockerfile`, `LICENSE`, `Makefile` are
  // files, while `src`, `packages/pi-find` are directories written without
  // a trailing slash.
  return { kind: "ambiguous", raw, globs: [raw, `${raw}/**`] };
}

export interface ConstraintPlan {
  /** Positive globs from `path`. Empty means "no include filter". */
  readonly include: readonly string[];
  /** Root-relative matcher globs from `exclude`. */
  readonly exclude: readonly string[];
  /** Directory search paths pushed down to rg/fd for traversal pruning. */
  readonly searchDirs: readonly string[];
  /** External absolute, ~/, or ../ root used when the search leaves the workspace. */
  readonly searchRoot?: string;
}

export type ConstraintPlanningResult =
  | { readonly kind: "valid"; readonly plan: ConstraintPlan }
  | { readonly kind: "invalid"; readonly reason: "mixed-external-path" };

function isParentPath(raw: string): boolean {
  return raw === ".." || raw.startsWith("../") || raw.startsWith("..\\");
}

function isExternalPath(raw: string): boolean {
  return (
    nodePath.isAbsolute(raw) ||
    isParentPath(raw) ||
    /^[A-Za-z]:[\\/]/.test(raw)
  );
}

function lastSeparatorIndex(value: string): number {
  return Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
}

function rootBeforeSeparator(raw: string, separator: number): string {
  if (separator === 0) return raw.slice(0, 1);
  if (separator === 2 && /^[A-Za-z]:[\\/]/.test(raw)) return raw.slice(0, 3);
  return raw.slice(0, separator);
}

/** Turn one normalized absolute or ../ path into a resolved absolute path. */
function resolveExternal(raw: string, cwd?: string): string {
  return cwd ? nodePath.resolve(cwd, raw) : nodePath.resolve(raw);
}

/**
 * True when an external constraint is known to be a file. Only a stat can
 * settle `~/notes` or `/etc/hosts`; anything unresolvable keeps the directory
 * reading, so rg reports the bad root instead of silently matching nothing.
 */
function isExternalFile(raw: string, cwd?: string): boolean {
  try {
    return !statSync(resolveExternal(raw, cwd)).isDirectory();
  } catch {
    return false;
  }
}

function relativeWithin(base: string, candidate: string): string | undefined {
  const relative = nodePath.relative(base, candidate).replaceAll("\\", "/");
  return relative === "" || isRelativeRelPath(relative) ? relative : undefined;
}

function isWithinDir(base: string, candidate: string): boolean {
  return relativeWithin(base, candidate) !== undefined;
}

function planExternalConstraint(
  constraint: ParsedConstraint,
  cwd?: string,
): { searchRoot: string; include: readonly string[] } {
  const raw = constraint.raw;

  if (constraint.kind === "directory") {
    const trimmed = trimTrailingSlashes(raw);
    return { searchRoot: trimmed.length > 0 ? trimmed : raw, include: [] };
  }

  if (constraint.kind === "filename" || constraint.kind === "ambiguous") {
    // An ambiguous external token is a file only when the filesystem says so;
    // otherwise it keeps the directory reading (root = the path itself).
    if (constraint.kind === "ambiguous" && !isExternalFile(raw, cwd)) {
      return { searchRoot: raw, include: [] };
    }
    const separator = lastSeparatorIndex(raw);
    return {
      searchRoot: rootBeforeSeparator(raw, separator),
      include: [`/${raw.slice(separator + 1)}`],
    };
  }

  const firstMagic = raw.search(GLOB_CHARS);
  const separator = lastSeparatorIndex(raw.slice(0, firstMagic));
  return {
    searchRoot: rootBeforeSeparator(raw, separator),
    include: [`/${raw.slice(separator + 1)}`],
  };
}

function isRelativeRelPath(rel: string): boolean {
  if (rel.startsWith("../") || rel === "..") return false;
  if (rel.startsWith("/") || rel.startsWith("\\")) return false;
  if (/^[A-Za-z]:/.test(rel)) return false;
  return !nodePath.isAbsolute(rel);
}

function rootGlob(glob: string): string {
  return glob.startsWith("**") ? glob : `/${glob}`;
}

function rebaseAncestorGlob(globSuffix: string, segments: readonly string[]): string[] {
  const globParts = globSuffix.split("/");
  for (const segment of segments) {
    if (globParts.length === 0) return [];
    if (globParts[0] === "**") return [rootGlob(globParts.join("/"))];
    if (!minimatch(segment, globParts[0], { dot: true })) return [];
    globParts.shift();
  }
  return [rootGlob(globParts.length === 0 ? "**" : globParts.join("/"))];
}

/**
 * Rewrite an exclude constraint so it applies within the target search root.
 *
 * Ordinary relative constraints (e.g. `*.min.js`, `Dockerfile`, `test/`, `src/deep/`)
 * are based on the target search root directly.
 * External constraints (absolute, `~/`, or `../`) are resolved and rebased:
 * - If exclude is an ancestor of or equal to targetRoot -> `**` (entire root excluded)
 * - If exclude is a subpath of targetRoot -> rebased relative glob
 * - If exclude is disjoint -> dropped (returns `[]`)
 */
function rewriteExcludeForRoot(
  excludeConstraint: ParsedConstraint,
  targetRoot: string,
  cwd?: string,
): string[] {
  const raw = excludeConstraint.raw;

  if (!isExternalPath(raw)) {
    return [...excludeConstraint.globs];
  }

  const resolvedTargetRoot = resolveExternal(targetRoot, cwd);
  const firstMagic = raw.search(GLOB_CHARS);
  if (firstMagic !== -1) {
    const separator = lastSeparatorIndex(raw.slice(0, firstMagic));
    const staticDir = resolveExternal(rootBeforeSeparator(raw, separator), cwd);
    const globSuffix = raw.slice(separator + 1);

    const staticWithinTarget = relativeWithin(resolvedTargetRoot, staticDir);
    if (staticWithinTarget !== undefined) {
      const relativeGlob = [staticWithinTarget, globSuffix]
        .filter((part) => part.length > 0)
        .join("/");
      return [rootGlob(relativeGlob)];
    }

    const targetWithinStatic = relativeWithin(staticDir, resolvedTargetRoot);
    return targetWithinStatic === undefined
      ? []
      : rebaseAncestorGlob(
          globSuffix,
          targetWithinStatic.length === 0 ? [] : targetWithinStatic.split("/"),
        );
  }

  const resolvedExclude = resolveExternal(raw, cwd);
  if (relativeWithin(resolvedExclude, resolvedTargetRoot) !== undefined) {
    return ["**"];
  }

  const excludeWithinTarget = relativeWithin(resolvedTargetRoot, resolvedExclude);
  if (excludeWithinTarget === undefined) return [];
  if (excludeConstraint.kind === "directory") {
    return [`${excludeWithinTarget}/**`];
  }
  if (excludeConstraint.kind === "ambiguous") {
    return [`/${excludeWithinTarget}`, `/${excludeWithinTarget}/**`];
  }
  return [`/${excludeWithinTarget}`];
}

/**
 * Extract base directory for fd search pruning when explicitly specified as a
 * directory constraint (with trailing slash). Ambiguous tokens, filenames, and
 * globs are intentionally not pruned to avoid treating non-directories as
 * directories or over-constraining the search.
 */
function extractSearchDir(constraint: ParsedConstraint): string | undefined {
  if (constraint.kind === "directory") {
    const trimmed = trimTrailingSlashes(constraint.raw);
    return trimmed.length > 0 ? trimmed : ".";
  }
  return undefined;
}

/**
 * Prune subsumed child directories from searchDirs when an ancestor directory
 * is already present, avoiding redundant fd traversals and duplicate hits.
 * Expects normalized token paths without trailing slashes.
 */
function pruneSubsumedDirs(dirs: readonly string[]): string[] {
  const normalized = [...new Set(dirs.map((d) => d.replace(/\/+$/, "")))];
  if (normalized.some((d) => d === "." || d === "")) {
    return ["."];
  }
  normalized.sort((a, b) => a.length - b.length || a.localeCompare(b));
  const kept: string[] = [];
  for (const dir of normalized) {
    if (!kept.some((parent) => dir === parent || dir.startsWith(`${parent}/`))) {
      kept.push(dir);
    }
  }
  return kept;
}

/**
 * Build the include/exclude/searchRoot plan for one call.
 *
 * Relative constraints always remain cwd-relative globs so returned paths,
 * excludes, and pattern matching share the same namespace as read/edit. A single
 * absolute, ~/, or ../ constraint is split into an external root plus relative glob;
 * mixing it with any other include returns an explicit invalid result.
 */
export function planConstraints(
  path: string | readonly string[] | undefined,
  exclude: string | readonly string[] | undefined,
  cwd?: string,
): ConstraintPlanningResult {
  const includeTokens = path === undefined ? [] : splitConstraints(path);
  const excludeTokens = exclude === undefined ? [] : splitConstraints(exclude);

  const included = includeTokens
    .map(parseConstraint)
    .filter((c): c is ParsedConstraint => c !== undefined);
  const excluded = excludeTokens
    .map(parseConstraint)
    .filter((c): c is ParsedConstraint => c !== undefined);

  const external = included.filter((constraint) =>
    isExternalPath(constraint.raw)
  );

  if (external.length > 0) {
    if (included.length !== 1) {
      return { kind: "invalid", reason: "mixed-external-path" };
    }
    const planned = planExternalConstraint(external[0]!, cwd);
    // planned.searchRoot can still be relative to the request cwd (for example
    // ../workspace/src). Resolve it before containment checks: nodePath.relative
    // otherwise interprets it against process.cwd(), which may differ from ctx.cwd.
    const resolvedPlannedRoot = resolveExternal(planned.searchRoot, cwd);
    const targetRoot = cwd && isWithinDir(cwd, resolvedPlannedRoot)
      ? cwd
      : resolvedPlannedRoot;
    const rewrittenExcludes = excluded.flatMap((c) =>
      rewriteExcludeForRoot(c, targetRoot, cwd)
    );
    return {
      kind: "valid",
      plan: {
        include: planned.include,
        exclude: rewrittenExcludes,
        searchDirs: [],
        searchRoot: planned.searchRoot,
      },
    };
  }

  const targetRoot = cwd ?? ".";
  const excludeGlobs = excluded.flatMap((c) =>
    rewriteExcludeForRoot(c, targetRoot, cwd)
  );

  const extractedDirs = included.map(extractSearchDir);
  const allHaveDir = included.length > 0 && extractedDirs.every((d) => d !== undefined);
  const searchDirs = allHaveDir
    ? pruneSubsumedDirs(extractedDirs.filter((d): d is string => d !== undefined))
    : [];

  return {
    kind: "valid",
    plan: {
      include: included.flatMap((c) => c.globs),
      exclude: excludeGlobs,
      searchDirs,
    },
  };
}
