import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { RunRecord } from "../domain.ts";
import type { SubagentSupervisor } from "../supervisor.ts";

function formatRunLine(record: RunRecord): string {
  const elapsed = record.completedAt
    ? `${((record.completedAt - record.startedAt) / 1000).toFixed(1)}s`
    : `${((Date.now() - record.startedAt) / 1000).toFixed(1)}s`;
  const activity = record.activity ? ` · ${record.activity}` : "";
  const cost = record.result ? ` · $${record.result.usage.cost.toFixed(4)}` : "";
  const branch = record.worktreeBranch ? ` · branch:${record.worktreeBranch}` : "";
  return `${record.runId} · ${record.qualifiedProfile} · ${record.status} · ${elapsed}${cost}${branch}${activity}`;
}

export async function openAgentsDashboard(
  ctx: ExtensionCommandContext,
  supervisor: SubagentSupervisor,
): Promise<void> {
  const runs = supervisor.listRuns();
  const profiles = supervisor.listProfiles().map((p) => p.qualifiedId).join(", ");
  const diagnostics = supervisor.getProfileLoadDiagnostics();
  const branches = runs
    .filter((r) => r.worktreeBranch)
    .map((r) => `${r.worktreeBranch} (${r.runId})`)
    .join("\n");

  const sections: string[] = [`Profiles: ${profiles}`];
  if (diagnostics.length > 0) {
    sections.push("", "Skipped profiles:", diagnostics.join("\n"));
  }
  if (branches) {
    sections.push("", "Worktree branches (merge locally; dirs pruned on shutdown):", branches);
  }
  sections.push(
    "",
    runs.length === 0 ? "No subagent runs in this session." : runs.map(formatRunLine).join("\n"),
  );

  const text = sections.join("\n");
  if (ctx.hasUI) ctx.ui.notify(text, "info");
}
