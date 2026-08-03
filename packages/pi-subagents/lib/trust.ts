import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ProfileDefinition } from "./domain.ts";

const APPROVALS_DIR = "subagents";
const APPROVALS_FILE = "approvals.json";

export function profileContentHash(rawContent: string): string {
  return createHash("sha256").update(rawContent, "utf8").digest("hex").slice(0, 16);
}

interface ApprovalsStore {
  profiles: Record<string, string>;
}

function approvalsPath(agentDir: string): string {
  return path.join(agentDir, APPROVALS_DIR, APPROVALS_FILE);
}

function loadApprovals(agentDir: string): ApprovalsStore {
  const filePath = approvalsPath(agentDir);
  if (!fs.existsSync(filePath)) return { profiles: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as ApprovalsStore;
    if (!parsed || typeof parsed !== "object" || !parsed.profiles) return { profiles: {} };
    return parsed;
  } catch {
    return { profiles: {} };
  }
}

function saveApprovals(agentDir: string, store: ApprovalsStore): void {
  const dir = path.join(agentDir, APPROVALS_DIR);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(approvalsPath(agentDir), `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

export function isProfileApproved(
  agentDir: string,
  qualifiedId: string,
  contentHash: string,
): boolean {
  const store = loadApprovals(agentDir);
  return store.profiles[qualifiedId] === contentHash;
}

export function recordProfileApproval(
  agentDir: string,
  qualifiedId: string,
  contentHash: string,
): void {
  const store = loadApprovals(agentDir);
  store.profiles[qualifiedId] = contentHash;
  saveApprovals(agentDir, store);
}

export interface ProfileApprovalContext {
  projectTrusted: boolean;
  hasUI: boolean;
  requestApproval?: (profile: ProfileDefinition) => Promise<boolean>;
}

export async function ensureProjectProfileAllowed(
  profile: ProfileDefinition,
  ctx: ProfileApprovalContext,
  agentDir: string = getAgentDir(),
): Promise<void> {
  if (profile.source !== "project") return;
  if (!profile.contentHash) {
    throw new Error(`Project profile "${profile.qualifiedId}" is missing a content hash`);
  }

  if (!ctx.projectTrusted) {
    throw new Error(
      `Project profile "${profile.qualifiedId}" requires a trusted project. Mark the project trusted in Pi before use.`,
    );
  }

  if (isProfileApproved(agentDir, profile.qualifiedId, profile.contentHash)) return;

  if (!ctx.hasUI || !ctx.requestApproval) {
    throw new Error(
      `Project profile "${profile.qualifiedId}" is not approved. Run /agents in an interactive session to approve it first.`,
    );
  }

  const approved = await ctx.requestApproval(profile);
  if (!approved) {
    throw new Error(`Project profile "${profile.qualifiedId}" was not approved`);
  }

  recordProfileApproval(agentDir, profile.qualifiedId, profile.contentHash);
}
