/**
 * Native re-execution mapping — agy read-only tools whose work pi can redo
 * cheaply and safely with its own builtins. The provider emits these as
 * native pi toolCalls (real builtin name, pi-schema args); pi executes the
 * real builtin, so cards render with pi's own renderers and show live,
 * accurate output instead of agy's summary text.
 *
 * Mutating tools (commands, edits, writes) and agy-specialty tools are
 * never re-executed — they replay through the display-only `antigravity`
 * wrapper tool instead.
 */

export interface NativeToolCall {
  /** pi builtin tool name (`read`, `ls`, `grep`, `find`). */
  tool: string;
  /** Arguments conforming to the builtin's schema. */
  args: Record<string, unknown>;
}

/** First non-empty string among the given keys (agy mixes key casings). */
function str(input: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

/**
 * Map an agy tool step to a native pi toolCall when re-execution is safe.
 * Returns undefined for everything that must stay on the replay wrapper.
 */
export function mapAgyToolToNative(
  tool: string,
  args: Record<string, unknown>,
): NativeToolCall | undefined {
  switch (tool) {
    case "view_file": {
      const path = str(args, [
        "path",
        "Path",
        "AbsolutePath",
        "absolute_path",
        "TargetFile",
        "target_file",
        "FilePath",
        "file_path",
      ]);
      return path ? { tool: "read", args: { path } } : undefined;
    }
    case "list_dir": {
      const path = str(args, ["path", "Path", "DirectoryPath", "directory", "Directory"]);
      return path ? { tool: "ls", args: { path } } : undefined;
    }
    case "grep_search": {
      const pattern = str(args, ["query", "Query", "pattern", "Pattern"]);
      const path = str(args, ["search_path", "SearchPath", "path", "Path"]);
      return pattern
        ? { tool: "grep", args: path ? { pattern, path } : { pattern } }
        : undefined;
    }
    case "find_by_name": {
      const pattern = str(args, ["pattern", "Pattern", "glob", "name"]);
      const path = str(args, ["search_directory", "SearchDirectory", "path", "Path", "directory"]);
      return pattern
        ? { tool: "find", args: path ? { pattern, path } : { pattern } }
        : undefined;
    }
    default:
      return undefined;
  }
}
