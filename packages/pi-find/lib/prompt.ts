/** Model-facing text for the intentionally small grep/find surface. */

export const GREP_RESULT_LIMIT = 100;
export const FIND_RESULT_LIMIT = 200;

/** Wall-clock budget for one rg/fd run; a search should finish well under it. */
export const SEARCH_TIMEOUT_MS = 30_000;

export const GREP_TOOL_DESCRIPTION =
  "Search file contents with a case-sensitive regex; respects .gitignore; 30s timeout.";
export const GREP_PROMPT_SNIPPET = "Search file contents with a regex";

export const GREP_PARAMETER_DESCRIPTIONS = {
  pattern: "Case-sensitive ripgrep regex.",
  path: "File or directory to search; default is the current directory.",
  glob: "Optional file glob, for example '*.ts' or '**/*.test.ts'.",
};

export const FIND_TOOL_DESCRIPTION = "Find files with a glob; respects .gitignore; 30s timeout.";
export const FIND_PROMPT_SNIPPET = "Find files with a glob";

export const FIND_PARAMETER_DESCRIPTIONS = {
  pattern: "File glob, for example '*.ts' or '**/*.test.ts'.",
  path: "Directory to search; default is the current directory.",
};

export const NO_GREP_MATCHES = "No matches found.";
export const NO_FILES_FOUND = "No files found.";
export const EMPTY_PATTERN_ERROR = "Search pattern cannot be empty.";

export function missingSearchPathError(searchPath: string): string {
  return `Search path does not exist: ${searchPath}.`;
}

export function findPathNotDirectoryError(searchPath: string): string {
  return `Find path is not a directory: ${searchPath}.`;
}

export function grepResultHeader(matchCount: number, fileCount: number): string {
  return `${matchCount} match${matchCount === 1 ? "" : "es"} in ${fileCount} file${
    fileCount === 1 ? "" : "s"
  }`;
}

export function findResultHeader(fileCount: number): string {
  return `${fileCount} file${fileCount === 1 ? "" : "s"}`;
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
