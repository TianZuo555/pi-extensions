/**
 * Pure mapping from ACP session/update payloads to DevinActivity items the
 * provider drains. Kept separate so it is directly unit-testable.
 */

import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { DevinConfigOption } from "../lib/acp-client.ts";
import { mergeDevinTool } from "../lib/tool-content.ts";
import type { DevinActivity, DevinResponseDimension, DevinUsage } from "./turn.ts";

function metaNumber(update: { _meta?: unknown }, key: string): number | undefined {
  const meta = update._meta;
  if (typeof meta !== "object" || meta === null) return undefined;
  const value = (meta as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * `responseDimensions` arrive in two serializations: agent_stopped/turn_stats
 * use `{groupTitle, label, kind: {type, value, …}}` while usage_update's
 * _meta uses `{group_title, kind: {CumulativeMetric: {label, value, …}}}`
 * (internally tagged, snake_case fields). Normalize both to the former.
 */
function normalizeDimension(raw: unknown): DevinResponseDimension | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  const groupTitle =
    typeof record.groupTitle === "string"
      ? record.groupTitle
      : typeof record.group_title === "string"
        ? record.group_title
        : undefined;
  const uid = typeof record.uid === "string" ? record.uid : undefined;
  const kind = record.kind;
  if (typeof kind !== "object" || kind === null) return undefined;
  const k = kind as Record<string, unknown>;

  const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

  if ("type" in k || "value" in k) {
    return {
      uid,
      groupTitle,
      label: str(record.label),
      kind: {
        type: str(k.type),
        value: k.value,
        prefix: str(k.prefix),
        tail: str(k.tail),
        pluralTail: str(k.pluralTail) ?? str(k.plural_tail),
      },
    };
  }
  // Internally tagged variant: {CumulativeMetric: {…}} — first entry wins.
  const entry = Object.entries(k)[0];
  if (!entry) return undefined;
  const [variant, payload] = entry;
  if (typeof payload !== "object" || payload === null) return undefined;
  const inner = payload as Record<string, unknown>;
  return {
    uid,
    groupTitle,
    label: str(inner.label) ?? str(record.label),
    kind: {
      type: variant.charAt(0).toLowerCase() + variant.slice(1),
      value: inner.value ?? inner.code,
      prefix: str(inner.prefix),
      tail: str(inner.tail),
      pluralTail: str(inner.plural_tail) ?? str(inner.pluralTail),
    },
  };
}

function toDimensions(value: unknown): DevinResponseDimension[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const dims = value
    .map(normalizeDimension)
    .filter((d): d is DevinResponseDimension => d !== undefined);
  return dims.length ? dims : undefined;
}

function metaDimensions(
  update: { _meta?: unknown },
  key: string,
): DevinResponseDimension[] | undefined {
  const meta = update._meta;
  if (typeof meta !== "object" || meta === null) return undefined;
  return toDimensions((meta as Record<string, unknown>)[key]);
}

function metaCost(update: {
  _meta?: unknown;
  cost?: unknown;
}): { amount: number; currency: string } | undefined {
  const cost = update.cost;
  if (typeof cost !== "object" || cost === null) return undefined;
  const amount = (cost as { amount?: unknown }).amount;
  if (typeof amount !== "number" || !Number.isFinite(amount)) return undefined;
  const currency = (cost as { currency?: unknown }).currency;
  return { amount, currency: typeof currency === "string" ? currency : "USD" };
}

function textOf(update: { content?: unknown }): string | undefined {
  const content = update.content;
  if (
    typeof content === "object" &&
    content !== null &&
    (content as { type?: string }).type === "text"
  ) {
    return (content as { text?: string }).text;
  }
  return undefined;
}

function messageIdOf(update: { messageId?: unknown }): string | undefined {
  return typeof update.messageId === "string" ? update.messageId : undefined;
}

export function acpUpdateToActivities(update: SessionUpdate): DevinActivity[] {
  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      const delta = textOf(update);
      if (!delta) return [];
      return [{ type: "text", delta, messageId: messageIdOf(update) }];
    }
    case "agent_thought_chunk": {
      const delta = textOf(update);
      if (!delta) return [];
      return [{ type: "thought", delta, messageId: messageIdOf(update) }];
    }
    case "tool_call":
      return [{ type: "tool_start", view: mergeDevinTool(update, undefined) }];
    case "tool_call_update":
      return [{ type: "tool_update", view: mergeDevinTool(undefined, update) }];
    case "plan": {
      const entries = Array.isArray(update.entries) ? update.entries : [];
      return [
        {
          type: "plan",
          entries: entries.map((entry) => ({
            content: String(entry.content ?? ""),
            status: typeof entry.status === "string" ? entry.status : undefined,
          })),
        },
      ];
    }
    case "usage_update": {
      const usage: DevinUsage = {
        contextUsed: typeof update.used === "number" ? update.used : undefined,
        // The loadStats replay reports size: 0 until the model's window syncs.
        contextSize: typeof update.size === "number" && update.size > 0 ? update.size : undefined,
        inputTokens: metaNumber(update, "cognition.ai/inputTokens"),
        outputTokens: metaNumber(update, "cognition.ai/outputTokens"),
        cachedReadTokens: metaNumber(update, "cognition.ai/cachedReadTokens"),
        cachedWriteTokens: metaNumber(update, "cognition.ai/cachedWriteTokens"),
        totalCreditCost: metaNumber(update, "cognition.ai/totalCreditCost"),
        totalAcuCost: metaNumber(update, "cognition.ai/totalAcuCost"),
        cost: metaCost(update),
        dimensions: metaDimensions(update, "cognition.ai/responseDimensions"),
      };
      return [{ type: "usage", usage }];
    }
    case "current_mode_update":
      return [{ type: "mode", modeId: update.currentModeId }];
    case "config_option_update":
      return [{ type: "config", options: (update.configOptions ?? []) as DevinConfigOption[] }];
    case "session_info_update":
      return update.title ? [{ type: "title", title: update.title }] : [];
    case "available_commands_update": {
      const commands = Array.isArray(update.availableCommands) ? update.availableCommands : [];
      return [
        {
          type: "commands",
          commands: commands.map((command) => ({
            name: String(command.name ?? ""),
            description: typeof command.description === "string" ? command.description : undefined,
            hint:
              typeof command.input === "object" && command.input !== null
                ? ((command.input as { hint?: string }).hint ?? undefined)
                : undefined,
          })),
        },
      ];
    }
    case "compaction_update":
      return [{ type: "compaction" }];
    default:
      return [];
  }
}

/** Cognition `_cognition.ai/agent_stopped` params → stats activity. */
export function agentStoppedToActivity(params: unknown): DevinActivity | undefined {
  if (typeof params !== "object" || params === null) return undefined;
  const record = params as Record<string, unknown>;
  const stats = (record.stats ?? {}) as Record<string, unknown>;
  const num = (key: string): number | undefined =>
    typeof stats[key] === "number" && Number.isFinite(stats[key])
      ? (stats[key] as number)
      : undefined;
  return {
    type: "stopped",
    stats: {
      toolCalls: num("toolCalls"),
      filesChanged: num("filesChanged"),
      commandsRun: num("commandsRun"),
      inputTokens: num("inputTokens"),
      outputTokens: num("outputTokens"),
      ttftMs: num("ttftMs"),
      tokensPerSec: num("tokensPerSec"),
      totalTimeMs: num("totalTimeMs"),
      modelLabel: typeof stats.modelLabel === "string" ? stats.modelLabel : undefined,
      creditCost: num("creditCost"),
      acuCost: num("acuCost"),
      dimensions: toDimensions(stats.responseDimensions),
    },
  };
}

/** `_cognition.ai/connection_retry` params → retry activity. */
export function connectionRetryToActivity(params: unknown): DevinActivity | undefined {
  if (typeof params !== "object" || params === null) return undefined;
  const record = params as Record<string, unknown>;
  const attempt = record.attempt;
  if (typeof attempt !== "number" || !Number.isFinite(attempt)) return undefined;
  const maxAttempts = record.maxAttempts;
  return {
    type: "retry",
    attempt,
    maxAttempts:
      typeof maxAttempts === "number" && Number.isFinite(maxAttempts) ? maxAttempts : undefined,
    isStreamRetry: typeof record.isStreamRetry === "boolean" ? record.isStreamRetry : undefined,
  };
}

/** `_cognition.ai/turn_stats` params → last turn's response dimensions. */
export function turnStatsToDimensions(params: unknown): DevinResponseDimension[] | undefined {
  if (typeof params !== "object" || params === null) return undefined;
  return toDimensions((params as Record<string, unknown>).responseDimensions);
}

/** Numeric value of a cumulativeMetric dimension by uid. */
function cumulativeDim(dims: DevinResponseDimension[], uid: string): number | undefined {
  const dim = dims.find((d) => d.uid === uid && d.kind?.type === "cumulativeMetric");
  const value = dim?.kind?.value;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * `_cognition.ai/turn_stats` params → the turn's billable token usage plus
 * the turnClientMessageId that ties it to its owning turn.
 *
 * The responseDimensions' cumulativeMetric rows sum every internal model
 * request of the turn — unlike usage_update / PromptResponse.usage, which
 * report only the last request — so this is the authoritative accounting:
 * `input_tokens` is the uncached input sum, `cached_input_tokens` the
 * cached-read sum, `cache_write_tokens` the cache-write sum. DevinUsage's
 * inputTokens stays cache-inclusive (matching usage_update semantics), so
 * it carries all three summed.
 */
export function turnStatsToUsage(
  params: unknown,
): { clientMessageId?: string; usage?: DevinUsage } | undefined {
  if (typeof params !== "object" || params === null) return undefined;
  const record = params as Record<string, unknown>;
  const clientMessageId =
    typeof record.turnClientMessageId === "string" ? record.turnClientMessageId : undefined;
  const dims = toDimensions(record.responseDimensions);
  const input = dims ? cumulativeDim(dims, "input_tokens") : undefined;
  if (!dims || input === undefined) return { clientMessageId };
  const cacheRead = cumulativeDim(dims, "cached_input_tokens") ?? 0;
  const cacheWrite = cumulativeDim(dims, "cache_write_tokens") ?? 0;
  return {
    clientMessageId,
    usage: {
      inputTokens: input + cacheRead + cacheWrite,
      outputTokens: cumulativeDim(dims, "output_tokens") ?? 0,
      cachedReadTokens: cacheRead,
      cachedWriteTokens: cacheWrite,
      dimensions: dims,
      cumulative: true,
    },
  };
}
