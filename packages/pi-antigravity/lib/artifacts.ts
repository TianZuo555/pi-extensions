/** Safe discovery of user-facing files in an agy conversation brain directory. */

import { promises as fs, type Dirent } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface AgyArtifact {
  name: string;
  absolutePath: string;
  kind: "conversation" | "generated" | "uploaded";
  mediaType: "image" | "audio" | "video" | "pdf" | "markdown" | "other";
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
  md: "markdown",
  markdown: "markdown",
};

function mediaTypeFor(name: string): AgyArtifact["mediaType"] {
  return MEDIA_TYPES[name.split(".").pop()?.toLowerCase() ?? ""] ?? "other";
}

function isContained(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

function isVisibleArtifactName(name: string): boolean {
  return !name.startsWith(".") && !name.toLowerCase().endsWith(".metadata.json");
}

async function listDirectFiles(
  dir: string,
  conversationRoot: string,
  kind: AgyArtifact["kind"],
): Promise<AgyArtifact[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const artifacts: AgyArtifact[] = [];
  for (const entry of entries) {
    if (!isVisibleArtifactName(entry.name) || !entry.isFile() || entry.isSymbolicLink()) continue;
    const candidate = path.resolve(dir, entry.name);
    if (!isContained(conversationRoot, candidate)) continue;
    try {
      const [stat, canonical] = await Promise.all([fs.lstat(candidate), fs.realpath(candidate)]);
      if (!stat.isFile() || stat.isSymbolicLink() || !isContained(conversationRoot, canonical))
        continue;
      artifacts.push({
        name: entry.name,
        absolutePath: canonical,
        kind,
        mediaType: mediaTypeFor(entry.name),
        bytes: stat.size,
        modifiedMs: stat.mtimeMs,
      });
    } catch {
      // Atomic replacement or unreadable entry: omit it from this scan.
    }
  }
  return artifacts;
}

/** List safe direct artifacts for one agy conversation, newest first. */
export async function listAgyArtifacts(
  conversationId: string,
  options: { brainDir?: string } = {},
): Promise<AgyArtifact[]> {
  const brain = path.resolve(options.brainDir ?? agyBrainDir());
  const base = path.resolve(brain, conversationId);
  if (!isContained(brain, base) || base === brain) return [];

  let canonicalBrain: string;
  let canonicalBase: string;
  try {
    [canonicalBrain, canonicalBase] = await Promise.all([fs.realpath(brain), fs.realpath(base)]);
  } catch {
    return [];
  }
  if (!isContained(canonicalBrain, canonicalBase) || canonicalBase === canonicalBrain) return [];

  const [conversation, generated, uploaded] = await Promise.all([
    listDirectFiles(canonicalBase, canonicalBase, "conversation"),
    listDirectFiles(path.join(canonicalBase, ".tempmediaStorage"), canonicalBase, "generated"),
    listDirectFiles(path.join(canonicalBase, ".user_uploaded"), canonicalBase, "uploaded"),
  ]);
  const deduped = new Map<string, AgyArtifact>();
  for (const artifact of [...conversation, ...generated, ...uploaded]) {
    if (!deduped.has(artifact.absolutePath)) deduped.set(artifact.absolutePath, artifact);
  }
  return [...deduped.values()].sort(
    (a, b) =>
      b.modifiedMs - a.modifiedMs ||
      a.name.localeCompare(b.name) ||
      a.absolutePath.localeCompare(b.absolutePath),
  );
}

/** Resolve an artifact reference by exact name or unique prefix. */
export function findAgyArtifact(artifacts: AgyArtifact[], ref: string): AgyArtifact | undefined {
  const needle = ref.trim().toLowerCase();
  const exact = artifacts.find((artifact) => artifact.name.toLowerCase() === needle);
  if (exact) return exact;
  const prefixed = artifacts.filter((artifact) => artifact.name.toLowerCase().startsWith(needle));
  return prefixed.length === 1 ? prefixed[0] : undefined;
}
