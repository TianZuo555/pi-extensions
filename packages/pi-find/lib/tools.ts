/** Tool registration for the small grep and find interfaces. */

import { StringEnum } from "@earendil-works/pi-ai";
import type { AgentToolResult, ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import {
  AUTO_CONTEXT_NOTICE,
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
  NO_FILES_FOUND,
  NO_GREP_MATCHES,
  outputLimitNotice,
  oversizedRecordNotice,
  QUOTED_PATH_NOTICE,
  resultLimitNotice,
  SEARCH_TIMEOUT_MS,
  searchTimeoutNotice,
  SLASH_GLOB_NOTICE,
  globPrefixNotice,
  unreadablePathNotice,
} from "./prompt.ts";
import {
  basenamePrefilter,
  isExplicitHiddenPath,
  runSearch,
  SearchRuntime,
  type SearchRuntimeInstance,
} from "../src/runtime.ts";
import { MAX_RECORD_BYTES } from "../src/stream.ts";
import { type Notice, type NoticeId, withSearchLog } from "./debug.ts";
import { boundedBody, fileRows, grepRows, resultText } from "./results.ts";

const notice = (id: NoticeId, text: string): Notice => ({ id, text });
const texts = (notices: readonly Notice[]) => notices.map((entry) => entry.text);
const ids = (notices: readonly Notice[]) => notices.map((entry) => entry.id);

/**
 * Explain an empty result caused by a slash glob. Only fires when the glob
 * actually rejected candidates under an explicit, non-cwd path; when the glob
 * repeats that path as a prefix, offer the corrected glob instead of the rule.
 */
function slashGlobNotices(
  glob: string | undefined,
  searchPath: string | undefined,
  rejected: number,
): Notice[] {
  if (glob === undefined || searchPath === undefined || rejected === 0 || !glob.includes("/"))
    return [];
  const base = searchPath
    .replace(/^@/, "")
    .replaceAll("\\", "/")
    .replace(/^(\.\/)+/, "")
    .replace(/\/+$/, "");
  if (base === "" || base === ".") return [];
  const negation = glob.startsWith("!") ? "!" : "";
  const body = glob.slice(negation.length).replace(/^(\.\/)+/, "");
  if (body.startsWith(`${base}/`) && body.length > base.length + 1) {
    const suggestion = `${negation}${body.slice(base.length + 1)}`;
    return [notice("glob_prefix", globPrefixNotice(glob, searchPath, suggestion))];
  }
  return [notice("slash_glob", SLASH_GLOB_NOTICE)];
}

/** Hidden paths are only skipped during default traversal, never when named. */
function hiddenPathNotices(searchPath: string | undefined, explicitFile: boolean): Notice[] {
  return explicitFile || isExplicitHiddenPath(searchPath?.replace(/^@/, ""))
    ? []
    : [notice("hidden_path", HIDDEN_PATH_NOTICE)];
}

function unreadableNotices(pathError: string | undefined): Notice[] {
  return pathError === undefined
    ? []
    : [notice("unreadable_path", unreadablePathNotice(pathError))];
}

export const GrepParams = Type.Object({
  pattern: Type.String({ minLength: 1, description: GREP_PARAMETER_DESCRIPTIONS.pattern }),
  path: Type.Optional(Type.String({ minLength: 1, description: GREP_PARAMETER_DESCRIPTIONS.path })),
  glob: Type.Optional(Type.String({ minLength: 1, description: GREP_PARAMETER_DESCRIPTIONS.glob })),
  output: Type.Optional(
    StringEnum(["content", "files"] as const, { description: GREP_PARAMETER_DESCRIPTIONS.output }),
  ),
  literal: Type.Optional(Type.Boolean({ description: GREP_PARAMETER_DESCRIPTIONS.literal })),
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
  /** Some paths could not be read, so the result may be incomplete. */
  readonly unreadable?: boolean;
}

export function registerTools(pi: ExtensionAPI, runtime: SearchRuntimeInstance): void {
  pi.registerTool({
    name: "grep",
    label: "grep",
    description: GREP_TOOL_DESCRIPTION,
    promptSnippet: GREP_PROMPT_SNIPPET,
    parameters: GrepParams,

    execute(toolCallId, params: GrepInput, signal, _onUpdate, ctx) {
      return withSearchLog({ tool: "grep", toolCallId, params, ctx }, async () => {
        const service = runtime.runSync(SearchRuntime);
        const outcome = await runSearch(
          runtime,
          service.grep({ ...params, cwd: ctx.cwd, signal }),
          { signal },
        );
        const filesOnly = outcome.output === "files";
        let body = boundedBody(filesOnly ? fileRows(outcome.files) : grepRows(outcome));
        const droppedContext = body.truncated && outcome.context.length > 0;
        // Context is enrichment and must never crowd out the actual matches.
        if (droppedContext) body = boundedBody(grepRows({ ...outcome, context: [] }));
        const truncated = outcome.truncated || body.truncated || outcome.skippedRecords > 0;
        const unreadable = outcome.pathError !== undefined;
        const partial = truncated || outcome.timedOut || unreadable;
        const notices: Notice[] = [
          ...(body.quotedPaths ? [notice("quoted_path", QUOTED_PATH_NOTICE)] : []),
          ...unreadableNotices(outcome.pathError),
          ...(outcome.truncated
            ? [
                notice(
                  "result_limit",
                  resultLimitNotice(
                    filesOnly ? "files" : "matches",
                    filesOnly ? GREP_FILE_LIMIT : GREP_RESULT_LIMIT,
                  ),
                ),
              ]
            : []),
          ...(body.truncated
            ? [notice("output_limit", outputLimitNotice(filesOnly ? "find" : "grep"))]
            : []),
          ...(outcome.skippedRecords > 0
            ? [notice("oversized_record", oversizedRecordNotice(MAX_RECORD_BYTES))]
            : []),
          ...(outcome.timedOut ? [notice("timeout", searchTimeoutNotice(SEARCH_TIMEOUT_MS))] : []),
          ...(!droppedContext && outcome.context.length > 0
            ? [notice("auto_context", AUTO_CONTEXT_NOTICE)]
            : []),
          ...(body.resultCount === 0 && !partial
            ? [
                ...(outcome.explicitFile
                  ? []
                  : [notice("file_size_limit", FILE_SIZE_LIMIT_NOTICE)]),
                ...hiddenPathNotices(params.path, outcome.explicitFile),
                ...slashGlobNotices(params.glob, params.path, outcome.rejectedByGlob),
              ]
            : []),
        ];
        const header =
          body.resultCount === 0 && !partial
            ? filesOnly
              ? NO_FILES_FOUND
              : NO_GREP_MATCHES
            : filesOnly
              ? findResultHeader(body.resultCount, partial)
              : grepResultHeader(body.resultCount, body.fileCount, partial);
        const text = resultText(header, body.text, texts(notices));
        return {
          result: {
            content: [{ type: "text" as const, text }],
            details: {
              kind: "grep",
              output: outcome.output,
              query: params.pattern,
              resultCount: body.resultCount,
              fileCount: body.fileCount,
              truncated,
              timedOut: outcome.timedOut,
              unreadable,
            } satisfies SearchDetails,
          },
          stats: {
            resultCount: body.resultCount,
            collectedCount: filesOnly ? outcome.files.length : outcome.matches.length,
            fileCount: body.fileCount,
            resultLimitHit: outcome.truncated,
            outputLimitHit: body.truncated,
            timedOut: outcome.timedOut,
            skippedRecords: outcome.skippedRecords,
            rejectedByGlob: outcome.rejectedByGlob,
            prefilter: basenamePrefilter(params.glob),
            outputBytes: Buffer.byteLength(text, "utf8"),
            pathError: outcome.pathError,
            explicitFile: outcome.explicitFile,
            clippedLines: outcome.clippedLines,
            searchedFiles: outcome.searched?.searchedFiles,
            searchedBytes: outcome.searched?.searchedBytes,
            contextLines: droppedContext ? 0 : outcome.context.length,
            droppedContext,
            notices: ids(notices),
          },
        };
      });
    },

    renderCall(args: Partial<GrepInput> | undefined, theme: Theme) {
      const pattern =
        typeof args?.pattern === "string" && args.pattern.length > 0
          ? theme.fg("accent", args.literal ? JSON.stringify(args.pattern) : `/${args.pattern}/`)
          : theme.fg("muted", "…");
      const scope = typeof args?.path === "string" ? theme.fg("muted", ` in ${args.path}`) : "";
      const filter = typeof args?.glob === "string" ? theme.fg("muted", ` (${args.glob})`) : "";
      const mode = args?.output === "files" ? theme.fg("muted", " [files]") : "";
      return new Text(
        theme.fg("toolTitle", theme.bold("grep ")) + pattern + scope + filter + mode,
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

    execute(toolCallId, params: FindInput, signal, _onUpdate, ctx) {
      return withSearchLog({ tool: "find", toolCallId, params, ctx }, async () => {
        const service = runtime.runSync(SearchRuntime);
        const outcome = await runSearch(
          runtime,
          service.find({ ...params, cwd: ctx.cwd, signal }),
          { signal },
        );
        const body = boundedBody(fileRows(outcome.files));
        const count = body.resultCount;
        const truncated = outcome.truncated || body.truncated || outcome.skippedRecords > 0;
        const unreadable = outcome.pathError !== undefined;
        const partial = truncated || outcome.timedOut || unreadable;
        const notices: Notice[] = [
          ...(outcome.skippedRecords > 0
            ? [notice("oversized_record", oversizedRecordNotice(MAX_RECORD_BYTES))]
            : []),
          ...(body.quotedPaths ? [notice("quoted_path", QUOTED_PATH_NOTICE)] : []),
          ...unreadableNotices(outcome.pathError),
          ...(outcome.truncated
            ? [notice("result_limit", resultLimitNotice("files", FIND_RESULT_LIMIT))]
            : []),
          ...(body.truncated ? [notice("output_limit", outputLimitNotice("find"))] : []),
          ...(outcome.timedOut ? [notice("timeout", searchTimeoutNotice(SEARCH_TIMEOUT_MS))] : []),
          ...(count === 0 && !partial
            ? [
                ...hiddenPathNotices(params.path, false),
                ...slashGlobNotices(params.pattern, params.path, outcome.rejectedByGlob),
              ]
            : []),
        ];
        const header = count === 0 && !partial ? NO_FILES_FOUND : findResultHeader(count, partial);
        const text = resultText(header, body.text, texts(notices));
        return {
          result: {
            content: [{ type: "text" as const, text }],
            details: {
              kind: "find",
              query: params.pattern,
              resultCount: count,
              fileCount: body.fileCount,
              truncated,
              timedOut: outcome.timedOut,
              unreadable,
            } satisfies SearchDetails,
          },
          stats: {
            resultCount: count,
            collectedCount: outcome.files.length,
            fileCount: body.fileCount,
            resultLimitHit: outcome.truncated,
            outputLimitHit: body.truncated,
            timedOut: outcome.timedOut,
            skippedRecords: outcome.skippedRecords,
            rejectedByGlob: outcome.rejectedByGlob,
            prefilter: basenamePrefilter(params.pattern),
            outputBytes: Buffer.byteLength(text, "utf8"),
            pathError: outcome.pathError,
            notices: ids(notices),
          },
        };
      });
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
  if (options.isPartial) return new Text(theme.fg("warning", "searching…"), 0, 0);
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
    const summary = details.timedOut
      ? theme.fg("warning", "search timed out (no results gathered)")
      : details.truncated
        ? theme.fg("warning", "no results shown (truncated)")
        : details.unreadable
          ? theme.fg("warning", "no results (some paths unreadable)")
          : theme.fg("muted", "no results");
    return expandedResult(summary, output, options.expanded, theme);
  }

  const filesOnly = details.kind === "find" || details.output === "files";
  const unit = filesOnly
    ? `file${details.resultCount === 1 ? "" : "s"}`
    : `match${details.resultCount === 1 ? "" : "es"}`;
  const scope = filesOnly
    ? ""
    : ` in ${details.fileCount} file${details.fileCount === 1 ? "" : "s"}`;
  const more =
    (details.truncated ? theme.fg("warning", " (truncated)") : "") +
    (details.timedOut ? theme.fg("warning", " (timed out)") : "") +
    (details.unreadable ? theme.fg("warning", " (some paths unreadable)") : "");
  const summary =
    theme.fg("success", "✓ ") + theme.fg("muted", `${details.resultCount} ${unit}${scope}`) + more;
  return expandedResult(summary, output, options.expanded, theme);
}
