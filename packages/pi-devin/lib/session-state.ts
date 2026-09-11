import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const DEVIN_SESSION_STATE_ENTRY = "pi-devin-session-state";

export interface PersistedDevinSession {
  version: 1;
  kind: "session";
  /** Owning pi session id — a fork gets a new id and cannot resume. */
  sessionId: string;
  /** Devin ACP session id. */
  acpSessionId: string;
  cwd: string;
  /** Pi model id (family group) last used with this session. */
  modelId: string;
  turns: number;
  /** Latest context occupancy (tokens) from usage_update. */
  contextTokens?: number;
}

export interface PersistedDevinReset {
  version: 1;
  kind: "reset";
  sessionId: string;
  cwd: string;
}

export type PersistedDevinState = PersistedDevinSession | PersistedDevinReset;

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

export function parsePersistedDevinState(value: unknown): PersistedDevinState | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || !isBoundedString(record.sessionId, 256)) return undefined;
  if (!isBoundedString(record.cwd)) return undefined;
  if (record.kind === "reset") {
    return { version: 1, kind: "reset", sessionId: record.sessionId, cwd: record.cwd };
  }
  if (record.kind !== "session") return undefined;
  if (!isBoundedString(record.acpSessionId, 256)) return undefined;
  if (!isBoundedString(record.modelId, 256)) return undefined;
  if (!Number.isSafeInteger(record.turns) || (record.turns as number) < 0) return undefined;
  if (record.contextTokens !== undefined && !isNonNegativeNumber(record.contextTokens)) {
    return undefined;
  }
  return {
    version: 1,
    kind: "session",
    sessionId: record.sessionId,
    acpSessionId: record.acpSessionId,
    cwd: record.cwd,
    modelId: record.modelId,
    turns: record.turns as number,
    contextTokens: record.contextTokens as number | undefined,
  };
}

/**
 * Find an ACP session binding that exactly owns the active Pi branch.
 * Mirrors pi-antigravity's conversation-state rules: the newest marker is
 * authoritative, a reset/malformed marker ends the chain, and any
 * context-changing entry after the marker makes it stale.
 */
export function restorableDevinSession(
  branch: readonly SessionEntry[],
  sessionId: string,
  cwd: string,
): PersistedDevinSession | undefined {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry.type !== "custom" || entry.customType !== DEVIN_SESSION_STATE_ENTRY) continue;
    const state = parsePersistedDevinState(entry.data);
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
