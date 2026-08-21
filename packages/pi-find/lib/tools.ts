/**
 * Tool registration for grep and find.
 *
 * These deliberately reuse pi's built-in tool names so they override them: the
 * model keeps one obvious way to search and the system prompt does not carry
 * competing search surfaces.
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
  DEFAULT_FIND_LIMIT,
  DEFAULT_GREP_LIMIT,
  emptyResultHint,
  FIND_PARAMETER_DESCRIPTIONS,
  findResultHeader,
  FIND_PROMPT_SNIPPET,
  FIND_TOOL_DESCRIPTION,
  GREP_PARAMETER_DESCRIPTIONS,
  GREP_PROMPT_SNIPPET,
  grepResultHeader,
  GREP_TOOL_DESCRIPTION,
  clampParam,
  looksLikeStringifiedArray,
  MAX_CONTEXT_LINES,
  MAX_FIND_LIMIT,
  MAX_GREP_LIMIT,
  NO_FILES_FOUND,
  NO_GREP_MATCHES,
  resultLimitNotice,
  STRINGIFIED_ARRAY_HINT,
  tooManyResultsNotice,
} from "./prompt.ts";
import {
  type GrepOutcome,
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
  pattern: Type.Union(
    [
      Type.String({ minLength: 1 }),
      Type.Array(Type.String({ minLength: 1 }), {
        minItems: 1,
        maxItems: 64,
      }),
    ],
    { description: GREP_PARAMETER_DESCRIPTIONS.pattern },
  ),
  path: pathConstraint(GREP_PARAMETER_DESCRIPTIONS.path),
  exclude: pathConstraint(GREP_PARAMETER_DESCRIPTIONS.exclude),
  caseSensitive: Type.Optional(
    Type.Boolean({ description: GREP_PARAMETER_DESCRIPTIONS.caseSensitive }),
  ),
  context: Type.Optional(
    Type.Integer({ description: GREP_PARAMETER_DESCRIPTIONS.context }),
  ),
  limit: Type.Optional(
    Type.Integer({ description: GREP_PARAMETER_DESCRIPTIONS.limit }),
  ),
});

export type GrepInput = Static<typeof GrepParams>;

export const FindParams = Type.Object({
  pattern: Type.String({ description: FIND_PARAMETER_DESCRIPTIONS.pattern }),
  path: pathConstraint(FIND_PARAMETER_DESCRIPTIONS.path),
  exclude: pathConstraint(FIND_PARAMETER_DESCRIPTIONS.exclude),
  limit: Type.Optional(
    Type.Integer({ description: FIND_PARAMETER_DESCRIPTIONS.limit }),
  ),
});

export type FindInput = Static<typeof FindParams>;

export interface SearchDetails {
  readonly kind: "grep" | "find";
  readonly query: string;
  readonly resultCount: number;
  readonly fileCount: number;
  readonly truncated: boolean;
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

/** Emit one byte- and line-bounded page. */
function paginate(
  lines: readonly string[],
  pageSize: number,
  kind: "grep" | "find",
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

  return {
    text: [
      ...page,
      "",
      tooManyResultsNotice(page.length, lines.length, kind),
    ].join("\n"),
    hasMore: true,
  };
}

/** Line budget per page; byte bounding above remains authoritative. */
const GREP_PAGE_LINES = 120;
const FIND_PAGE_LINES = 60;

export function registerTools(
  pi: ExtensionAPI,
  runtime: SearchRuntimeInstance,
): void {
  pi.registerTool({
    name: "grep",
    label: "grep",
    description: GREP_TOOL_DESCRIPTION,
    promptSnippet: GREP_PROMPT_SNIPPET,
    parameters: GrepParams,

    async execute(_toolCallId, params: GrepInput, signal, _onUpdate, ctx) {
      const patterns = Array.isArray(params.pattern)
        ? params.pattern
        : [params.pattern];
      const literalOnly = Array.isArray(params.pattern);
      const query = patterns.join(", ");

      const service = runtime.runSync(SearchRuntime);
      const limitParam = clampParam(
        "limit",
        params.limit ?? DEFAULT_GREP_LIMIT,
        1,
        MAX_GREP_LIMIT,
      );
      const contextParam = clampParam(
        "context",
        params.context ?? 0,
        0,
        MAX_CONTEXT_LINES,
      );
      const outcome = await runSearch(
        runtime,
        service.grep({
          patterns,
          literalOnly,
          path: params.path,
          exclude: params.exclude,
          caseSensitive: params.caseSensitive,
          context: contextParam.value,
          limit: limitParam.value,
          cwd: ctx.cwd,
          signal,
        }),
        { signal },
      );
      const clampNotices = [limitParam.notice, contextParam.notice].filter(
        (notice) => notice !== "",
      );

      // A stringified pattern array parses as a permissive character class
      // that matches nearly every line, so the telltale noise appears on the
      // match path, not the empty path. The schema stays strict — the pattern
      // runs as written — and this notice rides along with whatever comes
      // back so the model can resend a real array on its next call.
      const stringifiedNotice =
        !Array.isArray(params.pattern) &&
        patterns.length === 1 &&
        looksLikeStringifiedArray(patterns[0]!)
          ? STRINGIFIED_ARRAY_HINT
          : "";

      const matchCount = outcome.matches.filter((m) => m.isMatch).length;
      if (matchCount === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: [
                NO_GREP_MATCHES +
                  emptyResultHint(outcome.hasConstraints) +
                  stringifiedNotice,
                ...clampNotices,
              ].join("\n"),
            },
          ],
          details: {
            kind: "grep",
            query,
            resultCount: 0,
            fileCount: 0,
            truncated: false,
          } satisfies SearchDetails,
        };
      }

      const rendered = renderGrepLines(outcome);
      const body = paginate(rendered, GREP_PAGE_LINES, "grep");
      const fileCount = countFiles(outcome);
      const header = grepResultHeader(matchCount, fileCount);
      const notices = outcome.truncated
        ? [resultLimitNotice("matches", limitParam.value, MAX_GREP_LIMIT)]
        : [];
      if (stringifiedNotice !== "") notices.push(stringifiedNotice);
      notices.push(...clampNotices);
      const text = [header, "", body.text, ...notices.flatMap((notice) => ["", notice])]
        .join("\n");

      return {
        content: [{ type: "text" as const, text }],
        details: {
          kind: "grep",
          query,
          resultCount: matchCount,
          fileCount,
          truncated: outcome.truncated || body.hasMore,
        } satisfies SearchDetails,
      };
    },

    renderCall(args: Partial<GrepInput> | undefined, theme: Theme) {
      const pathArg = args?.path;
      const scope = pathArg === undefined
        ? ""
        : theme.fg("muted", ` in ${formatConstraint(pathArg)}`);
      const rawPattern = args?.pattern;
      const patterns = Array.isArray(rawPattern)
        ? rawPattern.filter((p): p is string => typeof p === "string" && p.length > 0)
        : typeof rawPattern === "string" && rawPattern.length > 0
        ? [rawPattern]
        : [];
      const shown = patterns.length > 0
        ? patterns.slice(0, 3).map((p) => `"${p}"`).join(", ")
        : theme.fg("muted", "…");
      const more = patterns.length > 3
        ? theme.fg("muted", ` +${patterns.length - 3} more`)
        : "";
      return new Text(
        theme.fg("toolTitle", theme.bold("grep ")) +
          (patterns.length > 0 ? theme.fg("accent", shown) : shown) +
          more +
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
    name: "find",
    label: "find",
    description: FIND_TOOL_DESCRIPTION,
    promptSnippet: FIND_PROMPT_SNIPPET,
    parameters: FindParams,

    async execute(_toolCallId, params: FindInput, signal, _onUpdate, ctx) {
      const service = runtime.runSync(SearchRuntime);
      const limitParam = clampParam(
        "limit",
        params.limit ?? DEFAULT_FIND_LIMIT,
        1,
        MAX_FIND_LIMIT,
      );
      const effectiveLimit = limitParam.value;
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
              text: NO_FILES_FOUND + emptyResultHint(outcome.hasConstraints),
            },
          ],
          details: {
            kind: "find",
            query: params.pattern,
            resultCount: 0,
            fileCount: 0,
            truncated: false,
          } satisfies SearchDetails,
        };
      }

      const body = paginate(outcome.files, FIND_PAGE_LINES, "find");
      const count = outcome.files.length;
      const header = findResultHeader(count);
      const notices = outcome.limitReached
        ? [resultLimitNotice("files", effectiveLimit, MAX_FIND_LIMIT)]
        : [];
      if (limitParam.notice !== "") notices.push(limitParam.notice);
      const text = [header, "", body.text, ...notices.flatMap((notice) => ["", notice])]
        .join("\n");

      return {
        content: [{ type: "text" as const, text }],
        details: {
          kind: "find",
          query: params.pattern,
          resultCount: count,
          fileCount: count,
          truncated: outcome.limitReached || body.hasMore,
        } satisfies SearchDetails,
      };
    },

    renderCall(args: Partial<FindInput> | undefined, theme: Theme) {
      const pathArg = args?.path;
      const scope = pathArg === undefined
        ? ""
        : theme.fg("muted", ` in ${formatConstraint(pathArg)}`);
      const rawPattern = typeof args?.pattern === "string" ? args.pattern.trim() : "";
      const query = rawPattern.length === 0
        ? theme.fg("muted", "(all files)")
        : theme.fg("accent", rawPattern);
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
