/** Model-facing text for the intentionally small grep/find surface. */

export const GREP_RESULT_LIMIT = 100;
export const GREP_FILE_LIMIT = 200;
export const FIND_RESULT_LIMIT = 200;
export const AUTO_CONTEXT_LINES = 5;
export const AUTO_CONTEXT_MAX_MATCHES = 3;

/** Wall-clock budget for one rg/fd run; a search should finish well under it. */
export const SEARCH_TIMEOUT_MS = 30_000;

export const GREP_TOOL_DESCRIPTION =
  "Search file contents by case-sensitive regex; respects .gitignore; skips hidden paths. Up to 100 lines or 200 files.";
export const GREP_PROMPT_SNIPPET = "Search file contents with a regex";

export const GREP_PARAMETER_DESCRIPTIONS = {
  pattern: "Case-sensitive ripgrep regex.",
  path: "File or directory; defaults to cwd; name hidden paths explicitly ('.github').",
  glob: "Case-sensitive glob: basename (any depth) or path relative to the search root; ! to exclude.",
  output: "Matching lines (default), or file paths only.",
  literal: "Treat pattern as exact text, not regex.",
};

export const FIND_TOOL_DESCRIPTION =
  "Find files by case-insensitive glob; respects .gitignore; skips hidden paths. Up to 200 files.";
export const FIND_PROMPT_SNIPPET = "Find files with a glob";

export const FIND_PARAMETER_DESCRIPTIONS = {
  pattern:
    "Case-insensitive glob: basename (any depth) or path relative to the search root; ! to exclude.",
  path: "Directory; defaults to cwd; name hidden paths explicitly ('.github').",
};

export const QUOTED_PATH_NOTICE = "[JSON-decode quoted paths before read/edit.]";
export const FILE_SIZE_LIMIT_NOTICE = "[Files >4 MiB are skipped during traversal.]";
export const HIDDEN_PATH_NOTICE =
  '[Default searches skip hidden paths; set path explicitly to search one (e.g. ".github").]';
export const SLASH_GLOB_NOTICE =
  "[Globs containing / are relative to the search root, not the working directory.]";
export const AUTO_CONTEXT_NOTICE = "[Added up to 5 surrounding lines automatically.]";
export const NO_GREP_MATCHES = "No matches found.";
export const NO_FILES_FOUND = "No files found.";
export const EMPTY_PATTERN_ERROR = "Search pattern cannot be empty.";
export const GIT_PATH_ERROR = "Searches inside .git are excluded; choose a working-tree path.";

export function missingSearchPathError(searchPath: string): string {
  return `Search path does not exist: ${searchPath}.`;
}

export function findPathNotDirectoryError(searchPath: string): string {
  return `Find path is not a directory: ${searchPath}.`;
}

export function grepResultHeader(matchCount: number, fileCount: number, partial = false): string {
  const counts = `${matchCount} match${matchCount === 1 ? "" : "es"} in ${fileCount} file${
    fileCount === 1 ? "" : "s"
  }`;
  return partial ? `Showing ${counts} (partial results)` : counts;
}

export function findResultHeader(fileCount: number, partial = false): string {
  const count = `${fileCount} file${fileCount === 1 ? "" : "s"}`;
  return partial ? `Showing ${count} (partial results)` : count;
}

export function resultLimitNotice(kind: "matches" | "files", limit: number): string {
  return `[Result limit reached at ${limit} ${kind}; narrow pattern, path, or glob.]`;
}

export function outputLimitNotice(kind: "grep" | "find"): string {
  const unit = kind === "grep" ? "matches" : "files";
  return `[Output limit reached; narrow the search to see the omitted ${unit}.]`;
}

export function searchTimeoutNotice(timeoutMs: number): string {
  const seconds = Math.round(timeoutMs / 1000);
  return `[Search timed out after ${seconds}s; results are partial. Narrow the path, pattern, or glob.]`;
}

/** A record too large to buffer was dropped instead of read into memory. */
export function oversizedRecordNotice(limitBytes: number): string {
  return `[Skipped a record larger than ${Math.round(limitBytes / (1024 * 1024))} MiB; narrow the search.]`;
}
