/** Tool registration for the small grep and find interfaces. */

import {
  DEFAULT_MAX_BYTES,
  type AgentToolResult,
  type ExtensionAPI,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import {
  FIND_PARAMETER_DESCRIPTIONS,
  FIND_PROMPT_SNIPPET,
  FIND_RESULT_LIMIT,
  FIND_TOOL_DESCRIPTION,
  findResultHeader,
  GREP_PARAMETER_DESCRIPTIONS,
  GREP_PROMPT_SNIPPET,
  GREP_RESULT_LIMIT,
  GREP_TOOL_DESCRIPTION,
  grepResultHeader,
  NO_FILES_FOUND,
  NO_GREP_MATCHES,
  outputLimitNotice,
  resultLimitNotice,
} from "./prompt.ts";
import {
  type GrepOutcome,
  runSearch,
  SearchRuntime,
  type SearchRuntimeInstance,
} from "../src/runtime.ts";

export const GrepParams = Type.Object({
  pattern: Type.String({
    minLength: 1,
    description: GREP_PARAMETER_DESCRIPTIONS.pattern,
  }),
  path: Type.Optional(Type.String({ minLength: 1, description: GREP_PARAMETER_DESCRIPTIONS.path })),
  glob: Type.Optional(Type.String({ minLength: 1, description: GREP_PARAMETER_DESCRIPTIONS.glob })),
});

export type GrepInput = Static<typeof GrepParams>;

export const FindParams = Type.Object({
  pattern: Type.String({
    minLength: 1,
    description: FIND_PARAMETER_DESCRIPTIONS.pattern,
  }),
  path: Type.Optional(Type.String({ minLength: 1, description: FIND_PARAMETER_DESCRIPTIONS.path })),
});

export type FindInput = Static<typeof FindParams>;

export interface SearchDetails {
  readonly kind: "grep" | "find";
  readonly query: string;
  readonly resultCount: number;
  readonly fileCount: number;
  readonly truncated: boolean;
}

export function renderGrepLines(outcome: GrepOutcome): string[] {
  return outcome.matches.map((match) => `${match.path}:${match.lineNumber}: ${match.text}`);
}

function countFiles(outcome: GrepOutcome): number {
  return new Set(outcome.matches.map((match) => match.path)).size;
}

interface BoundedBody {
  readonly text: string;
  readonly truncated: boolean;
}

const BODY_MAX_BYTES = DEFAULT_MAX_BYTES - 8 * 1024;

function boundedBody(lines: readonly string[], kind: "grep" | "find"): BoundedBody {
  const body: string[] = [];
  let bytes = 0;
  let consumed = 0;

  for (const line of lines) {
    const separatorBytes = body.length === 0 ? 0 : 1;
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (bytes + separatorBytes + lineBytes > BODY_MAX_BYTES) break;
    body.push(line);
    bytes += separatorBytes + lineBytes;
    consumed += 1;
  }

  if (consumed === lines.length) {
    return { text: body.join("\n"), truncated: false };
  }
  return {
    text: [...body, "", outputLimitNotice(kind)].join("\n"),
    truncated: true,
  };
}

export function registerTools(pi: ExtensionAPI, runtime: SearchRuntimeInstance): void {
  pi.registerTool({
    name: "grep",
    label: "grep",
    description: GREP_TOOL_DESCRIPTION,
    promptSnippet: GREP_PROMPT_SNIPPET,
    parameters: GrepParams,

    async execute(_toolCallId, params: GrepInput, signal, _onUpdate, ctx) {
      const service = runtime.runSync(SearchRuntime);
      const outcome = await runSearch(
        runtime,
        service.grep({
          pattern: params.pattern,
          path: params.path,
          glob: params.glob,
          cwd: ctx.cwd,
          signal,
        }),
        { signal },
      );

      const matchCount = outcome.matches.length;
      if (matchCount === 0) {
        return {
          content: [{ type: "text" as const, text: NO_GREP_MATCHES }],
          details: {
            kind: "grep",
            query: params.pattern,
            resultCount: 0,
            fileCount: 0,
            truncated: false,
          } satisfies SearchDetails,
        };
      }

      const body = boundedBody(renderGrepLines(outcome), "grep");
      const fileCount = countFiles(outcome);
      const notices = outcome.truncated ? [resultLimitNotice("matches", GREP_RESULT_LIMIT)] : [];
      const text = [
        grepResultHeader(matchCount, fileCount),
        "",
        body.text,
        ...notices.flatMap((notice) => ["", notice]),
      ].join("\n");

      return {
        content: [{ type: "text" as const, text }],
        details: {
          kind: "grep",
          query: params.pattern,
          resultCount: matchCount,
          fileCount,
          truncated: outcome.truncated || body.truncated,
        } satisfies SearchDetails,
      };
    },

    renderCall(args: Partial<GrepInput> | undefined, theme: Theme) {
      const pattern =
        typeof args?.pattern === "string" && args.pattern.length > 0
          ? theme.fg("accent", `/${args.pattern}/`)
          : theme.fg("muted", "…");
      const scope = typeof args?.path === "string" ? theme.fg("muted", ` in ${args.path}`) : "";
      const filter = typeof args?.glob === "string" ? theme.fg("muted", ` (${args.glob})`) : "";
      return new Text(theme.fg("toolTitle", theme.bold("grep ")) + pattern + scope + filter, 0, 0);
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
      const outcome = await runSearch(
        runtime,
        service.find({
          pattern: params.pattern,
          path: params.path,
          cwd: ctx.cwd,
          signal,
        }),
        { signal },
      );

      if (outcome.files.length === 0) {
        return {
          content: [{ type: "text" as const, text: NO_FILES_FOUND }],
          details: {
            kind: "find",
            query: params.pattern,
            resultCount: 0,
            fileCount: 0,
            truncated: false,
          } satisfies SearchDetails,
        };
      }

      const body = boundedBody(outcome.files, "find");
      const count = outcome.files.length;
      const notices = outcome.truncated ? [resultLimitNotice("files", FIND_RESULT_LIMIT)] : [];
      const text = [
        findResultHeader(count),
        "",
        body.text,
        ...notices.flatMap((notice) => ["", notice]),
      ].join("\n");

      return {
        content: [{ type: "text" as const, text }],
        details: {
          kind: "find",
          query: params.pattern,
          resultCount: count,
          fileCount: count,
          truncated: outcome.truncated || body.truncated,
        } satisfies SearchDetails,
      };
    },

    renderCall(args: Partial<FindInput> | undefined, theme: Theme) {
      const pattern =
        typeof args?.pattern === "string" && args.pattern.length > 0
          ? theme.fg("accent", args.pattern)
          : theme.fg("muted", "…");
      const scope = typeof args?.path === "string" ? theme.fg("muted", ` in ${args.path}`) : "";
      return new Text(theme.fg("toolTitle", theme.bold("find ")) + pattern + scope, 0, 0);
    },

    renderResult(result, options, theme, context) {
      return renderSearchResult(result, options, theme, context.isError);
    },
  });
}

interface SearchRenderOptions {
  readonly expanded: boolean;
  readonly isPartial: boolean;
}

function textResult(result: AgentToolResult<unknown>): string {
  return result.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function expandedResult(summary: string, output: string, expanded: boolean, theme: Theme): Text {
  if (!expanded || output.length === 0) return new Text(summary, 0, 0);
  return new Text([summary, theme.fg("toolOutput", output)].join("\n"), 0, 0);
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
    const firstLine = output.split("\n").find((line) => line.trim().length > 0) ?? "search failed";
    return expandedResult(theme.fg("error", `✗ ${firstLine}`), output, options.expanded, theme);
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
    return expandedResult(theme.fg("muted", "no results"), output, options.expanded, theme);
  }

  const unit =
    details.kind === "find"
      ? `file${details.resultCount === 1 ? "" : "s"}`
      : `match${details.resultCount === 1 ? "" : "es"}`;
  const scope =
    details.kind === "find"
      ? ""
      : ` in ${details.fileCount} file${details.fileCount === 1 ? "" : "s"}`;
  const more = details.truncated ? theme.fg("warning", " (truncated)") : "";
  const summary =
    theme.fg("success", "✓ ") + theme.fg("muted", `${details.resultCount} ${unit}${scope}`) + more;
  return expandedResult(summary, output, options.expanded, theme);
}
