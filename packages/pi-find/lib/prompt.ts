/**
 * Model-facing prompt strings and parameter descriptions for the search tools.
 *
 * Scope rule for the guidelines below: pi ships its built-in grep/find with an
 * empty `guidelines` array, so every line here has to earn its place in the
 * system prompt by describing behaviour a model cannot infer from a generic
 * grep/find prior — the path DSL, exclude syntax, whole-path find matching,
 * and the "stop searching, start reading" budget. Restating what the schema
 * already says only buys tokens.
 */

export const DEFAULT_GREP_LIMIT = 20;
export const DEFAULT_FIND_LIMIT = 30;
export const MAX_GREP_LIMIT = 1_000;
export const MAX_FIND_LIMIT = 1_000;
export const MAX_CONTEXT_LINES = 20;

const PATH_DSL_DESCRIPTION =
    "Path constraint. Directory prefix ('src/' or 'src/foo/'), bare filename ('main.rs' or an extensionless 'Dockerfile', matched at any depth), or glob ('*.ts', 'src/**/*.cc', '{src,lib}/**'). Applied to the full repo-relative path. Absolute and ~/ paths outside the workspace also work.";

const EXCLUDE_DSL_DESCRIPTION =
    "Exclude paths (comma-separated, or an array). Same syntax as path: directory prefix ('test/'), filename ('config.json'), or glob ('*.min.js', '**/*.{rs,go}'). Array elements stay verbatim for paths containing commas. A leading '!' is optional and ignored — both 'test/' and '!test/' work. Example: 'test/,*.min.js'.";

// --- grep --------------------------------------------------------------------

export const GREP_TOOL_DESCRIPTION =
    "Search file contents across the workspace. Respects .gitignore and searches hidden files. Supports a single string/regex or an array of literal strings to search for multiple patterns in one pass.";

export const GREP_PROMPT_SNIPPET =
    "Search file contents (single pattern or pattern array, path/exclude filters, smart-case, context)";

export const GREP_PROMPT_GUIDELINES = [
    "grep: pattern accepts a single string or an array of strings (e.g. ['user_id', 'userId']) to search for any of multiple literal patterns at once.",
    "grep: prefer bare identifiers as patterns — a literal search is faster. Regex is auto-detected for single string patterns; invalid regex automatically falls back to literal search.",
    "grep: narrow with path ('src/', '*.ts') and cut noise with exclude ('test/,*.min.js') instead of raising limit.",
    "grep: pass caseSensitive: true only to force exact case; the default already matches case when your pattern contains uppercase.",
    "grep: after 1-2 searches, read the best match instead of grepping again — a third variation of the same query rarely finds what the first two missed.",
];

export const GREP_PARAMETER_DESCRIPTIONS = {
    pattern:
        "Text or patterns to search for. Pass a single string (literal or regex) or an array of literal strings to search for ANY of several patterns in one pass (e.g. naming-convention variants). Single patterns automatically detect regex and fall back to literal on syntax error.",
    path: PATH_DSL_DESCRIPTION,
    exclude: EXCLUDE_DSL_DESCRIPTION,
    caseSensitive:
        "Force case-sensitive matching. Default is smart-case: case-insensitive when the pattern is all lowercase, case-sensitive otherwise.",
    context: `Lines of context to show before and after each match (default 0, maximum ${MAX_CONTEXT_LINES}).`,
    limit: `Maximum matches to return (default ${DEFAULT_GREP_LIMIT}, maximum ${MAX_GREP_LIMIT}).`,
};

// --- find --------------------------------------------------------------------

export const FIND_TOOL_DESCRIPTION =
    "Find files by whole-path match across the workspace. Respects .gitignore.";

export const FIND_PROMPT_SNIPPET =
    "Find files by whole-path substring or regex match";

export const FIND_PROMPT_GUIDELINES = [
    "find: matches the WHOLE repo-relative path, not just the filename — 'profile' also hits 'chrome/browser/profiles/x.cc'.",
    "find: use it as the first step whenever the user names a concept, feature, or symbol; two or three words narrow it (AND, any order), so 'search prompt' beats guessing a filename.",
    "find: for an exact filename, use path: 'profile.h' (basename match at any depth); reserve rooted globs such as 'src/**/*.test.ts' for known layouts. pattern is a substring/regex match.",
    "find: it locates paths, never contents. Use grep for contents, and read to open what find returned.",
];

export const FIND_PARAMETER_DESCRIPTIONS = {
    pattern:
        "Path query, matched against the whole repo-relative path. Literal substring by default; treated as a regex when it contains regex syntax (invalid regex falls back to literal). Whitespace-separated words must all match in any order. Pass an empty string to list files matching path alone.",
    path: PATH_DSL_DESCRIPTION,
    exclude: EXCLUDE_DSL_DESCRIPTION,
    limit: `Maximum files to return (default ${DEFAULT_FIND_LIMIT}, maximum ${MAX_FIND_LIMIT}).`,
};

// --- result framing ----------------------------------------------------------

export const NO_GREP_MATCHES = "No matches found.";
export const NO_FILES_FOUND = "No files found.";

/**
 * Refuse a wildcard-only pattern. The model reaches for `grep '.*'` to read a
 * whole file; saying so plainly prevents a long retry loop.
 */
export const WILDCARD_ONLY_ERROR =
    "A wildcard-only pattern matches every line, which is never a useful search. Use read to open a specific file, find to locate files, or grep with a real pattern.";

export const MIXED_EXTERNAL_PATH_ERROR =
    "An absolute, ~/, or ../ path must be the call's sole path constraint. Run separate searches for additional paths or globs.";

export const EMPTY_PATTERN_ERROR =
    "Search pattern cannot be empty. Pass a non-empty pattern to search for, or use find to locate files by path.";

/**
 * Refuse a wildcard-only find pattern: matching every path is what an empty
 * pattern or a path glob already expresses precisely.
 */
export const FIND_WILDCARD_ONLY_ERROR =
    "A wildcard-only pattern matches every path, which is the same as listing files. Pass an empty pattern to list everything under path, or use a glob in path for a precise filter.";

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
        ? " The path/exclude filters may be excluding it — try again without them to confirm the pattern itself matches."
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
    ' The pattern looks like a JSON array sent as a string. If you meant to search for multiple patterns, pass a real array: {"pattern": ["a", "b"]} — a single string starting with "[" is otherwise interpreted as a regex character class.';
