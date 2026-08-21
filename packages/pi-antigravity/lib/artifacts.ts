/**
 * Discovery of agy conversation artifacts.
 *
 * agy stores per-conversation files under
 * `~/.gemini/antigravity-cli/brain/<conversation-id>/`:
 *   - `.tempmediaStorage/` — media/files the agent created (artifacts);
 *   - `.user_uploaded/`    — files the user uploaded into the conversation.
 *
 * The stream-json RPC never reports these, so — like background tasks —
 * this module reads them from the filesystem. Transcripts reference them
 * as `[ARTIFACT: <name>]` markers with `file://` paths.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface AgyArtifact {
  /** File name, e.g. "media_1786774158854.png". */
  name: string;
  absolutePath: string;
  /** created-by-agent vs uploaded-by-user. */
  kind: "generated" | "uploaded";
  /** Rough media type from the extension. */
  mediaType: "image" | "audio" | "video" | "pdf" | "other";
  bytes: number;
  modifiedMs: number;
}

export function agyBrainDir(): string {
  return path.join(os.homedir(), ".gemini", "antigravity-cli", "brain");
}

const MEDIA_TYPES: Record<string, AgyArtifact["mediaType"]> = {
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  svg: "image",
  mp3: "audio",
  wav: "audio",
  ogg: "audio",
  mp4: "video",
  webm: "video",
  mov: "video",
  pdf: "pdf",
};

function mediaTypeFor(name: string): AgyArtifact["mediaType"] {
  return MEDIA_TYPES[name.split(".").pop()?.toLowerCase() ?? ""] ?? "other";
}

async function listDir(
  dir: string,
  kind: AgyArtifact["kind"],
): Promise<AgyArtifact[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return []; // Directory absent — the conversation created no artifacts.
  }
  return Promise.all(
    entries
      .filter((name) => !name.startsWith("."))
      .map(async (name): Promise<AgyArtifact> => {
        const absolutePath = path.join(dir, name);
        const stat = await fs.stat(absolutePath).catch(() => undefined);
        return {
          name,
          absolutePath,
          kind,
          mediaType: mediaTypeFor(name),
          bytes: stat?.size ?? 0,
          modifiedMs: stat?.mtimeMs ?? 0,
        };
      }),
  );
}

/** List every artifact recorded for an agy conversation, newest first. */
export async function listAgyArtifacts(
  conversationId: string,
  options: { brainDir?: string } = {},
): Promise<AgyArtifact[]> {
  const base = path.join(options.brainDir ?? agyBrainDir(), conversationId);
  const [generated, uploaded] = await Promise.all([
    listDir(path.join(base, ".tempmediaStorage"), "generated"),
    listDir(path.join(base, ".user_uploaded"), "uploaded"),
  ]);
  return [...generated, ...uploaded].sort((a, b) => b.modifiedMs - a.modifiedMs);
}

/** Resolve an artifact reference by exact name or unique prefix. */
export function findAgyArtifact(
  artifacts: AgyArtifact[],
  ref: string,
): AgyArtifact | undefined {
  const needle = ref.trim().toLowerCase();
  const exact = artifacts.find((artifact) => artifact.name.toLowerCase() === needle);
  if (exact) return exact;
  const prefixed = artifacts.filter((artifact) => artifact.name.toLowerCase().startsWith(needle));
  return prefixed.length === 1 ? prefixed[0] : undefined;
}
