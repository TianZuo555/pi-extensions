/**
 * Tool registration for grep, find, and multi_grep.
 *
 * These deliberately reuse pi's built-in tool names so they override them: the
 * model keeps one obvious way to search and the system prompt does not carry
 * two competing search surfaces.
 */

import {
  DEFAULT_MAX_BYTES,
  truncateHead,
  type AgentToolResult,
  type ExtensionAPI,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import {
  candidateCapNotice,
  CURSOR_EXPIRED,
  DEFAULT_FIND_LIMIT,
  DEFAULT_GREP_LIMIT,
  emptyResultHint,
  FIND_PARAMETER_DESCRIPTIONS,
  FIND_PROMPT_GUIDELINES,
  findResultHeader,
  FIND_PROMPT_SNIPPET,
  FIND_TOOL_DESCRIPTION,
  GREP_PARAMETER_DESCRIPTIONS,
  GREP_PROMPT_GUIDELINES,
  GREP_PROMPT_SNIPPET,
  grepResultHeader,
  GREP_TOOL_DESCRIPTION,
  MAX_CONTEXT_LINES,
  MAX_FIND_LIMIT,
  MAX_GREP_LIMIT,
  MULTI_GREP_PARAMETER_DESCRIPTIONS,
  MULTI_GREP_PROMPT_GUIDELINES,
  MULTI_GREP_PROMPT_SNIPPET,
  MULTI_GREP_TOOL_DESCRIPTION,
  NO_FILES_FOUND,
  NO_GREP_MATCHES,
  resultLimitNotice,
  tooManyResultsNotice,
} from "./prompt.ts";
import {
  type GrepOutcome,
  MAX_FUZZY_CANDIDATES,
  runSearch,
  SearchRuntime,
  type SearchRuntimeInstance,
} from "../src/runtime.ts";

/**
 * path/exclude accept a single string or an array. Defined once and cloned per
 * use so each field carries its own description.
 */
const pathConstraint = (description: string) =>
  Type.Optional(
    Type.Union([Type.String(), Type.Array(Type.String())], { description }),
  );

export const GrepParams = Type.Object({
  pattern: Type.String({ description: GREP_PARAMETER_DESCRIPTIONS.pattern }),
  path: pathConstraint(GREP_PARAMETER_DESCRIPTIONS.path),
  exclude: pathConstraint(GREP_PARAMETER_DESCRIPTIONS.exclude),
  caseSensitive: Type.Optional(
    Type.Boolean({ description: GREP_PARAMETER_DESCRIPTIONS.caseSensitive }),
  ),
  context: Type.Optional(
    Type.Integer({
      minimum: 0,
      maximum: MAX_CONTEXT_LINES,
      description: GREP_PARAMETER_DESCRIPTIONS.context,
    }),
  ),
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: MAX_GREP_LIMIT,
      description: GREP_PARAMETER_DESCRIPTIONS.limit,
    }),
  ),
  cursor: Type.Optional(
    Type.String({ description: GREP_PARAMETER_DESCRIPTIONS.cursor }),
  ),
});

export type GrepInput = Static<typeof GrepParams>;

export const MultiGrepParams = Type.Object({
  patterns: Type.Array(Type.String(), {
    minItems: 1,
    description: MULTI_GREP_PARAMETER_DESCRIPTIONS.patterns,
  }),
  path: pathConstraint(MULTI_GREP_PARAMETER_DESCRIPTIONS.path),
  exclude: pathConstraint(MULTI_GREP_PARAMETER_DESCRIPTIONS.exclude),
  caseSensitive: Type.Optional(
    Type.Boolean({
      description: MULTI_GREP_PARAMETER_DESCRIPTIONS.caseSensitive,
    }),
  ),
  context: Type.Optional(
    Type.Integer({
      minimum: 0,
      maximum: MAX_CONTEXT_LINES,
      description: MULTI_GREP_PARAMETER_DESCRIPTIONS.context,
    }),
  ),
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: MAX_GREP_LIMIT,
      description: MULTI_GREP_PARAMETER_DESCRIPTIONS.limit,
    }),
  ),
  cursor: Type.Optional(
    Type.String({ description: MULTI_GREP_PARAMETER_DESCRIPTIONS.cursor }),
  ),
});

export type MultiGrepInput = Static<typeof MultiGrepParams>;

export const FindParams = Type.Object({
  pattern: Type.String({ description: FIND_PARAMETER_DESCRIPTIONS.pattern }),
  path: pathConstraint(FIND_PARAMETER_DESCRIPTIONS.path),
  exclude: pathConstraint(FIND_PARAMETER_DESCRIPTIONS.exclude),
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: MAX_FIND_LIMIT,
      description: FIND_PARAMETER_DESCRIPTIONS.limit,
    }),
  ),
  cursor: Type.Optional(
    Type.String({ description: FIND_PARAMETER_DESCRIPTIONS.cursor }),
  ),
});

export type FindInput = Static<typeof FindParams>;

export interface SearchDetails {
  readonly kind: "grep" | "find" | "multi_grep";
  readonly query: string;
  readonly resultCount: number;
  readonly fileCount: number;
  readonly truncated: boolean;
  readonly cursorStatus?: "continued" | "expired";
}

/**
 * Render grep matches grouped by file. `path:line: text` for hits and
 * `path-line- text` for context mirrors ripgrep's own convention, which models
 * already read fluently.
 */
export function renderGrepLines(outcome: GrepOutcome): string[] {
  const lines: string[] = [];
  let currentFile: string | undefined;

  for (const match of outcome.matches) {
    if (match.path !== currentFile) {
      if (currentFile !== undefined) lines.push("");
      lines.push(match.path);
      currentFile = match.path;
    }
    const separator = match.isMatch ? ":" : "-";
    lines.push(
      ` ${String(match.lineNumber).padStart(4)}${separator} ${match.text}`,
    );
  }

  return lines;
}

function countFiles(outcome: GrepOutcome): number {
  return new Set(outcome.matches.map((m) => m.path)).size;
}

interface PageResult {
  readonly text: string;
  readonly hasMore: boolean;
}

// Reserve space for the result header and actionable notices so the complete
// tool result always remains below pi's 50KB tool-output ceiling.
const PAGE_BODY_MAX_BYTES = DEFAULT_MAX_BYTES - 8 * 1024;

/** Emit one byte- and line-bounded page, storing the remainder in a cursor. */
function paginate(
  runtime: SearchRuntimeInstance,
  tool: string,
  lines: readonly string[],
  pageSize: number,
): PageResult {
  const page: string[] = [];
  let bytes = 0;
  let consumed = 0;

  for (const line of lines) {
    if (page.length >= pageSize) break;
    const separatorBytes = page.length === 0 ? 0 : 1;
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (page.length > 0 && bytes + separatorBytes + lineBytes > PAGE_BODY_MAX_BYTES) {
      break;
    }
    if (page.length === 0 && lineBytes > PAGE_BODY_MAX_BYTES) {
      page.push(
        truncateHead(line, {
          maxBytes: PAGE_BODY_MAX_BYTES,
          maxLines: 1,
        }).content,
      );
      consumed = 1;
      break;
    }
    page.push(line);
    bytes += separatorBytes + lineBytes;
    consumed += 1;
  }

  if (consumed >= lines.length) {
    return { text: page.join("\n"), hasMore: false };
  }

  const service = runtime.runSync(SearchRuntime);
  const rest = lines.slice(consumed);
  const cursorId = service.cursors.save(tool, rest);
  return {
    text: [
      ...page,
      "",
      tooManyResultsNotice(page.length, lines.length, cursorId),
    ].join("\n"),
    hasMore: true,
  };
}

/** Serve a stored page, or report that the cursor is no longer valid. */
function resumeCursor(
  runtime: SearchRuntimeInstance,
  tool: string,
  cursorId: string,
  pageSize: number,
): PageResult | undefined {
  const service = runtime.runSync(SearchRuntime);
  const page = service.cursors.take(tool, cursorId);
  if (page === undefined) return undefined;
  return paginate(runtime, tool, page.lines, pageSize);
}

/** Line budget per page; byte bounding above remains authoritative. */
const GREP_PAGE_LINES = 120;
const FIND_PAGE_LINES = 60;

export function registerTools(
  pi: ExtensionAPI,
  runtime: SearchRuntimeInstance,
): void {
  const grepExecute = async (
    tool: "grep" | "multi_grep",
    patterns: readonly string[],
    params: {
      path?: string | string[];
      exclude?: string | string[];
      caseSensitive?: boolean;
      context?: number;
      limit?: number;
      cursor?: string;
    },
    signal: AbortSignal | undefined,
    cwd: string,
  ) => {
    if (params.cursor !== undefined) {
      const resumed = resumeCursor(runtime, tool, params.cursor, GREP_PAGE_LINES);
      return {
        content: [
          {
            type: "text" as const,
            text: resumed?.text ?? CURSOR_EXPIRED,
          },
        ],
        details: {
          kind: tool,
          query: patterns.join(", "),
          resultCount: 0,
          fileCount: 0,
          truncated: resumed?.hasMore ?? false,
          cursorStatus: resumed === undefined ? "expired" : "continued",
        } satisfies SearchDetails,
      };
    }

    const service = runtime.runSync(SearchRuntime);
    const effectiveLimit = Math.min(
      MAX_GREP_LIMIT,
      Math.max(1, params.limit ?? DEFAULT_GREP_LIMIT),
    );
    const outcome = await runSearch(
      runtime,
      service.grep({
        patterns,
        literalOnly: tool === "multi_grep",
        path: params.path,
        exclude: params.exclude,
        caseSensitive: params.caseSensitive,
        context: params.context,
        limit: effectiveLimit,
        cwd,
        signal,
      }),
      { signal },
    );

    const matchCount = outcome.matches.filter((m) => m.isMatch).length;
    if (matchCount === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: NO_GREP_MATCHES + emptyResultHint(outcome.hasConstraints),
          },
        ],
        details: {
          kind: tool,
          query: patterns.join(", "),
          resultCount: 0,
          fileCount: 0,
          truncated: false,
        } satisfies SearchDetails,
      };
    }

    const rendered = renderGrepLines(outcome);
    const body = paginate(runtime, tool, rendered, GREP_PAGE_LINES);
    const fileCount = countFiles(outcome);
    const header = grepResultHeader(matchCount, fileCount);
    const notices = outcome.truncated
      ? [resultLimitNotice("matches", effectiveLimit, MAX_GREP_LIMIT)]
      : [];
    const text = [header, "", body.text, ...notices.flatMap((notice) => ["", notice])]
      .join("\n");

    return {
      content: [{ type: "text" as const, text }],
      details: {
        kind: tool,
        query: patterns.join(", "),
        resultCount: matchCount,
        fileCount,
        truncated: outcome.truncated || body.hasMore,
      } satisfies SearchDetails,
    };
  };

  pi.registerTool({
    name: "grep",
    label: "grep",
    description: GREP_TOOL_DESCRIPTION,
    promptSnippet: GREP_PROMPT_SNIPPET,
    promptGuidelines: GREP_PROMPT_GUIDELINES,
    parameters: GrepParams,

    async execute(_toolCallId, params: GrepInput, signal, _onUpdate, ctx) {
      return grepExecute("grep", [params.pattern], params, signal, ctx.cwd);
    },

    renderCall(args: GrepInput, theme: Theme) {
      const scope = args.path === undefined
        ? ""
        : theme.fg("muted", ` in ${formatConstraint(args.path)}`);
      return new Text(
        theme.fg("toolTitle", theme.bold("grep ")) +
          theme.fg("accent", `"${args.pattern}"`) +
          scope,
        0,
        0,
      );
    },

    renderResult(result, options, theme, context) {
      return renderSearchResult(result, options, theme, context.isError);
    },
  });

  pi.registerTool({
    name: "multi_grep",
    label: "multi_grep",
    description: MULTI_GREP_TOOL_DESCRIPTION,
    promptSnippet: MULTI_GREP_PROMPT_SNIPPET,
    promptGuidelines: MULTI_GREP_PROMPT_GUIDELINES,
    parameters: MultiGrepParams,

    async execute(_toolCallId, params: MultiGrepInput, signal, _onUpdate, ctx) {
      return grepExecute("multi_grep", params.patterns, params, signal, ctx.cwd);
    },

    renderCall(args: MultiGrepInput, theme: Theme) {
      const shown = args.patterns.slice(0, 3).join(", ");
      const more = args.patterns.length > 3
        ? theme.fg("muted", ` +${args.patterns.length - 3} more`)
        : "";
      return new Text(
        theme.fg("toolTitle", theme.bold("multi_grep ")) +
          theme.fg("accent", shown) +
          more,
        0,
        0,
      );
    },

    renderResult(result, options, theme, context) {
      return renderSearchResult(result, options, theme, context.isError);
    },
  });

  pi.registerTool({
    name: "find",
    label: "find",
    description: FIND_TOOL_DESCRIPTION,
    promptSnippet: FIND_PROMPT_SNIPPET,
    promptGuidelines: FIND_PROMPT_GUIDELINES,
    parameters: FindParams,

    async execute(_toolCallId, params: FindInput, signal, _onUpdate, ctx) {
      if (params.cursor !== undefined) {
        const resumed = resumeCursor(
          runtime,
          "find",
          params.cursor,
          FIND_PAGE_LINES,
        );
        return {
          content: [
            {
              type: "text" as const,
              text: resumed?.text ?? CURSOR_EXPIRED,
            },
          ],
          details: {
            kind: "find",
            query: params.pattern,
            resultCount: 0,
            fileCount: 0,
            truncated: resumed?.hasMore ?? false,
            cursorStatus: resumed === undefined ? "expired" : "continued",
          } satisfies SearchDetails,
        };
      }

      const service = runtime.runSync(SearchRuntime);
      const effectiveLimit = Math.min(
        MAX_FIND_LIMIT,
        Math.max(1, params.limit ?? DEFAULT_FIND_LIMIT),
      );
      const outcome = await runSearch(
        runtime,
        service.find({
          pattern: params.pattern,
          path: params.path,
          exclude: params.exclude,
          limit: effectiveLimit,
          cwd: ctx.cwd,
          signal,
        }),
        { signal },
      );

      if (outcome.files.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: [
                NO_FILES_FOUND + emptyResultHint(outcome.hasConstraints),
                ...(outcome.candidatesCapped
                  ? ["", candidateCapNotice(MAX_FUZZY_CANDIDATES)]
                  : []),
              ].join("\n"),
            },
          ],
          details: {
            kind: "find",
            query: params.pattern,
            resultCount: 0,
            fileCount: 0,
            truncated: outcome.candidatesCapped,
          } satisfies SearchDetails,
        };
      }

      const body = paginate(
        runtime,
        "find",
        outcome.files,
        FIND_PAGE_LINES,
      );
      const count = outcome.files.length;
      const header = findResultHeader(count);
      const notices = [
        ...(outcome.limitReached
          ? [resultLimitNotice("files", effectiveLimit, MAX_FIND_LIMIT)]
          : []),
        ...(outcome.candidatesCapped
          ? [candidateCapNotice(MAX_FUZZY_CANDIDATES)]
          : []),
      ];
      const text = [header, "", body.text, ...notices.flatMap((notice) => ["", notice])]
        .join("\n");

      return {
        content: [{ type: "text" as const, text }],
        details: {
          kind: "find",
          query: params.pattern,
          resultCount: count,
          fileCount: count,
          truncated: outcome.limitReached || outcome.candidatesCapped || body.hasMore,
        } satisfies SearchDetails,
      };
    },

    renderCall(args: FindInput, theme: Theme) {
      const scope = args.path === undefined
        ? ""
        : theme.fg("muted", ` in ${formatConstraint(args.path)}`);
      const query = args.pattern.trim().length === 0
        ? theme.fg("muted", "(all files)")
        : theme.fg("accent", args.pattern);
      return new Text(
        theme.fg("toolTitle", theme.bold("find ")) + query + scope,
        0,
        0,
      );
    },

    renderResult(result, options, theme, context) {
      return renderSearchResult(result, options, theme, context.isError);
    },
  });
}

function formatConstraint(constraint: string | readonly string[]): string {
  return Array.isArray(constraint) ? constraint.join(", ") : String(constraint);
}

interface SearchRenderOptions {
  readonly expanded: boolean;
  readonly isPartial: boolean;
}

function textResult(result: AgentToolResult<unknown>): string {
  return result.content
    .filter((block): block is { type: "text"; text: string } =>
      block.type === "text"
    )
    .map((block) => block.text)
    .join("\n");
}

function expandedResult(
  summary: string,
  output: string,
  expanded: boolean,
  theme: Theme,
): Text {
  if (!expanded || output.length === 0) return new Text(summary, 0, 0);
  return new Text(
    [summary, theme.fg("toolOutput", output)].join("\n"),
    0,
    0,
  );
}

function renderSearchResult(
  result: AgentToolResult<unknown>,
  options: SearchRenderOptions,
  theme: Theme,
  isError: boolean,
): Text {
  const output = textResult(result);
  if (options.isPartial) {
    return new Text(theme.fg("warning", "searching…"), 0, 0);
  }
  if (isError) {
    const firstLine = output.split("\n").find((line) => line.trim().length > 0) ??
      "search failed";
    return expandedResult(
      theme.fg("error", `✗ ${firstLine}`),
      output,
      options.expanded,
      theme,
    );
  }

  const details = result.details as SearchDetails | undefined;
  if (details?.cursorStatus === "expired") {
    return expandedResult(
      theme.fg("warning", "cursor expired"),
      output,
      options.expanded,
      theme,
    );
  }
  if (details?.cursorStatus === "continued") {
    const more = details.truncated ? theme.fg("warning", " (more available)") : "";
    return expandedResult(
      theme.fg("success", "✓ continued results") + more,
      output,
      options.expanded,
      theme,
    );
  }
  if (details === undefined) {
    return expandedResult(
      theme.fg("success", "✓ search completed"),
      output,
      options.expanded,
      theme,
    );
  }
  if (details.resultCount === 0) {
    return expandedResult(
      theme.fg("muted", "no results"),
      output,
      options.expanded,
      theme,
    );
  }

  const unit = details.kind === "find"
    ? `file${details.resultCount === 1 ? "" : "s"}`
    : `match${details.resultCount === 1 ? "" : "es"}`;
  const scope = details.kind === "find"
    ? ""
    : ` in ${details.fileCount} file${details.fileCount === 1 ? "" : "s"}`;
  const more = details.truncated ? theme.fg("warning", " (truncated)") : "";
  const summary = theme.fg("success", "✓ ") +
    theme.fg("muted", `${details.resultCount} ${unit}${scope}`) +
    more;
  return expandedResult(summary, output, options.expanded, theme);
}
