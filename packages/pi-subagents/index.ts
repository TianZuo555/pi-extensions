/**
 * pi-tian-subagents — isolated Pi RPC subagents with profiles, background runs, and worktrees.
 */

import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import {
  BACKGROUND_RESULT_TYPE,
  CONTEXT_MAX_LENGTH,
  emptyUsage,
  isTerminalStatus,
  TASK_MAX_LENGTH,
  type SubagentRunResult,
  type SubagentToolDetails,
} from "./lib/domain.ts";
import { openAgentsDashboard } from "./lib/ui/agents-command.ts";
import { formatRunSummary, SubagentSupervisor } from "./lib/supervisor.ts";

const WIDGET_KEY = "pi-tian-subagents";

const SubagentParams = Type.Object({
  profile: Type.String({
    minLength: 1,
    description: "Profile short name or qualified id (e.g. scout, builtin/reviewer, project/my-agent).",
  }),
  task: Type.String({
    minLength: 1,
    maxLength: TASK_MAX_LENGTH,
    description: "Objective plus expected deliverable.",
  }),
  context: Type.Optional(
    Type.String({
      maxLength: CONTEXT_MAX_LENGTH,
      description: "Facts the child cannot cheaply rediscover — not parent transcript history.",
    }),
  ),
  mode: Type.Optional(
    Type.Union([Type.Literal("foreground"), Type.Literal("background")], {
      description: "foreground (default) blocks until complete; background returns a run id immediately.",
    }),
  ),
});

const SubagentStatusParams = Type.Object({
  run_id: Type.String({ minLength: 1, description: "Subagent run id (e.g. sa-a13f9c2b)." }),
});

const SubagentCancelParams = Type.Object({
  run_id: Type.String({ minLength: 1 }),
  reason: Type.Optional(Type.String({ maxLength: 500 })),
});

type SubagentInput = Static<typeof SubagentParams>;
type SubagentStatusInput = Static<typeof SubagentStatusParams>;
type SubagentCancelInput = Static<typeof SubagentCancelParams>;

const TOOL_DESCRIPTION = `Delegate a bounded task to a subagent in an isolated Pi RPC child process.

Built-in profiles: scout, planner, reviewer, oracle (read-only), worker (git worktree + writes).

Parallel work: call this tool multiple times in one turn (sibling calls run concurrently).

Capabilities (model, tools, workspace) come from the profile — not from tool arguments.

Use mode=background to continue without blocking; completion arrives as a follow-up notification.`;

let supervisor: SubagentSupervisor | undefined;
let extensionPi: ExtensionAPI | undefined;

function getSupervisor(ctx: ExtensionContext): SubagentSupervisor {
  if (!supervisor) supervisor = new SubagentSupervisor(ctx.cwd);
  return supervisor;
}

function buildDetails(
  result: SubagentRunResult,
  activity?: string,
  mode?: SubagentInput["mode"],
): SubagentToolDetails {
  return {
    runId: result.runId,
    profile: result.profile,
    status: result.status,
    usage: result.usage,
    model: result.model,
    activity,
    mode: mode ?? "foreground",
  };
}

function formatResultMessage(result: SubagentRunResult): string {
  const header = formatRunSummary(result);
  if (result.status === "running" || result.status === "completed") {
    return `${header}\n\n${result.report}`;
  }
  const err = result.error ?? result.status;
  return `${header}\n\nError: ${err}\n\nPartial output:\n${result.report}`;
}

function notifySessionCostWarning(ctx: ExtensionContext, sv: SubagentSupervisor): void {
  if (!sv.needsCostWarning() || !ctx.hasUI) return;
  sv.markCostWarned();
  const ceiling = sv.getSessionSoftCostUsd();
  ctx.ui.notify(
    `Subagent session spend is $${sv.getSessionCostUsd().toFixed(4)} (soft ceiling $${ceiling.toFixed(2)}).`,
    "warning",
  );
}

function deliverBackgroundResult(pi: ExtensionAPI, result: SubagentRunResult): void {
  try {
    pi.sendMessage(
      {
        customType: BACKGROUND_RESULT_TYPE,
        content: formatResultMessage(result),
        display: true,
        details: {
          runId: result.runId,
          profile: result.profile,
          status: result.status,
          usage: result.usage,
          worktreeBranch: result.worktreeBranch,
        },
      },
      { deliverAs: "followUp", triggerTurn: true },
    );
  } catch (error) {
    if (extensionPi) {
      console.error("pi-subagents: failed to deliver background result", error);
    }
  }
}

function refreshWidget(ctx: ExtensionContext): void {
  if (ctx.mode !== "tui") return;
  const sv = supervisor;
  if (!sv) return;
  const active = sv.listRuns().filter((r) => r.status === "running").length;
  try {
    if (active === 0) {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      return;
    }
    ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) => {
      return new Text(
        theme.fg("accent", `${active} subagent${active === 1 ? "" : "s"} running`) +
          theme.fg("dim", " · /agents"),
        0,
        0,
      );
    });
  } catch {
    // UI may be unavailable during teardown.
  }
}

export default function subagentsExtension(pi: ExtensionAPI) {
  extensionPi = pi;

  pi.on("session_start", async (_event, ctx) => {
    supervisor = new SubagentSupervisor(ctx.cwd);
    supervisor.setBackgroundCompleteHandler((result) => {
      deliverBackgroundResult(pi, result);
      refreshWidget(ctx);
    });
  });

  pi.on("session_shutdown", () => {
    if (supervisor) {
      supervisor.dispose();
      supervisor = undefined;
    }
    extensionPi = undefined;
  });

  pi.on("agent_settled", () => {
    if (!supervisor || !extensionPi) return;
    for (const result of supervisor.drainPendingResults()) {
      deliverBackgroundResult(extensionPi, result);
    }
  });

  pi.registerTool({
    name: "subagent",
    label: "subagent",
    description: TOOL_DESCRIPTION,
    parameters: SubagentParams,
    async execute(
      _toolCallId,
      params: SubagentInput,
      signal,
      onUpdate,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<SubagentToolDetails>> {
      const sv = getSupervisor(ctx);
      let activity = "starting";
      const mode = params.mode ?? "foreground";

      const result = await sv.run({
        profile: params.profile,
        task: params.task,
        context: params.context,
        cwd: ctx.cwd,
        parentModel: ctx.model,
        mode,
        signal,
        projectTrusted: ctx.isProjectTrusted(),
        hasUI: ctx.hasUI,
        requestProfileApproval: async (profile) => {
          if (!ctx.hasUI) return false;
          return ctx.ui.confirm(
            `Approve project profile ${profile.qualifiedId}?`,
            `${profile.description || profile.name}\n\nHash: ${profile.contentHash}\nTools: ${profile.tools.join(", ")}\nWorkspace: ${profile.workspace}`,
          );
        },
        onActivity: (name) => {
          activity = name;
          if (!onUpdate) return;
          const partial: AgentToolResult<SubagentToolDetails> = {
            content: [{ type: "text", text: `[${params.profile}] ${activity}…` }],
            details: buildDetails(
              {
                runId: "…",
                profile: params.profile,
                qualifiedProfile: params.profile,
                status: "running",
                report: "",
                usage: emptyUsage(),
                durationMs: 0,
              },
              activity,
              mode,
            ),
          };
          onUpdate(partial);
        },
      });

      notifySessionCostWarning(ctx, sv);
      refreshWidget(ctx);
      const text = formatResultMessage(result);
      return {
        content: [{ type: "text", text }],
        details: buildDetails(result, activity, mode),
      };
    },

    renderCall(args: SubagentInput, theme: Theme) {
      const preview = args.task.length > 72 ? `${args.task.slice(0, 72)}…` : args.task;
      const mode = args.mode === "background" ? " · bg" : "";
      return new Text(
        theme.fg("toolTitle", theme.bold("subagent ")) +
          theme.fg("accent", args.profile) +
          theme.fg("dim", `${mode} · ${preview}`),
        0,
        0,
      );
    },

    renderResult(result, { expanded }, theme: Theme) {
      const details = result.details as SubagentToolDetails | undefined;
      if (!details) return new Text("", 0, 0);
      const icon =
        details.status === "completed" || details.status === "running"
          ? theme.fg("success", "✓ ")
          : theme.fg("error", "✗ ");
      let text =
        icon +
        theme.fg("accent", details.profile) +
        theme.fg("muted", ` · ${details.status} · $${details.usage.cost.toFixed(4)}`);
      if (expanded) {
        const body = result.content[0]?.type === "text" ? result.content[0].text : "";
        text += `\n${body}`;
      }
      return new Text(text, 0, 0);
    },
  });

  pi.registerTool({
    name: "subagent_status",
    label: "subagent status",
    description: "Check a background subagent run by run_id.",
    parameters: SubagentStatusParams,
    async execute(_id, params: SubagentStatusInput, _signal, _onUpdate, ctx) {
      const sv = getSupervisor(ctx);
      const record = sv.getRun(params.run_id);
      if (!record) {
        return {
          content: [{ type: "text", text: `No subagent run "${params.run_id}".` }],
          details: {
            runId: params.run_id,
            profile: "?",
            status: "failed",
            usage: emptyUsage(),
          },
        };
      }
      if (record.result && isTerminalStatus(record.status)) {
        return {
          content: [{ type: "text", text: formatResultMessage(record.result) }],
          details: buildDetails(record.result, record.activity, record.mode),
        };
      }
      return {
        content: [
          {
            type: "text",
            text: `${params.run_id} · ${record.qualifiedProfile} · ${record.status}${record.activity ? ` · ${record.activity}` : ""}`,
          },
        ],
        details: {
          runId: record.runId,
          profile: record.profile,
          status: record.status,
          usage: record.result?.usage ?? emptyUsage(),
          activity: record.activity,
          mode: record.mode,
        },
      };
    },
  });

  pi.registerTool({
    name: "subagent_cancel",
    label: "subagent cancel",
    description: "Cancel a running subagent by run_id.",
    parameters: SubagentCancelParams,
    async execute(_id, params: SubagentCancelInput, _signal, _onUpdate, ctx) {
      const sv = getSupervisor(ctx);
      const ok = sv.cancelRun(params.run_id, params.reason);
      refreshWidget(ctx);
      return {
        content: [
          {
            type: "text",
            text: ok
              ? `Cancelled subagent ${params.run_id}.`
              : `Could not cancel ${params.run_id} (not running or unknown id).`,
          },
        ],
        details: {
          runId: params.run_id,
          profile: "?",
          status: ok ? "cancelled" : "failed",
          usage: emptyUsage(),
        },
      };
    },
  });

  pi.registerMessageRenderer(BACKGROUND_RESULT_TYPE, (message, _options, theme) => {
    const details = (message.details ?? {}) as { runId?: string; profile?: string; status?: string };
    const icon =
      details.status === "completed"
        ? theme.fg("success", "✓ ")
        : theme.fg("error", "✗ ");
    return new Text(
      icon +
        theme.fg("accent", `subagent ${details.runId ?? "?"}`) +
        theme.fg("muted", ` · ${details.profile ?? "?"} · ${details.status ?? "?"}`),
      0,
      0,
    );
  });

  pi.registerCommand("agents", {
    description: "List subagent runs and available profiles",
    handler: async (_args, ctx) => {
      const sv = getSupervisor(ctx);
      await openAgentsDashboard(ctx, sv);
    },
  });
}
