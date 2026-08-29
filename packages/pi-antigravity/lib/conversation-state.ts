import { constants as fsConstants, promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AgyUsage } from "./events.ts";

export const AGY_CONVERSATION_STATE_ENTRY = "pi-antigravity-conversation-state";

export interface PersistedAgyConversation {
  version: 1;
  kind: "conversation";
  sessionId: string;
  conversationId: string;
  cwd: string;
  modelId: string;
  turns: number;
  usage: AgyUsage;
  /** Most recent observed model context footprint (input + cache read). */
  contextTokens?: number;
}

export interface PersistedAgyReset {
  version: 1;
  kind: "reset";
  sessionId: string;
  cwd: string;
}

export type PersistedAgyState = PersistedAgyConversation | PersistedAgyReset;

export function agyConversationDatabasePath(
  conversationId: string,
  homeDirectory = os.homedir(),
): string {
  return path.join(
    homeDirectory,
    ".gemini",
    "antigravity-cli",
    "conversations",
    `${conversationId}.db`,
  );
}

export async function agyConversationExists(
  conversationId: string,
  homeDirectory?: string,
): Promise<boolean> {
  try {
    await fs.access(agyConversationDatabasePath(conversationId, homeDirectory), fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

const CONTEXT_CHANGING_ENTRY_TYPES = new Set([
  "message",
  "model_change",
  "compaction",
  "branch_summary",
  "custom_message",
]);

function isBoundedString(value: unknown, maxLength = 4_096): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function parseUsage(value: unknown): AgyUsage | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const usage: AgyUsage = {};
  for (const key of [
    "input_tokens",
    "output_tokens",
    "thinking_tokens",
    "cache_read_tokens",
    "total_tokens",
  ] as const) {
    const field = record[key];
    if (field === undefined) continue;
    if (!isNonNegativeNumber(field)) return undefined;
    usage[key] = field;
  }
  return usage;
}

export function parsePersistedAgyState(value: unknown): PersistedAgyState | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || !isBoundedString(record.sessionId, 256)) return undefined;
  if (!isBoundedString(record.cwd)) return undefined;
  if (record.kind === "reset") {
    return {
      version: 1,
      kind: "reset",
      sessionId: record.sessionId,
      cwd: record.cwd,
    };
  }
  if (record.kind !== "conversation") return undefined;
  if (!isBoundedString(record.conversationId, 256)) return undefined;
  if (!isBoundedString(record.modelId, 256)) return undefined;
  if (!Number.isSafeInteger(record.turns) || (record.turns as number) < 0) return undefined;
  const usage = parseUsage(record.usage);
  if (!usage) return undefined;
  if (record.contextTokens !== undefined && !isNonNegativeNumber(record.contextTokens)) {
    return undefined;
  }
  return {
    version: 1,
    kind: "conversation",
    sessionId: record.sessionId,
    conversationId: record.conversationId,
    cwd: record.cwd,
    modelId: record.modelId,
    turns: record.turns as number,
    usage,
    contextTokens: record.contextTokens as number | undefined,
  };
}

/**
 * Find a conversation that exactly owns the active Pi session branch.
 *
 * Forked session files inherit custom entries but receive a new session id, so
 * they cannot resume the same mutable agy conversation. Likewise, any Pi
 * context-changing entry after the state marker makes it stale. Harmless
 * labels, UI-only custom entries, and session metadata may follow it.
 */
export function restorableAgyConversation(
  branch: readonly SessionEntry[],
  sessionId: string,
  cwd: string,
): PersistedAgyConversation | undefined {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry.type !== "custom" || entry.customType !== AGY_CONVERSATION_STATE_ENTRY) continue;
    const state = parsePersistedAgyState(entry.data);
    // The newest state marker is authoritative. A reset or malformed marker
    // must not accidentally resurrect an older conversation.
    if (!state || state.kind === "reset") return undefined;
    if (state.sessionId !== sessionId || state.cwd !== cwd) return undefined;
    if (
      branch.slice(index + 1).some((candidate) => CONTEXT_CHANGING_ENTRY_TYPES.has(candidate.type))
    ) {
      return undefined;
    }
    return state;
  }
  return undefined;
}
