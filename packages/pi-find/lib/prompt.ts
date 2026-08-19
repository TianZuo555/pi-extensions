/**
 * Model-facing prompt strings and parameter descriptions for the search tools.
 *
 * Division of channels: the schema (tool + parameter descriptions) teaches
 * the syntax a model cannot guess — the path DSL, exclude syntax, whole-path
 * find matching, pattern-array literals. Numeric bounds are omitted from the
 * prose because the schema already carries them as minimum/maximum; only
 * defaults, which it cannot express, are stated. The guidelines carry only
 * behaviour (stop-searching budgets) and must never restate the schema: pi
 * ships its built-in grep/find with an empty `guidelines` array, so every
 * line there buys system-prompt tokens in every request.
 *
 * Error and hint strings are the exception to the brevity rule. They are paid
 * for only once the model is already off-track, so they keep the remediation
 * and the reason a retry would fail the same way.
 */

export const DEFAULT_GREP_LIMIT = 20;
export const DEFAULT_FIND_LIMIT = 30;
export const MAX_GREP_LIMIT = 1_000;
export const MAX_FIND_LIMIT = 1_000;
export const MAX_CONTEXT_LINES = 20;

const PATH_DSL_DESCRIPTION =
    "Paths, filenames, or globs ('src/', 'main.rs', '*.ts'); absolute/~/ paths allowed.";

const EXCLUDE_DSL_DESCRIPTION =
    "Paths to exclude, same syntax as path ('test/,*.min.js').";

// --- grep --------------------------------------------------------------------

export const GREP_TOOL_DESCRIPTION =
    "Search file contents across the workspace. Respects .gitignore; hidden files are included.";

export const GREP_PROMPT_SNIPPET = "Search file contents across the workspace";

export const GREP_PROMPT_GUIDELINES = [
    "grep: narrow with path/exclude rather than raising limit.",
    "grep: after 1-2 searches, read the best match — a third variation rarely finds anything new.",
];

export const GREP_PARAMETER_DESCRIPTIONS = {
    pattern:
        "A regex or literal string, or an array of literals matching any (e.g. ['user_id', 'userId']).",
    path: PATH_DSL_DESCRIPTION,
    exclude: EXCLUDE_DSL_DESCRIPTION,
    caseSensitive:
        "Force exact-case matching. Default: smart-case — insensitive for all-lowercase patterns, sensitive otherwise.",
    context: "Lines of context to show before and after each match (default 0).",
    limit: `Maximum matches to return (default ${DEFAULT_GREP_LIMIT}).`,
};

// --- find --------------------------------------------------------------------

export const FIND_TOOL_DESCRIPTION =
    "Find files by whole-path match. Respects .gitignore; hidden files are included. Locates paths, not contents.";

export const FIND_PROMPT_SNIPPET = "Find files by whole-path match";

export const FIND_PROMPT_GUIDELINES = [
    "find: try it first when the user names a concept — two or three words beat guessing a filename.",
];

export const FIND_PARAMETER_DESCRIPTIONS = {
    pattern:
        "Whitespace-separated words must all match the path, in any order; each is a substring or regex.",
    path: PATH_DSL_DESCRIPTION,
    exclude: EXCLUDE_DSL_DESCRIPTION,
    limit: `Maximum files to return (default ${DEFAULT_FIND_LIMIT}).`,
};

// --- result framing ----------------------------------------------------------

export const NO_GREP_MATCHES = "No matches found.";
export const NO_FILES_FOUND = "No files found.";

/**
 * Refuse a wildcard-only pattern. The model reaches for `grep '.*'` to read a
 * whole file; saying so plainly prevents a long retry loop.
 */
export const WILDCARD_ONLY_ERROR =
    "A wildcard-only pattern matches every line, which is never useful. Use read for a file, find for paths, or grep with a real pattern.";

export const MIXED_EXTERNAL_PATH_ERROR =
    "An absolute, ~/, or ../ path must be the only path constraint; run separate searches for other paths or globs.";

export const EMPTY_PATTERN_ERROR =
    "Search pattern cannot be empty. Pass a non-empty pattern, or use find to locate files by path.";

/**
 * Refuse a wildcard-only find pattern: matching every path is what an empty
 * pattern or a path glob already expresses precisely.
 */
export const FIND_WILDCARD_ONLY_ERROR =
    "A wildcard-only pattern matches every path, same as listing files. Use an empty pattern to list everything under path, or a glob in path.";

export function grepResultHeader(
    matchCount: number,
    fileCount: number,
): string {
    return `${matchCount} match${matchCount === 1 ? "" : "es"} in ${fileCount} file${
        fileCount === 1 ? "" : "s"
    }`;
}

export function findResultHeader(fileCount: number): string {
    return `${fileCount} file${fileCount === 1 ? "" : "s"}`;
}

export function tooManyResultsNotice(
    shown: number,
    total: number,
    kind: "grep" | "find",
): string {
    const remaining = total - shown;
    // Output pages are capped by lines/bytes, so a higher limit cannot reveal
    // what was omitted — only a narrower search (or less context) can.
    const narrow = kind === "grep"
        ? "Narrow the search with path/exclude or reduce context"
        : "Narrow the search with path/exclude";
    return `[Showing ${shown} of ${total} output lines (${remaining} more line${
        remaining === 1 ? "" : "s"
    } omitted). ${narrow}; raising limit does not reveal omitted lines.]`;
}

export function resultLimitNotice(
    kind: "matches" | "files",
    limit: number,
    maximum: number,
): string {
    const nextLimit = Math.min(maximum, limit * 2);
    const continuation =
        nextLimit > limit
            ? `rerun with limit=${nextLimit} to show more results, or `
            : "";
    return `[Result limit reached at ${limit} ${kind}; ${continuation}narrow the search with path/exclude.]`;
}

/** Explain an empty result so the model adjusts instead of retrying verbatim. */
export function emptyResultHint(hasConstraints: boolean): string {
    return hasConstraints
        ? " Path/exclude filters may be excluding it — retry without them to confirm the pattern itself matches."
        : "";
}

/**
 * Detect a pattern that looks like a stringified JSON array. Unwrapping it
 * automatically was rejected: '["ab"]' is a legal character-class regex whose
 * meaning silent recovery would change, and recovery could not be made both
 * safe and complete. Instead the schema stays strict and the model gets this
 * visible nudge to re-send the parameter as a real array.
 */
export function looksLikeStringifiedArray(pattern: string): boolean {
    const trimmed = pattern.trim();
    if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return false;
    try {
        const parsed: unknown = JSON.parse(trimmed);
        return Array.isArray(parsed);
    } catch {
        return false;
    }
}

export const STRINGIFIED_ARRAY_HINT =
    ' The pattern looks like a JSON array sent as a string. To search several literals, pass a real array: {"pattern": ["a", "b"]} — a single string starting with "[" is otherwise read as a regex character class.';
