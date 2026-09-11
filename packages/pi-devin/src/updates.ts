/**
 * Pure mapping from ACP session/update payloads to DevinActivity items the
 * provider drains. Kept separate so it is directly unit-testable.
 */

import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { DevinConfigOption } from "../lib/acp-client.ts";
import { mergeDevinTool } from "../lib/tool-content.ts";
import type { DevinActivity, DevinUsage } from "./turn.ts";

function metaNumber(update: { _meta?: unknown }, key: string): number | undefined {
  const meta = update._meta;
  if (typeof meta !== "object" || meta === null) return undefined;
  const value = (meta as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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
        contextSize: typeof update.size === "number" ? update.size : undefined,
        inputTokens: metaNumber(update, "cognition.ai/inputTokens"),
        outputTokens: metaNumber(update, "cognition.ai/outputTokens"),
        cachedReadTokens: metaNumber(update, "cognition.ai/cachedReadTokens"),
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
    },
  };
}
