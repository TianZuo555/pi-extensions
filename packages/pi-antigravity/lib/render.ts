/**
 * Native-style rendering for agy tool cards.
 *
 * Call lines mirror pi's built-in tools (`find <pattern> in <path>`,
 * `grep "<query>" in <path>`, `search_web "<query>"`, …) instead of raw JSON,
 * and result lines summarize counts where the output allows it. All strings
 * are single-line; pi's Text component handles wrapping and width safety.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";

/** agy tool name → native-equivalent label shown on the card. */
const LABELS: Record<string, string> = {
  run_command: "bash",
  view_file: "read",
  write_to_file: "write",
  replace_file_content: "edit",
  multi_replace_file_content: "edit",
  sed_file: "edit",
  list_dir: "ls",
  find_by_name: "find",
  grep_search: "grep",
};

export function agyToolLabel(tool: string): string {
  return LABELS[tool] ?? tool;
}

/** First defined string among the given keys (agy mixes key casings). */
function pickArg(input: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

/** Shorten an absolute path under $HOME to `~/...` like pi's own renderers. */
function shortenPath(path: string): string {
  const home = process.env.HOME;
  if (home && path.startsWith(home)) return `~${path.slice(home.length)}`;
  return path;
}

function asRecord(input: unknown): Record<string, unknown> {
  return typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
}

/**
 * One-line call summary, aligned with pi's native tool cards:
 * bold label + accent arguments, no `⏺` prefix, no JSON dump.
 */
export function formatAgyCall(tool: string, input: unknown, theme: Theme): string {
  const args = asRecord(input);
  const label = theme.fg("toolTitle", theme.bold(agyToolLabel(tool)));
  const invalid = theme.fg("error", "[invalid arg]");
  const path = (fallback: string) => {
    const raw = pickArg(args, [
      "path",
      "Path",
      "AbsolutePath",
      "SearchPath",
      "SearchDirectory",
      "DirectoryPath",
      "directory",
      "Directory",
      "url",
      "Url",
      "URL",
    ]);
    if (raw === undefined) return fallback;
    return theme.fg("accent", shortenPath(raw));
  };

  switch (tool) {
    case "search_web": {
      const query = pickArg(args, ["query", "Query", "search_query", "q"]);
      return `${label} ${query === undefined ? invalid : theme.fg("accent", `"${query}"`)}`;
    }
    case "read_url_content": {
      const url = pickArg(args, ["url", "Url", "URL"]);
      return `${label} ${url === undefined ? invalid : theme.fg("accent", url)}`;
    }
    case "run_command": {
      const command = pickArg(args, ["command", "Command", "cmd"]);
      return `${label} ${command === undefined ? invalid : theme.fg("accent", command)}`;
    }
    case "view_file":
    case "write_to_file":
    case "replace_file_content":
    case "multi_replace_file_content":
    case "sed_file":
    case "list_dir":
      return `${label} ${path(invalid)}`;
    case "find_by_name": {
      const pattern = pickArg(args, ["pattern", "Pattern", "glob", "name"]);
      const dir = pickArg(args, ["search_directory", "SearchDirectory", "path", "Path", "directory"]);
      const patternText = pattern === undefined ? invalid : theme.fg("accent", pattern);
      const dirText =
        dir === undefined ? "" : theme.fg("toolOutput", ` in ${shortenPath(dir)}`);
      return `${label} ${patternText}${dirText}`;
    }
    case "grep_search": {
      const query = pickArg(args, ["query", "Query", "pattern", "Pattern"]);
      const searchPath = pickArg(args, ["search_path", "SearchPath", "path", "Path"]);
      const queryText = query === undefined ? invalid : theme.fg("accent", `"${query}"`);
      const pathText =
        searchPath === undefined
          ? ""
          : theme.fg("toolOutput", ` in ${shortenPath(searchPath)}`);
      return `${label} ${queryText}${pathText}`;
    }
    default: {
      let json: string;
      try {
        json = JSON.stringify(input) ?? "";
      } catch {
        json = "";
      }
      const summary = !json || json === "{}" ? "" : json.length > 96 ? `${json.slice(0, 95)}…` : json;
      return summary ? `${label} ${theme.fg("dim", summary)}` : label;
    }
  }
}

export interface AgyResultSummary {
  /** e.g. "10 matches in 4 files", "3 results", "no results". */
  counts?: string;
}

/** Derive a count summary from ripgrep/fd-style line output when possible. */
export function summarizeAgyResult(tool: string, output: string | undefined): AgyResultSummary {
  const lines = (output ?? "").split("\n").filter((line) => line.trim());
  if (tool === "grep_search" && lines.length > 0) {
    const files = new Set<string>();
    for (const line of lines) {
      const sep = line.indexOf(":");
      if (sep > 0) files.add(line.slice(0, sep));
    }
    const matches = lines.length;
    const fileCount = files.size;
    return {
      counts:
        `${matches} match${matches === 1 ? "" : "es"}` +
        (fileCount > 0 ? ` in ${fileCount} file${fileCount === 1 ? "" : "s"}` : ""),
    };
  }
  if (tool === "find_by_name") {
    const n = lines.length;
    return { counts: n > 0 ? `${n} result${n === 1 ? "" : "s"}` : "no results" };
  }
  return {};
}
