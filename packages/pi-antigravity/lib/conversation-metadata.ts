import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export const AGY_METADATA_MAX_BYTES = 5 * 1024 * 1024;

export interface AgyConversationMetadata {
  id: string;
  title?: string;
  preview?: string;
  numSteps?: number;
  updatedAt?: string;
  workspaceUris: string[];
  agentName?: string;
}

export type AgyMetadataStatus = "ok" | "missing" | "oversized" | "invalid" | "unreadable";

export interface AgyMetadataResult {
  status: AgyMetadataStatus;
  metadata?: AgyConversationMetadata;
}

export function agyConversationMetadataPath(homeDirectory = os.homedir()): string {
  return path.join(
    homeDirectory,
    ".gemini",
    "antigravity-cli",
    "cache",
    "conversation_metadata.json",
  );
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function boundedString(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined;
}

function validTimestamp(value: unknown): string | undefined {
  const timestamp = boundedString(value, 128);
  return timestamp && Number.isFinite(Date.parse(timestamp)) ? timestamp : undefined;
}

export function parseAgyConversationMetadata(
  value: unknown,
  conversationId: string,
): AgyConversationMetadata | undefined {
  const root = record(value);
  const conversations = record(root?.conversations);
  const raw = record(conversations?.[conversationId]);
  const summary = record(raw?.summary) ?? raw;
  if (!summary) return undefined;
  const id = boundedString(summary.ID, 256) ?? boundedString(summary.id, 256);
  if (!id || id !== conversationId) return undefined;

  const numSteps = summary.NumSteps;
  const workspaceUris = Array.isArray(summary.WorkspaceURIs)
    ? summary.WorkspaceURIs.slice(0, 32)
        .map((uri) => boundedString(uri, 4_096))
        .filter((uri): uri is string => uri !== undefined)
    : [];
  return {
    id,
    title: boundedString(summary.Title, 512),
    preview: boundedString(summary.Preview, 2_048),
    numSteps:
      Number.isSafeInteger(numSteps) && (numSteps as number) >= 0
        ? (numSteps as number)
        : undefined,
    updatedAt: validTimestamp(summary.UpdatedAt),
    workspaceUris,
    agentName: boundedString(summary.AgentName, 256),
  };
}

export async function readAgyConversationMetadata(
  conversationId: string,
  options: { file?: string; maxBytes?: number } = {},
): Promise<AgyMetadataResult> {
  const file = options.file ?? agyConversationMetadataPath();
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(file);
  } catch (error) {
    return {
      status: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable",
    };
  }
  if (!stat.isFile()) return { status: "unreadable" };
  if (stat.size > (options.maxBytes ?? AGY_METADATA_MAX_BYTES)) return { status: "oversized" };

  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(file, "r");
    const limit = options.maxBytes ?? AGY_METADATA_MAX_BYTES;
    const buffer = Buffer.alloc(limit + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > limit) return { status: "oversized" };
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, total));
    } catch {
      return { status: "invalid" };
    }
    const parsed = JSON.parse(text) as unknown;
    const metadata = parseAgyConversationMetadata(parsed, conversationId);
    return metadata ? { status: "ok", metadata } : { status: "invalid" };
  } catch (error) {
    return {
      status: error instanceof SyntaxError ? "invalid" : "unreadable",
    };
  } finally {
    await handle?.close().catch(() => {});
  }
}
