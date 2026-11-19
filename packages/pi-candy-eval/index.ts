// pi-candy-eval — ask Codex accounts a fixed reasoning puzzle, and keep the
// answers, so a degraded upstream model shows up as a wrong answer or as
// reasoning tokens far below the account's own history.
//
// There is no timer and no background work here (pi's extension contract starts
// background resources only after a session begins, and this probe is
// deliberate, not periodic): the tool and `/candy` run one round each, and the
// runs live in ~/.pi/candy-eval/runs.jsonl.
//
// Routes: only magpie can pin a request to one account, so every probe issues a
// ten-minute gateway key for that account and calls the gateway's chat endpoint.
//
// Quick try:  pi -e ./packages/pi-candy-eval

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import {
  accountList,
  DEFAULT_TIMEOUT_MS,
  effortOf,
  gatewayUrl,
  magpieBin,
  modelOf,
  probe,
  type ProbeRun,
} from "./lib/magpie.ts";
import {
  CANDY_PARAMETER_DESCRIPTIONS,
  CANDY_PROMPT_GUIDELINES,
  CANDY_PROMPT_SNIPPET,
  CANDY_TOOL_DESCRIPTION,
} from "./lib/prompt.ts";
import { appendRun, formatHistory, formatRun, lastRuns, medianOf, stateDir } from "./lib/state.ts";

const HISTORY_ROWS = 10;
const BASELINE_ROWS = 10;

const CandyParams = Type.Object({
  account: Type.Optional(Type.String({ description: CANDY_PARAMETER_DESCRIPTIONS.account })),
});

type CandyInput = Static<typeof CandyParams>;

/** One round: every named account, or all that magpie has switched on. */
async function probeRound(
  account: string | undefined,
  signal: AbortSignal | undefined,
): Promise<{ runs: ProbeRun[]; accounts: string[] }> {
  const bin = await magpieBin();
  if (!bin) {
    throw new Error(
      "magpie is not installed: candy-eval needs its gateway to pin a request to one account",
    );
  }
  const url = await gatewayUrl(bin);
  const accounts = account ? [account] : (await accountList(bin)).map((entry) => entry.user);
  if (accounts.length === 0) {
    throw new Error("magpie has no switched-on Codex account to probe");
  }
  const settings = { model: modelOf(), effort: effortOf(), timeoutMs: DEFAULT_TIMEOUT_MS, signal };
  const dir = stateDir();
  const runs: ProbeRun[] = [];
  for (const user of accounts) {
    const run = await probe(bin, url, user, settings);
    appendRun(dir, run);
    runs.push(run);
  }
  return { runs, accounts };
}

/** The account's own recent reasoning-token median, for a run to be read against. */
function baselineOf(runs: ProbeRun[]): string {
  const reasoning = runs
    .filter((run) => run.verdict !== "error")
    .map((run) => run.reasoningTokens)
    .filter((value): value is number => value !== undefined);
  const median = medianOf(reasoning);
  if (median === undefined) return "no earlier reasoning tokens to compare";
  return `earlier runs: median ${median} reasoning tok over ${reasoning.length}`;
}

function report(runs: ProbeRun[], dir: string): string {
  const lines = runs.map((run) => formatRun(run));
  for (const run of runs) {
    if (run.verdict === "error") continue;
    const earlier = lastRuns(dir, BASELINE_ROWS, run.account).filter((row) => row.at !== run.at);
    lines.push(`  ${run.account}: ${baselineOf(earlier)}`);
  }
  return lines.join("\n");
}

function usage(): string {
  return [
    "candy-eval",
    "  /candy            probe every switched-on Codex account now",
    "  /candy <email>    probe one account",
    `  /candy history    the last ${HISTORY_ROWS} runs`,
    "  PI_CANDY_MODEL, PI_CANDY_EFFORT, PI_CANDY_GATEWAY, PI_CANDY_MAGPIE_BIN, PI_CANDY_STATE_DIR change the defaults",
  ].join("\n");
}

export default function candyEval(pi: ExtensionAPI): void {
  let busy = false;

  pi.registerTool({
    name: "candy_eval",
    label: "Candy eval",
    description: CANDY_TOOL_DESCRIPTION,
    promptSnippet: CANDY_PROMPT_SNIPPET,
    promptGuidelines: CANDY_PROMPT_GUIDELINES,
    parameters: CandyParams,

    async execute(_toolCallId, params: CandyInput, signal, _onUpdate, _ctx) {
      if (busy) {
        return {
          content: [{ type: "text" as const, text: "a candy probe is already running" }],
          details: { runs: [] },
        };
      }
      busy = true;
      try {
        const { runs } = await probeRound(params.account, signal);
        return {
          content: [{ type: "text" as const, text: report(runs, stateDir()) }],
          details: { runs },
        };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: `candy eval failed: ${reason}` }],
          details: { runs: [] },
          isError: true,
        };
      } finally {
        busy = false;
      }
    },
  });

  pi.registerCommand("candy", {
    description: "Probe Codex accounts with the candy puzzle: /candy [<email>|history]",

    handler: async (args, ctx) => {
      const arg = args.trim();
      const dir = stateDir();

      if (arg === "history") {
        ctx.ui.notify(
          formatHistory(lastRuns(dir, HISTORY_ROWS), `candy-eval · ${modelOf()} · ${effortOf()}`),
          "info",
        );
        return;
      }
      if (arg && !arg.includes("@")) {
        ctx.ui.notify(usage(), "info");
        return;
      }
      if (busy) {
        ctx.ui.notify("a candy probe is already running", "info");
        return;
      }

      busy = true;
      try {
        ctx.ui.notify(arg ? `probing ${arg}…` : "probing every Codex account…", "info");
        const { runs, accounts } = await probeRound(arg || undefined, undefined);
        const passed = runs.filter((run) => run.verdict === "ok").length;
        const failed = runs.filter((run) => run.verdict === "error").length;
        const counts = [
          `${accounts.length} account${accounts.length === 1 ? "" : "s"}`,
          `${passed} answered 21`,
        ];
        if (failed > 0) counts.push(`${failed} failed`);
        ctx.ui.notify(`candy-eval · ${counts.join(" · ")}\n${report(runs, dir)}`, "info");
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`candy eval failed: ${reason}`, "error");
      } finally {
        busy = false;
      }
    },
  });
}
