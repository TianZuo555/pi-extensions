/**
 * Path-constraint DSL shared by grep, find, and multi_grep.
 *
 * The model writes one string for `path` and one for `exclude`, and we turn
 * those into ripgrep `--glob` / fd `--exclude` arguments. Three shapes are
 * accepted, distinguished without touching the filesystem so the same parse
 * works for excludes (which never name an existing path) and for constraints
 * pointing outside the workspace:
 *
 *   directory prefix   `src/`, `src/foo/`   → everything beneath it
 *   bare filename      `main.rs`            → that filename at any depth
 *   glob               `*.ts`, `src/**\/*.cc`, `{src,lib}/**`
 *
 * A bare filename must become `**\/main.rs`, because a rooted `main.rs` glob
 * only matches at the top level and would silently drop nested hits. A token
 * whose last segment has no dot (`Dockerfile`, `src/LICENSE`) is ambiguous
 * between an extensionless file and a directory; it carries both readings so
 * neither can silently match nothing. External absolute or ~/ roots are the
 * one place a stat is allowed: they name a concrete location, and the wrong
 * guess would make rg fail to start at all.
 */

import { statSync } from "node:fs";
import * as nodePath from "node:path";

/** Characters that make a token a glob rather than a literal path. */
const GLOB_CHARS = /[*?[\]{}]/;

export type ConstraintKind = "directory" | "filename" | "glob" | "ambiguous";

export interface ParsedConstraint {
  readonly kind: ConstraintKind;
  /** The token as written by the model, trimmed. */
  readonly raw: string;
  /** Globs suitable for `rg --glob` / `fd --glob`, without negation. */
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

  if (GLOB_CHARS.test(raw)) {
    return { kind: "glob", raw, globs: [raw] };
  }

  if (raw.endsWith("/")) {
    const dir = raw.replace(/\/+$/, "");
    // Both the directory itself and its contents; rg matches files only, but
    // fd also lists directories and would otherwise keep the bare dir entry.
    return { kind: "directory", raw, globs: [`${dir}/**`] };
  }

  // A dot in the last segment means a filename.
  const lastSegment = raw.slice(raw.lastIndexOf("/") + 1);
  if (lastSegment.includes(".")) {
    // Rooted when the model gave a path, any-depth when it gave a bare name.
    const glob = raw.includes("/") ? raw : `**/${raw}`;
    return { kind: "filename", raw, globs: [glob] };
  }

  // No dot in the last segment: `Dockerfile`, `LICENSE`, `Makefile` are
  // files, while `src`, `packages/pi-search` are directories written without
  // a trailing slash. Without touching the filesystem both readings are
  // plausible, so emit both — a directory-only glob would silently return
  // nothing for every extensionless file.
  const fileGlob = raw.includes("/") ? raw : `**/${raw}`;
  return { kind: "ambiguous", raw, globs: [fileGlob, `${raw}/**`] };
}

export interface ConstraintPlan {
  /** Positive globs from `path`. Empty means "no include filter". */
  readonly include: readonly string[];
  /** Negated globs from `exclude`, already `!`-prefixed for ripgrep. */
  readonly exclude: readonly string[];
  /** External absolute or ~/ root used when the search leaves the workspace. */
  readonly searchRoot?: string;
  /** Multiple external roots cannot be represented by one rg/fd invocation. */
  readonly hasMixedExternalRoots?: boolean;
}

function isHomePath(raw: string): boolean {
  return raw === "~" || raw.startsWith("~/") || raw.startsWith("~\\");
}

function isExternalPath(raw: string): boolean {
  return isHomePath(raw) || nodePath.isAbsolute(raw);
}

function lastSeparatorIndex(value: string): number {
  return Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
}

function rootBeforeSeparator(raw: string, separator: number): string {
  if (separator === 0) return raw.slice(0, 1);
  if (separator === 2 && /^[A-Za-z]:[\\/]/.test(raw)) return raw.slice(0, 3);
  return raw.slice(0, separator);
}

/** Turn one absolute or ~/ file/glob into a search root plus relative glob. */
function expandHome(raw: string): string {
  if (!raw.startsWith("~")) return raw;
  return nodePath.join(process.env.HOME ?? "", raw.slice(1));
}

/**
 * True when an external constraint is known to be a file. Only a stat can
 * settle `~/notes` or `/etc/hosts`; anything unresolvable keeps the directory
 * reading, so rg reports the bad root instead of silently matching nothing.
 */
function isExternalFile(raw: string): boolean {
  try {
    return !statSync(expandHome(raw)).isDirectory();
  } catch {
    return false;
  }
}

function planExternalConstraint(
  constraint: ParsedConstraint,
): { searchRoot: string; include: readonly string[] } {
  const raw = constraint.raw;
  if (constraint.kind === "directory") {
    const trimmed = raw.replace(/[\\/]+$/, "");
    return { searchRoot: trimmed.length > 0 ? trimmed : raw, include: [] };
  }

  if (constraint.kind === "filename" || constraint.kind === "ambiguous") {
    // An ambiguous external token is a file only when the filesystem says so;
    // otherwise it keeps the directory reading (root = the path itself).
    if (constraint.kind === "ambiguous" && !isExternalFile(raw)) {
      return { searchRoot: raw, include: [] };
    }
    const separator = lastSeparatorIndex(raw);
    return {
      searchRoot: rootBeforeSeparator(raw, separator),
      include: [raw.slice(separator + 1)],
    };
  }

  const firstMagic = raw.search(GLOB_CHARS);
  const separator = lastSeparatorIndex(raw.slice(0, firstMagic));
  return {
    searchRoot: rootBeforeSeparator(raw, separator),
    include: [raw.slice(separator + 1)],
  };
}

/**
 * Build the include/exclude/searchRoot plan for one call.
 *
 * Relative constraints always remain cwd-relative globs so returned paths,
 * excludes, and fuzzy scoring share the same namespace as read/edit. A single
 * absolute or ~/ constraint is split into an external root plus relative glob.
 */
export function planConstraints(
  path: string | readonly string[] | undefined,
  exclude: string | readonly string[] | undefined,
): ConstraintPlan {
  const includeTokens = path === undefined ? [] : splitConstraints(path);
  const excludeTokens = exclude === undefined ? [] : splitConstraints(exclude);

  const included = includeTokens
    .map(parseConstraint)
    .filter((c): c is ParsedConstraint => c !== undefined);
  const excluded = excludeTokens
    .map(parseConstraint)
    .filter((c): c is ParsedConstraint => c !== undefined);

  const excludeGlobs = excluded.flatMap((c) =>
    c.globs.map((glob) => `!${glob}`)
  );
  const external = included.filter((constraint) =>
    isExternalPath(constraint.raw)
  );

  if (external.length > 0) {
    if (included.length !== 1) {
      return {
        include: [],
        exclude: excludeGlobs,
        hasMixedExternalRoots: true,
      };
    }
    const planned = planExternalConstraint(external[0]!);
    return {
      include: planned.include,
      exclude: excludeGlobs,
      searchRoot: planned.searchRoot,
    };
  }

  return {
    include: included.flatMap((c) => c.globs),
    exclude: excludeGlobs,
  };
}

/** Glob arguments in rg/fd order: includes first, then negations. */
export function toGlobArgs(plan: ConstraintPlan, flag = "--glob"): string[] {
  const args: string[] = [];
  for (const glob of plan.include) args.push(flag, glob);
  for (const glob of plan.exclude) args.push(flag, glob);
  return args;
}
