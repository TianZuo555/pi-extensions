/**
 * Model-facing search text. Keep tool and schema wording short, precise, and
 * non-overlapping; detailed recovery belongs in on-demand result messages.
 */

export const DEFAULT_GREP_LIMIT = 20;
export const DEFAULT_FIND_LIMIT = 30;
export const MAX_GREP_LIMIT = 1_000;
export const MAX_FIND_LIMIT = 1_000;
export const MAX_CONTEXT_LINES = 20;

const PATH_DESCRIPTION =
    "Include directory, filename, or glob; absolute and ~/ paths allowed.";
const EXCLUDE_DESCRIPTION = "Excluded paths; same syntax as path.";

// --- grep --------------------------------------------------------------------

export const GREP_TOOL_DESCRIPTION =
    "Search file contents; respects .gitignore and includes hidden files.";
export const GREP_PROMPT_SNIPPET = "Search file contents";

export const GREP_PARAMETER_DESCRIPTIONS = {
    pattern: "String: regex or literal; array: literals matched with OR.",
    path: PATH_DESCRIPTION,
    exclude: EXCLUDE_DESCRIPTION,
    caseSensitive: "True forces case-sensitive; default is smart-case.",
    context: "Lines before/after matches; default 0.",
    limit: `Maximum matches; default ${DEFAULT_GREP_LIMIT}.`,
};

// --- find --------------------------------------------------------------------

export const FIND_TOOL_DESCRIPTION =
    "Find file paths, not contents; respects .gitignore and includes hidden files.";
export const FIND_PROMPT_SNIPPET = "Find files by path";

export const FIND_PARAMETER_DESCRIPTIONS = {
    pattern:
        "Whole-path substrings/regexes; spaces mean AND; empty lists all files.",
    path: PATH_DESCRIPTION,
    exclude: EXCLUDE_DESCRIPTION,
    limit: `Maximum files; default ${DEFAULT_FIND_LIMIT}.`,
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
