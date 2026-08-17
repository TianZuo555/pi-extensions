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
    "Search file contents across the workspace. Respects .gitignore and searches hidden files.";

export const GREP_PROMPT_SNIPPET =
    "Search file contents (path/exclude filters, smart-case, context)";

export const GREP_PROMPT_GUIDELINES = [
    "grep: prefer bare identifiers as patterns — a literal search is faster and cannot fail to compile. Regex is auto-detected; you never need to declare it.",
    "grep: narrow with path ('src/', '*.ts') and cut noise with exclude ('test/,*.min.js') instead of raising limit.",
    "grep: pass caseSensitive: true only to force exact case; the default already matches case when your pattern contains uppercase.",
    "grep: after 1-2 searches, read the best match instead of grepping again — a third variation of the same query rarely finds what the first two missed.",
];

export const GREP_PARAMETER_DESCRIPTIONS = {
    pattern:
        "Text to search for. Literal by default; treated as a regex when it contains regex syntax. Invalid regex syntax automatically falls back to literal search.",
    path: PATH_DSL_DESCRIPTION,
    exclude: EXCLUDE_DSL_DESCRIPTION,
    caseSensitive:
        "Force case-sensitive matching. Default is smart-case: case-insensitive when the pattern is all lowercase, case-sensitive otherwise.",
    context: `Lines of context to show before and after each match (default 0, maximum ${MAX_CONTEXT_LINES}).`,
    limit: `Maximum matches to return (default ${DEFAULT_GREP_LIMIT}, maximum ${MAX_GREP_LIMIT}).`,
    cursor: "Pagination cursor from a previous grep result. Send it with the same pattern; a cursor sent with a different query is rejected.",
};

// --- find --------------------------------------------------------------------

export const FIND_TOOL_DESCRIPTION =
    "Find files by whole-path match across the workspace. Respects .gitignore.";

export const FIND_PROMPT_SNIPPET =
    "Find files by whole-path substring or regex match";

export const FIND_PROMPT_GUIDELINES = [
    "find: matches the WHOLE repo-relative path, not just the filename — 'profile' also hits 'chrome/browser/profiles/x.cc'.",
    "find: use it as the first step whenever the user names a concept, feature, or symbol; two or three words narrow it (AND, any order), so 'search prompt' beats guessing a filename.",
    "find: for an exact filename or a known layout, pass a glob in path ('**/profile.h', 'src/**/*.test.ts') — that is a precise filter, while pattern is a substring/regex match.",
    "find: it locates paths, never contents. Use grep for contents, and read to open what find returned.",
];

export const FIND_PARAMETER_DESCRIPTIONS = {
    pattern:
        "Path query, matched against the whole repo-relative path. Literal substring by default; treated as a regex when it contains regex syntax (invalid regex falls back to literal). Whitespace-separated words must all match in any order. Pass an empty string to list files matching path alone.",
    path: PATH_DSL_DESCRIPTION,
    exclude: EXCLUDE_DSL_DESCRIPTION,
    limit: `Maximum files to return (default ${DEFAULT_FIND_LIMIT}, maximum ${MAX_FIND_LIMIT}).`,
    cursor: "Pagination cursor from a previous find result. Send it with the same pattern; a cursor sent with a different query is rejected.",
};

// --- multi_grep --------------------------------------------------------------

export const MULTI_GREP_TOOL_DESCRIPTION =
    "Search file contents for ANY of several literal patterns in one pass (faster than regex alternation or repeated greps).";

export const MULTI_GREP_PROMPT_SNIPPET =
    "Search for any of several literal patterns at once";

export const MULTI_GREP_PROMPT_GUIDELINES = [
    "multi_grep: use it when looking for several identifiers at once — one call beats several greps and shows which pattern each hit came from.",
    "multi_grep: include every naming-convention variant of a concept (snake_case, camelCase, PascalCase, SCREAMING_CASE) as separate patterns.",
    "multi_grep: patterns are literal, never regex. Use grep when you need a real pattern.",
];

export const MULTI_GREP_PARAMETER_DESCRIPTIONS = {
    patterns:
        "Literal strings to search for. A line matching any of them is returned. Include naming convention variants (e.g. snake_case, camelCase, PascalCase).",
    path: PATH_DSL_DESCRIPTION,
    exclude: EXCLUDE_DSL_DESCRIPTION,
    caseSensitive:
        "Force case-sensitive matching. Default is smart-case across all patterns.",
    context: `Lines of context to show before and after each match (default 0, maximum ${MAX_CONTEXT_LINES}).`,
    limit: `Maximum matches to return (default ${DEFAULT_GREP_LIMIT}, maximum ${MAX_GREP_LIMIT}).`,
    cursor: "Pagination cursor from a previous multi_grep result. Send it with the same patterns (any order); a cursor sent with a different query is rejected.",
};

// --- result framing ----------------------------------------------------------

export const NO_GREP_MATCHES = "No matches found.";
export const NO_FILES_FOUND = "No files found.";
export const CURSOR_EXPIRED =
    "That cursor is no longer available (cursors last for the session and are consumed once). Run the search again.";

/** The cursor exists but was sent with a different query than produced it. */
export const CURSOR_QUERY_MISMATCH =
    "That cursor belongs to a different query. Send it with its original query to page those results, or drop it to run the new search.";

/**
 * Refuse a wildcard-only pattern. The model reaches for `grep '.*'` to read a
 * whole file; saying so plainly prevents a long retry loop.
 */
export const WILDCARD_ONLY_ERROR =
    "A wildcard-only pattern matches every line, which is never a useful search. Use read to open a specific file, find to locate files, or grep with a real pattern.";

export const MIXED_EXTERNAL_ROOTS_ERROR =
    "A search can use only one absolute or ~/ path root at a time. Run separate searches for different external roots.";

/**
 * Refuse a wildcard-only find pattern: matching every path is what an empty
 * pattern or a path glob already expresses precisely.
 */
export const FIND_WILDCARD_ONLY_ERROR =
    "A wildcard-only pattern matches every path, which is the same as listing files. Drop pattern (or pass an empty string) to list everything under path, or use a glob in path for a precise filter.";

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
    cursorId: string,
): string {
    const remaining = total - shown;
    return `[Showing ${shown} of ${total} output lines. ${remaining} more line${
        remaining === 1 ? "" : "s"
    } available — pass cursor="${cursorId}" together with the same required query field(s), or narrow the search with path/exclude.]`;
}

export function resultLimitNotice(
    kind: "matches" | "files",
    limit: number,
    maximum: number,
): string {
    const nextLimit = Math.min(maximum, limit * 2);
    const continuation =
        nextLimit > limit
            ? `pass limit=${nextLimit} to continue farther, or `
            : "";
    return `[Result limit reached at ${limit} ${kind}; ${continuation}narrow the search with path/exclude.]`;
}

/** Explain an empty result so the model adjusts instead of retrying verbatim. */
export function emptyResultHint(hasConstraints: boolean): string {
    return hasConstraints
        ? " The path/exclude filters may be excluding it — try again without them to confirm the pattern itself matches."
        : "";
}
