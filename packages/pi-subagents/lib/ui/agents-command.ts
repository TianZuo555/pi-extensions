import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import type { RunRecord } from "../domain.ts";
import { herdrJson, type HerdrCliOptions } from "../herdr/cli.ts";
import {
  closePane,
  focusPane,
  readAgent,
} from "../herdr/workspace.ts";
import { formatUsageCost, type SubagentSupervisor } from "../supervisor.ts";

const DASHBOARD_LINES = 80;

function formatRunLine(record: RunRecord): string {
  const elapsed = record.completedAt
    ? `${((record.completedAt - record.startedAt) / 1000).toFixed(1)}s`
    : `${((Date.now() - record.startedAt) / 1000).toFixed(1)}s`;
  const activity = record.activity ? ` · ${record.activity}` : "";
  const cost = record.result ? ` · ${formatUsageCost(record.result)}` : "";
  const branch = record.worktreeBranch ? ` · branch:${record.worktreeBranch}` : "";
  const kind = record.profileKind ? ` · kind:${record.profileKind}` : "";
  const backend = record.backendId ? ` · ${record.backendId}` : "";
  const pane = record.herdr?.paneId ? ` · pane:${record.herdr.paneId}` : "";
  const agentStatus = record.herdr?.agentStatus ? ` · agent:${record.herdr.agentStatus}` : "";
  return `${record.runId} · ${record.qualifiedProfile}${kind}${backend} · ${record.status} · ${elapsed}${cost}${branch}${pane}${agentStatus}${activity}`;
}

async function refreshHerdrAgentStatus(
  record: RunRecord,
  cliOptions?: HerdrCliOptions,
): Promise<string | undefined> {
  if (!record.herdr?.alias || !cliOptions) return record.herdr?.agentStatus;
  const status = await Effect.runPromise(
    herdrJson(["agent", "get", record.herdr.alias], cliOptions).pipe(
      Effect.map((result) => {
        const value = (result as { agent?: { agent_status?: string } }).agent?.agent_status;
        return typeof value === "string" ? value : undefined;
      }),
      Effect.orElseSucceed(() => undefined),
    ),
  );
  if (status && record.herdr) {
    record.herdr.agentStatus = status;
  }
  return status ?? record.herdr?.agentStatus;
}

async function runHerdrAction(
  record: RunRecord,
  action: string,
  cliOptions?: HerdrCliOptions,
): Promise<string> {
  const alias = record.herdr?.alias ?? record.runId;
  const paneId = record.herdr?.paneId;
  if (!cliOptions) return "Herdr CLI is not configured for this session.";

  if (action === "Focus pane") {
    if (!paneId) return "No pane id recorded for this run.";
    await Effect.runPromise(focusPane(paneId, cliOptions));
    return `Focused pane ${paneId} (${record.runId}).`;
  }

  if (action === "Read last 80 lines") {
    const text = await Effect.runPromise(readAgent(alias, DASHBOARD_LINES, cliOptions));
    return text.trim() || "(empty transcript)";
  }

  if (action === "Close pane") {
    if (!paneId) return "No pane id recorded for this run.";
    await Effect.runPromise(closePane(paneId, cliOptions));
    return `Closed pane ${paneId} (${record.runId}).`;
  }

  return "Unknown action.";
}

export async function openAgentsDashboard(
  ctx: ExtensionCommandContext,
  supervisor: SubagentSupervisor,
): Promise<void> {
  const runs = supervisor.listRuns();
  const profiles = supervisor.listProfiles().map((p) => p.qualifiedId).join(", ");
  const diagnostics = supervisor.getProfileLoadDiagnostics();
  const cliOptions = supervisor.getBackendPool().getHerdrCliOptions();
  const branches = runs
    .filter((r) => r.worktreeBranch || r.worktreeDelivery?.patch)
    .map((r) => {
      const patch = r.worktreeDelivery?.patch;
      const patchNote = patch ? ` · patch:${patch.applyStatus}` : "";
      return `${r.worktreeBranch ?? "?"} (${r.runId})${patchNote}`;
    })
    .join("\n");

  for (const record of runs) {
    if (record.backendId === "herdr" && record.herdr?.alias) {
      await refreshHerdrAgentStatus(record, cliOptions);
    }
  }

  const sections: string[] = [`Profiles: ${profiles}`];
  if (diagnostics.length > 0) {
    sections.push("", "Skipped profiles:", diagnostics.join("\n"));
  }
  if (branches) {
    sections.push("", "Worktree branches and patch artifacts:", branches);
  }
  sections.push(
    "",
    runs.length === 0 ? "No subagent runs in this session." : runs.map(formatRunLine).join("\n"),
  );

  const text = sections.join("\n");

  const herdrRuns = runs.filter((r) => r.backendId === "herdr" && r.herdr?.paneId);
  if (!ctx.hasUI || herdrRuns.length === 0) {
    if (ctx.hasUI) ctx.ui.notify(text, "info");
    return;
  }

  const runLabels = herdrRuns.map((r) => formatRunLine(r));
  const pickedLabel = await ctx.ui.select("Herdr subagent run", runLabels);
  if (!pickedLabel) {
    ctx.ui.notify(text, "info");
    return;
  }
  const record = herdrRuns.find((r) => formatRunLine(r) === pickedLabel);
  if (!record) {
    ctx.ui.notify(text, "info");
    return;
  }

  const action = await ctx.ui.select(`Actions for ${record.runId}`, [
    "Focus pane",
    "Read last 80 lines",
    "Close pane",
    "Done",
  ]);
  if (!action || action === "Done") {
    ctx.ui.notify(text, "info");
    return;
  }

  const actionResult = await runHerdrAction(record, action, cliOptions);
  ctx.ui.notify(`${actionResult}\n\n${text}`, "info");
}
