/**
 * pi-tian-subagents — isolated Pi RPC subagents with profiles, background runs, and worktrees.
 *
 * Architecture: supervisor lifecycle and run orchestration live in an Effect v4
 * `SubagentRuntime` service (see `src/runtime.ts`). This file is the imperative
 * boundary for tools, UI, and session hooks.
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
import { formatRunSummary, formatUsageCost, type SubagentSupervisor } from "./lib/supervisor.ts";
import {
  SUBAGENT_APPLY_TOOL_DESCRIPTION,
  SUBAGENT_CANCEL_TOOL_DESCRIPTION,
  SUBAGENT_PARAMETER_DESCRIPTIONS,
  SUBAGENT_STATUS_TOOL_DESCRIPTION,
  SUBAGENT_TOOL_DESCRIPTION,
} from "./lib/prompt.ts";
import {
  createSubagentRuntime,
  getSupervisor,
  runSubagent,
  SubagentRuntime,
  type SubagentRuntimeInstance,
  type SubagentRuntimeShape,
} from "./src/runtime.ts";

const WIDGET_KEY = "pi-tian-subagents";

const SubagentParams = Type.Object({
  profile: Type.String({
    minLength: 1,
    description: SUBAGENT_PARAMETER_DESCRIPTIONS.profile,
  }),
  task: Type.String({
    minLength: 1,
    maxLength: TASK_MAX_LENGTH,
    description: SUBAGENT_PARAMETER_DESCRIPTIONS.task,
  }),
  context: Type.Optional(
    Type.String({
      maxLength: CONTEXT_MAX_LENGTH,
      description: SUBAGENT_PARAMETER_DESCRIPTIONS.context,
    }),
  ),
  mode: Type.Optional(
    Type.Union([Type.Literal("foreground"), Type.Literal("background")], {
      description: SUBAGENT_PARAMETER_DESCRIPTIONS.mode,
    }),
  ),
});

const SubagentStatusParams = Type.Object({
  run_id: Type.String({ minLength: 1, description: SUBAGENT_PARAMETER_DESCRIPTIONS.runId }),
});

const SubagentCancelParams = Type.Object({
  run_id: Type.String({ minLength: 1, description: SUBAGENT_PARAMETER_DESCRIPTIONS.cancelRunId }),
  reason: Type.Optional(
    Type.String({ maxLength: 500, description: SUBAGENT_PARAMETER_DESCRIPTIONS.cancelReason }),
  ),
});

const SubagentApplyParams = Type.Object({
  run_id: Type.String({ minLength: 1, description: SUBAGENT_PARAMETER_DESCRIPTIONS.applyRunId }),
});

type SubagentInput = Static<typeof SubagentParams>;
type SubagentStatusInput = Static<typeof SubagentStatusParams>;
type SubagentCancelInput = Static<typeof SubagentCancelParams>;
type SubagentApplyInput = Static<typeof SubagentApplyParams>;

interface SessionState {
  subagentRuntime?: SubagentRuntimeInstance;
  subagentService?: SubagentRuntimeShape;
  supervisor?: SubagentSupervisor;
  extensionPi?: ExtensionAPI;
  closing?: Promise<void>;
}

export default function subagentsExtension(pi: ExtensionAPI) {
  const session: SessionState = { extensionPi: pi };

  function service(): SubagentRuntimeShape {
    if (!session.subagentService) throw new Error("Subagent runtime is not initialized.");
    return session.subagentService;
  }

  function runtime(): SubagentRuntimeInstance {
    if (!session.subagentRuntime) throw new Error("Subagent runtime is not initialized.");
    return session.subagentRuntime;
  }

  function requireSupervisor(): SubagentSupervisor {
    if (!session.supervisor) throw new Error("Subagent supervisor is not initialized.");
    return session.supervisor;
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
      usageAvailable: result.usageAvailable,
      model: result.model,
      activity,
      mode: mode ?? "foreground",
      semanticReport: result.semanticReport,
      worktreeDelivery: result.worktreeDelivery,
      budgetExhausted: result.budgetExhausted,
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

  function deliverBackgroundResult(result: SubagentRunResult): boolean {
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
            worktreeDelivery: result.worktreeDelivery,
            semanticReport: result.semanticReport,
          },
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
      return true;
    } catch (error) {
      if (session.extensionPi) {
        console.error("pi-subagents: failed to deliver background result", error);
      }
      return false;
    }
  }

  function refreshWidget(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui") return;
    const sv = session.supervisor;
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

  pi.on("session_start", async (_event, ctx) => {
    session.subagentRuntime = createSubagentRuntime();
    session.subagentService = session.subagentRuntime.runSync(SubagentRuntime);
    await runSubagent(
      session.subagentRuntime,
      service().init(ctx.cwd, undefined, (result) => {
        const delivered = deliverBackgroundResult(result);
        refreshWidget(ctx);
        return delivered;
      }),
    );
    session.supervisor = await getSupervisor(session.subagentRuntime, service());
  });

  pi.on("session_shutdown", async () => {
    if (!session.subagentRuntime || !session.subagentService) {
      session.extensionPi = undefined;
      return;
    }
    if (session.closing) {
      await session.closing.catch(() => {});
      return;
    }
    session.closing = (async () => {
      const closingRuntime = session.subagentRuntime;
      const closingService = session.subagentService;
      try {
        await runSubagent(closingRuntime!, closingService!.close);
      } finally {
        await closingRuntime!.dispose();
        if (session.subagentRuntime === closingRuntime) {
          session.subagentRuntime = undefined;
          session.subagentService = undefined;
          session.supervisor = undefined;
          session.extensionPi = undefined;
        }
        if (session.closing) session.closing = undefined;
      }
    })();
    await session.closing;
  });

  pi.on("agent_settled", async () => {
    if (!session.subagentRuntime || !session.subagentService || !session.extensionPi) return;
    await runSubagent(session.subagentRuntime, service().drainPendingResults).catch(() => {});
  });

  pi.registerTool({
    name: "subagent",
    label: "subagent",
    description: SUBAGENT_TOOL_DESCRIPTION,
    parameters: SubagentParams,
    async execute(
      _toolCallId,
      params: SubagentInput,
      signal,
      onUpdate,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<SubagentToolDetails>> {
      const sv = requireSupervisor();
      let activity = "starting";
      const mode = params.mode ?? "foreground";

      const result = await runSubagent(
        runtime(),
        service().run({
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
        }),
        { signal },
      );

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
        theme.fg(
          "muted",
          ` · ${details.status} · ${formatUsageCost({ usage: details.usage, usageAvailable: details.usageAvailable })}`,
        );
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
    description: SUBAGENT_STATUS_TOOL_DESCRIPTION,
    parameters: SubagentStatusParams,
    async execute(_id, params: SubagentStatusInput) {
      const sv = requireSupervisor();
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
    description: SUBAGENT_CANCEL_TOOL_DESCRIPTION,
    parameters: SubagentCancelParams,
    async execute(_id, params: SubagentCancelInput, _signal, _onUpdate, ctx) {
      const ok = await runSubagent(runtime(), service().cancelRun(params.run_id, params.reason));
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

  pi.registerTool({
    name: "subagent_apply",
    label: "subagent apply",
    description: SUBAGENT_APPLY_TOOL_DESCRIPTION,
    parameters: SubagentApplyParams,
    async execute(_id, params: SubagentApplyInput, _signal, _onUpdate, ctx) {
      const sv = requireSupervisor();
      if (!ctx.hasUI) {
        return {
          content: [
            {
              type: "text",
              text: "subagent_apply requires interactive confirmation and cannot run without UI.",
            },
          ],
          details: {
            runId: params.run_id,
            profile: "?",
            status: "failed",
            usage: emptyUsage(),
          },
        };
      }

      const record = sv.getRun(params.run_id);
      if (!record?.result?.worktreeDelivery?.patch) {
        return {
          content: [
            {
              type: "text",
              text: `Run "${params.run_id}" has no patch artifact to apply.`,
            },
          ],
          details: {
            runId: params.run_id,
            profile: record?.profile ?? "?",
            status: "failed",
            usage: emptyUsage(),
          },
        };
      }

      const confirmed = await ctx.ui.confirm(
        `Apply subagent patch for ${params.run_id}?`,
        `Branch: ${record.result.worktreeDelivery.branch ?? "?"}\nPatch: ${record.result.worktreeDelivery.patch.path}`,
      );
      if (!confirmed) {
        return {
          content: [{ type: "text", text: `Patch apply cancelled for ${params.run_id}.` }],
          details: {
            runId: params.run_id,
            profile: record.profile,
            status: record.status,
            usage: record.result.usage,
            worktreeDelivery: record.result.worktreeDelivery,
          },
        };
      }

      try {
        const updated = await runSubagent(runtime(), service().applyPatch(params.run_id));
        const status = updated.worktreeDelivery?.patch?.applyStatus ?? "applied";
        return {
          content: [
            {
              type: "text",
              text: `Patch ${status} for ${params.run_id} (${updated.worktreeDelivery?.branch ?? "?"}).`,
            },
          ],
          details: buildDetails(updated, record.activity, record.mode),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Patch apply failed for ${params.run_id}: ${message}` }],
          details: {
            runId: params.run_id,
            profile: record.profile,
            status: "failed",
            usage: record.result.usage,
            worktreeDelivery: record.result.worktreeDelivery,
          },
        };
      }
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
      await openAgentsDashboard(ctx, requireSupervisor());
    },
  });
}
