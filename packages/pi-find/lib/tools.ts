/** Tool registration for the small grep and find interfaces. */

import { StringEnum } from "@earendil-works/pi-ai";
import type { AgentToolResult, ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import {
  AUTO_CONTEXT_NOTICE,
  CONTEXT_OMITTED_NOTICE,
  FILE_SIZE_LIMIT_NOTICE,
  FIND_PARAMETER_DESCRIPTIONS,
  FIND_PROMPT_SNIPPET,
  FIND_RESULT_LIMIT,
  FIND_TOOL_DESCRIPTION,
  findResultHeader,
  GREP_FILE_LIMIT,
  GREP_PARAMETER_DESCRIPTIONS,
  GREP_PROMPT_SNIPPET,
  GREP_RESULT_LIMIT,
  GREP_TOOL_DESCRIPTION,
  grepResultHeader,
  HIDDEN_PATH_NOTICE,
  MAX_CONTEXT_LINES,
  NO_FILES_FOUND,
  NO_GREP_MATCHES,
  outputLimitNotice,
  oversizedRecordNotice,
  QUOTED_PATH_NOTICE,
  resultLimitNotice,
  SEARCH_TIMEOUT_MS,
  searchTimeoutNotice,
} from "./prompt.ts";
import { runSearch, SearchRuntime, type SearchRuntimeInstance } from "../src/runtime.ts";
import { MAX_RECORD_BYTES } from "../src/stream.ts";
import { boundedBody, fileRows, grepRows, resultText } from "./results.ts";

export const GrepParams = Type.Object({
  pattern: Type.String({ minLength: 1, description: GREP_PARAMETER_DESCRIPTIONS.pattern }),
  path: Type.Optional(Type.String({ minLength: 1, description: GREP_PARAMETER_DESCRIPTIONS.path })),
  glob: Type.Optional(Type.String({ minLength: 1, description: GREP_PARAMETER_DESCRIPTIONS.glob })),
  output: Type.Optional(StringEnum(["content", "files"], { description: GREP_PARAMETER_DESCRIPTIONS.output })),
  literal: Type.Optional(Type.Boolean({ description: GREP_PARAMETER_DESCRIPTIONS.literal })),
  context: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_CONTEXT_LINES, description: GREP_PARAMETER_DESCRIPTIONS.context })),
});

export type GrepInput = Static<typeof GrepParams>;

export const FindParams = Type.Object({
  pattern: Type.String({ minLength: 1, description: FIND_PARAMETER_DESCRIPTIONS.pattern }),
  path: Type.Optional(Type.String({ minLength: 1, description: FIND_PARAMETER_DESCRIPTIONS.path })),
});

export type FindInput = Static<typeof FindParams>;

export interface SearchDetails {
  readonly kind: "grep" | "find";
  readonly output?: "content" | "files";
  readonly query: string;
  readonly resultCount: number;
  readonly fileCount: number;
  readonly truncated: boolean;
  readonly timedOut: boolean;
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
        service.grep({ ...params, cwd: ctx.cwd, signal }),
        { signal },
      );
      const filesOnly = outcome.output === "files";
      let body = boundedBody(filesOnly ? fileRows(outcome.files) : grepRows(outcome));
      const droppedContext = body.truncated && outcome.context.length > 0;
      // Context must never crowd out the actual matches. Automatic context is
      // optional; an explicit request that cannot fit gets an omission notice.
      if (droppedContext) body = boundedBody(grepRows({ ...outcome, context: [] }));
      const contextOmitted = droppedContext && params.context !== undefined;
      const truncated = outcome.truncated || body.truncated || contextOmitted || outcome.skippedRecords > 0;
      const partial = truncated || outcome.timedOut;
      const notices = [
        ...(body.quotedPaths ? [QUOTED_PATH_NOTICE] : []),
        ...(outcome.truncated ? [resultLimitNotice(filesOnly ? "files" : "matches", filesOnly ? GREP_FILE_LIMIT : GREP_RESULT_LIMIT)] : []),
        ...(body.truncated ? [outputLimitNotice(filesOnly ? "find" : "grep")] : []),
        ...(contextOmitted ? [CONTEXT_OMITTED_NOTICE] : []),
        ...(outcome.skippedRecords > 0 ? [oversizedRecordNotice(MAX_RECORD_BYTES)] : []),
        ...(outcome.timedOut ? [searchTimeoutNotice(SEARCH_TIMEOUT_MS)] : []),
        ...(!droppedContext && params.context === undefined && outcome.context.length > 0 ? [AUTO_CONTEXT_NOTICE] : []),
        ...(body.resultCount === 0 && !partial ? [FILE_SIZE_LIMIT_NOTICE, HIDDEN_PATH_NOTICE] : []),
      ];
      const header = body.resultCount === 0 && !partial
        ? NO_GREP_MATCHES
        : filesOnly ? findResultHeader(body.resultCount, partial)
        : grepResultHeader(body.resultCount, body.fileCount, partial);
      return {
        content: [{ type: "text" as const, text: resultText(header, body.text, notices) }],
        details: {
          kind: "grep",
          output: outcome.output,
          query: params.pattern,
          resultCount: body.resultCount,
          fileCount: body.fileCount,
          truncated,
          timedOut: outcome.timedOut,
        } satisfies SearchDetails,
      };
    },

    renderCall(args: Partial<GrepInput> | undefined, theme: Theme) {
      const pattern = typeof args?.pattern === "string" && args.pattern.length > 0
        ? theme.fg("accent", args.literal ? JSON.stringify(args.pattern) : `/${args.pattern}/`)
        : theme.fg("muted", "…");
      const scope = typeof args?.path === "string" ? theme.fg("muted", ` in ${args.path}`) : "";
      const filter = typeof args?.glob === "string" ? theme.fg("muted", ` (${args.glob})`) : "";
      const mode = args?.output === "files" ? theme.fg("muted", " [files]") : "";
      const context = typeof args?.context === "number" ? theme.fg("muted", ` [context: ${args.context}]`) : "";
      return new Text(theme.fg("toolTitle", theme.bold("grep ")) + pattern + scope + filter + mode + context, 0, 0);
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
        service.find({ ...params, cwd: ctx.cwd, signal }),
        { signal },
      );
      const body = boundedBody(fileRows(outcome.files));
      const count = body.resultCount;
      const truncated = outcome.truncated || body.truncated || outcome.skippedRecords > 0;
      const partial = truncated || outcome.timedOut;
      const notices = [
        ...(outcome.skippedRecords > 0 ? [oversizedRecordNotice(MAX_RECORD_BYTES)] : []),
        ...(body.quotedPaths ? [QUOTED_PATH_NOTICE] : []),
        ...(outcome.truncated ? [resultLimitNotice("files", FIND_RESULT_LIMIT)] : []),
        ...(body.truncated ? [outputLimitNotice("find")] : []),
        ...(outcome.timedOut ? [searchTimeoutNotice(SEARCH_TIMEOUT_MS)] : []),
        ...(count === 0 && !partial ? [HIDDEN_PATH_NOTICE] : []),
      ];
      const header = count === 0 && !partial ? NO_FILES_FOUND : findResultHeader(count, partial);
      return {
        content: [{ type: "text" as const, text: resultText(header, body.text, notices) }],
        details: {
          kind: "find",
          query: params.pattern,
          resultCount: count,
          fileCount: body.fileCount,
          truncated,
          timedOut: outcome.timedOut,
        } satisfies SearchDetails,
      };
    },

    renderCall(args: Partial<FindInput> | undefined, theme: Theme) {
      const pattern = typeof args?.pattern === "string" && args.pattern.length > 0
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
  if (options.isPartial) return new Text(theme.fg("warning", "searching…"), 0, 0);
  if (isError) {
    const firstLine = output.split("\n").find((line) => line.trim().length > 0) ?? "search failed";
    return expandedResult(theme.fg("error", `✗ ${firstLine}`), output, options.expanded, theme);
  }

  const details = result.details as SearchDetails | undefined;
  if (details === undefined) {
    return expandedResult(theme.fg("success", "✓ search completed"), output, options.expanded, theme);
  }
  if (details.resultCount === 0) {
    const summary = details.timedOut
      ? theme.fg("warning", "search timed out (no results gathered)")
      : details.truncated
        ? theme.fg("warning", "no results shown (truncated)")
        : theme.fg("muted", "no results");
    return expandedResult(summary, output, options.expanded, theme);
  }

  const filesOnly = details.kind === "find" || details.output === "files";
  const unit = filesOnly
    ? `file${details.resultCount === 1 ? "" : "s"}`
    : `match${details.resultCount === 1 ? "" : "es"}`;
  const scope = filesOnly ? "" : ` in ${details.fileCount} file${details.fileCount === 1 ? "" : "s"}`;
  const more =
    (details.truncated ? theme.fg("warning", " (truncated)") : "") +
    (details.timedOut ? theme.fg("warning", " (timed out)") : "");
  const summary = theme.fg("success", "✓ ") + theme.fg("muted", `${details.resultCount} ${unit}${scope}`) + more;
  return expandedResult(summary, output, options.expanded, theme);
}
