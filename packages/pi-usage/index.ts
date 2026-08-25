// usage — show OpenAI Codex, GitHub Copilot, Z.ai (GLM Coding Plan), Z.ai
// China (BigModel), and DeepSeek account usage in the pi coding agent.
//
// Architecture: query cache and in-flight dedup live in an Effect v4
// `UsageRuntime` service behind one `ManagedRuntime` (see `src/runtime.ts`).
// HTTP fetch/retry is in `src/fetch.ts`. This file is the thin imperative
// boundary that runs effect programs via `runUsage` and owns UI sequencing.
//
// Commands:
//   /usage            open a menu with current usage for configured providers
//                     (Refresh re-queries; Close dismisses)
//
// Statusline:
//   When the active model belongs to a supported provider, a compact meter is
//   published to the footer (e.g. `codex 40% wk`, `copilot 49% premium`, or
//   `deepseek ¥110.00`) and refreshed at most every 5 minutes.
//
// Credentials are resolved from the same store pi writes (~/.pi/agent/auth.json).
// Codex uses the ChatGPT OAuth access token; Copilot uses the GitHub OAuth token;
// Z.ai, Z.ai China, and DeepSeek use their API keys. Inspired by
// @narumitw/pi-usage, trimmed to Codex, Copilot, Z.ai, and DeepSeek.

import {
  BorderedLoader,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  hasCodexLoginInfo,
  hasCopilotLoginInfo,
  hasDeepSeekLoginInfo,
  hasProviderLoginInfo,
  hasZaiCnLoginInfo,
  hasZaiLoginInfo,
  resolveCodexToken,
  resolveCopilotToken,
  resolveDeepSeekToken,
  resolveZaiCnToken,
  resolveZaiToken,
} from "./lib/auth.ts";
import { dedupeZaiStates, formatReports, formatStatusline, type ProviderState } from "./lib/format.ts";
import { TokensPanel } from "./lib/tokens-panel.ts";
import {
  aggregateWindow,
  buildDayIndex,
  formatCostCompact,
  formatTokensCompact,
  formatTokensFull,
  WINDOW_LABELS,
  WINDOW_ORDER,
} from "./lib/tokens-model.ts";
import {
  CODEX_PROVIDER_ID,
  COPILOT_PROVIDER_ID,
  DEEPSEEK_PROVIDER_ID,
  ZAI_CN_PROVIDER_ID,
  ZAI_PROVIDER_ID,
  queryCodexUsageEffect,
  queryCopilotUsageEffect,
  queryDeepSeekUsageEffect,
  queryZaiCnUsageEffect,
  queryZaiUsageEffect,
} from "./lib/providers.ts";
import {
  createUsageRuntime,
  type ProviderQuerySpec,
  runUsage,
  UsageRuntime,
} from "./src/runtime.ts";
import { defaultSessionsDir, scanLocalUsage, type ScanResult } from "./src/local-scan.ts";

const STATUS_KEY = "usage";
const AZURE_BLUE = "\x1b[38;2;0;127;255m";
const RESET_FOREGROUND = "\x1b[39m";
const REFRESH = "Refresh";
const CLOSE = "Close";
const NO_PROVIDER_LOGIN_MESSAGE =
  "No usage provider is configured. Log in to at least one provider with /login to view usage information.";

const PROVIDERS: ProviderQuerySpec[] = [
  {
    id: CODEX_PROVIDER_ID,
    name: "OpenAI Codex",
    configureHint: "sign in with /login and select OpenAI Codex",
    hasLoginInfo: (ctx) => hasProviderLoginInfo(ctx, CODEX_PROVIDER_ID, hasCodexLoginInfo),
    resolve: (ctx) => resolveCodexToken(ctx),
    queryEffect: queryCodexUsageEffect,
  },
  {
    id: COPILOT_PROVIDER_ID,
    name: "GitHub Copilot",
    configureHint: "sign in with /login and select GitHub Copilot",
    hasLoginInfo: (ctx) =>
      hasProviderLoginInfo(ctx, COPILOT_PROVIDER_ID, hasCopilotLoginInfo),
    resolve: async () => resolveCopilotToken(),
    queryEffect: queryCopilotUsageEffect,
  },
  {
    id: ZAI_PROVIDER_ID,
    name: "GLM Coding Plan",
    configureHint: "set ZAI_API_KEY or sign in with /login and select Z.ai",
    hasLoginInfo: (ctx) => hasProviderLoginInfo(ctx, ZAI_PROVIDER_ID, hasZaiLoginInfo),
    resolve: async () => resolveZaiToken(),
    queryEffect: queryZaiUsageEffect,
  },
  {
    id: ZAI_CN_PROVIDER_ID,
    name: "GLM Coding Plan (China)",
    configureHint:
      "set ZAI_CODING_CN_API_KEY or sign in with /login and select ZAI Coding Plan (China)",
    hasLoginInfo: (ctx) =>
      hasProviderLoginInfo(ctx, ZAI_CN_PROVIDER_ID, hasZaiCnLoginInfo),
    resolve: async () => resolveZaiCnToken(),
    queryEffect: queryZaiCnUsageEffect,
  },
  {
    id: DEEPSEEK_PROVIDER_ID,
    name: "DeepSeek",
    configureHint: "set DEEPSEEK_API_KEY or sign in with /login and select DeepSeek",
    hasLoginInfo: (ctx) =>
      hasProviderLoginInfo(ctx, DEEPSEEK_PROVIDER_ID, hasDeepSeekLoginInfo),
    resolve: async () => resolveDeepSeekToken(),
    queryEffect: queryDeepSeekUsageEffect,
  },
];

export default function usageExtension(pi: ExtensionAPI): void {
  const usageRuntime = createUsageRuntime();
  const usageService = usageRuntime.runSync(UsageRuntime);
  const sessionAbort = new AbortController();
  let statusBusy = false;
  let closing: Promise<void> | undefined;

  const safeSetStatus = (ctx: ExtensionContext, value: string | undefined) => {
    try {
      ctx.ui.setStatus(STATUS_KEY, value);
    } catch {
      // Context may be stale after a reload/session swap; ignore.
    }
  };

  // EVERY session-bound getter on a stale ctx throws, not just ctx.ui: pi
  // invalidates the extension runner as soon as a session is disposed (/new,
  // /resume, /fork, /reload, quit), and a disposed session can still emit
  // model_select — e.g. when setModel()'s auth check outlives the swap. Reading
  // ctx.model there would reject our async handler, and since the handler itself
  // returns synchronously pi's per-handler try/catch never sees it: Node turns
  // the floating rejection into an uncaughtException and kills the process.
  const probeModel = (ctx: ExtensionContext): { stale: true } | { stale: false; provider?: string } => {
    try {
      return { stale: false, provider: ctx.model?.provider };
    } catch {
      return { stale: true };
    }
  };

  const queryProvider = (
    ctx: ExtensionContext,
    provider: ProviderQuerySpec,
    force: boolean,
    signal?: AbortSignal,
  ): Promise<ProviderState> => {
    const linked = signal
      ? AbortSignal.any([sessionAbort.signal, signal])
      : sessionAbort.signal;
    return runUsage(usageRuntime, usageService.queryProvider(ctx, provider, force, linked), {
      signal: linked,
    });
  };

  const activeProviderId = (ctx: ExtensionContext): string | undefined => {
    const probe = probeModel(ctx);
    return probe.stale ? undefined : probe.provider;
  };

  // When the global and China GLM plans are configured with the same API key
  // they are the same account, so a single result is shown — preferring the
  // active model's region so the footer keeps the right label.
  const sharedZaiKey = (): boolean => {
    const zai = resolveZaiToken();
    const cn = resolveZaiCnToken();
    return Boolean(zai && cn && zai.token === cn.token);
  };

  const collectStates = (
    ctx: ExtensionContext,
    force: boolean,
    signal?: AbortSignal,
  ): Promise<ProviderState[]> => {
    const linked = signal
      ? AbortSignal.any([sessionAbort.signal, signal])
      : sessionAbort.signal;
    return runUsage(usageRuntime, usageService.collectStates(ctx, PROVIDERS, force, linked), {
      signal: linked,
    }).then((states) => dedupeZaiStates(states, activeProviderId(ctx), sharedZaiKey()));
  };

  const publishStatus = async (ctx: ExtensionContext, force: boolean) => {
    const probe = probeModel(ctx);
    // Nothing to publish for a session that no longer exists.
    if (probe.stale) return;
    const provider = PROVIDERS.find((candidate) => candidate.id === probe.provider);
    if (!provider) {
      safeSetStatus(ctx, undefined);
      return;
    }
    if (statusBusy) return;
    statusBusy = true;
    try {
      const state = await queryProvider(ctx, provider, force);
      // Errors leave the footer empty; usage details stay in the /usage menu.
      if (state.status === "ready") {
        safeSetStatus(ctx, azureStatus(formatStatusline(state.report)));
      } else {
        safeSetStatus(ctx, undefined);
      }
    } finally {
      statusBusy = false;
    }
  };

  // Run an async query behind a bordered "loading" overlay in the TUI so /usage
  // never appears frozen while the endpoints are being fetched. Esc cancels.
  // Returns undefined when the user cancels; rethrows genuine query errors.
  const runWithLoader = async <T>(
    ctx: ExtensionCommandContext,
    label: string,
    parentSignal: AbortSignal,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T | undefined> => {
    if (ctx.mode !== "tui") return operation(parentSignal);
    type LoaderResult = { ok: true; value: T } | { ok: false; error: unknown };
    const result = await ctx.ui.custom<LoaderResult | null>((tui, theme, _keybindings, done) => {
      const loader = new BorderedLoader(tui, theme, label, { cancellable: true });
      let finished = false;
      const finish = (value: LoaderResult | null) => {
        if (finished) return;
        finished = true;
        done(value);
      };
      loader.onAbort = () => finish(null);
      const signal = AbortSignal.any([parentSignal, loader.signal]);
      void operation(signal)
        .then((value) => finish({ ok: true, value }))
        .catch((error) => {
          if (isAbortError(error)) finish(null);
          else finish({ ok: false, error });
        });
      return loader;
    });
    if (!result) return undefined;
    if (!result.ok) throw result.error;
    return result.value;
  };

  const showMenu = async (ctx: ExtensionCommandContext) => {
    if (!ctx.hasUI) {
      const states = await collectStates(ctx, false);
      ctx.ui.notify(
        states.length > 0 ? compactSummary(states) : NO_PROVIDER_LOGIN_MESSAGE,
        states.length > 0 ? "info" : "warning",
      );
      return;
    }
    const controller = new AbortController();
    try {
      let states = await runWithLoader(ctx, "Checking usage…", controller.signal, (signal) =>
        collectStates(ctx, false, signal),
      );
      if (!states) return;
      if (states.length === 0) {
        publishActiveFrom(ctx, states);
        ctx.ui.notify(NO_PROVIDER_LOGIN_MESSAGE, "warning");
        return;
      }
      publishActiveFrom(ctx, states);
      while (!controller.signal.aborted) {
        const action = await ctx.ui.select(formatReports(states), [REFRESH, CLOSE], {
          signal: controller.signal,
        });
        if (!action || action === CLOSE) return;
        if (action === REFRESH) {
          const refreshed = await runWithLoader(
            ctx,
            "Refreshing usage…",
            controller.signal,
            (signal) => collectStates(ctx, true, signal),
          );
          // Cancelled refresh keeps the previously shown data.
          if (refreshed) {
            states = refreshed;
            if (states.length === 0) {
              publishActiveFrom(ctx, states);
              ctx.ui.notify(NO_PROVIDER_LOGIN_MESSAGE, "warning");
              return;
            }
            publishActiveFrom(ctx, states);
          }
        }
      }
    } finally {
      controller.abort();
    }
  };

  // --- /tokens: local token/cost history -----------------------------------

  // Both the 30-day rolling window and MTD feed the panel; scan from whichever
  // starts earlier.
  const tokensSinceMs = (): number => {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const rolling30 = now.getTime() - 30 * 24 * 60 * 60 * 1000;
    return Math.min(monthStart, rolling30);
  };

  const scanTokens = (signal?: AbortSignal): Promise<ScanResult> => {
    const linked = signal
      ? AbortSignal.any([sessionAbort.signal, signal])
      : sessionAbort.signal;
    return runUsage(
      usageRuntime,
      scanLocalUsage({ sinceMs: tokensSinceMs(), sessionsDir: defaultSessionsDir(), signal: linked }),
      { signal: linked },
    );
  };

  const refreshTokens = (): Promise<ScanResult | undefined> =>
    scanTokens().catch(() => undefined);

  const showTokens = async (ctx: ExtensionCommandContext) => {
    const controller = new AbortController();
    try {
      const snapshot = await runWithLoader(
        ctx,
        "Scanning local sessions…",
        controller.signal,
        (signal) => scanTokens(signal),
      );
      if (!snapshot) return;
      if (ctx.mode !== "tui") {
        ctx.ui.notify(plainTokensSummary(snapshot), "info");
        return;
      }
      await ctx.ui.custom<void>((tui, theme, keybindings, done) =>
        new TokensPanel({
          tui,
          theme,
          keybindings,
          snapshot,
          refresh: refreshTokens,
          done: () => done(void 0),
        }),
      );
    } finally {
      controller.abort();
    }
  };

  pi.registerCommand("tokens", {
    description: "Show local pi token/cost history for today, 7/30 days, and month-to-date",
    handler: async (args, ctx) => {
      if (args.trim()) {
        ctx.ui.notify("/tokens takes no arguments; use its chart navigation.", "warning");
        return;
      }
      await showTokens(ctx);
    },
  });

  // Reuse freshly-collected menu data to update the footer for the active model.
  const publishActiveFrom = (ctx: ExtensionContext, states: ProviderState[]) => {    const probe = probeModel(ctx);
    if (probe.stale) return;
    const provider = PROVIDERS.find((candidate) => candidate.id === probe.provider);
    if (!provider) {
      safeSetStatus(ctx, undefined);
      return;
    }
    const state = states.find((candidate) => candidate.id === provider.id);
    if (state?.status === "ready") {
      safeSetStatus(ctx, azureStatus(formatStatusline(state.report)));
    } else {
      safeSetStatus(ctx, undefined);
    }
  };

  pi.registerCommand("usage", {
    description:
      "Show OpenAI Codex, GitHub Copilot, Z.ai GLM Coding Plan (global and China), and DeepSeek usage",
    handler: async (args, ctx) => {
      if (args.trim()) {
        ctx.ui.notify("/usage takes no arguments; use its menu.", "warning");
        return;
      }
      await showMenu(ctx);
    },
  });

  // These handlers are sync, so pi's per-handler try/catch cannot observe a
  // later rejection: the .catch() is what keeps a background failure from
  // escalating to an unhandled rejection (fatal under Node's default policy).
  const publishStatusDetached = (ctx: ExtensionContext) => {
    void publishStatus(ctx, false).catch(() => {
      // Never let footer upkeep take the process down.
    });
  };

  pi.on("session_start", (_event, ctx) => {
    publishStatusDetached(ctx);
  });
  pi.on("model_select", (_event, ctx) => {
    publishStatusDetached(ctx);
  });
  pi.on("turn_start", (_event, ctx) => {
    publishStatusDetached(ctx);
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    sessionAbort.abort();
    safeSetStatus(ctx, undefined);
    if (closing) {
      await closing.catch(() => {});
      return;
    }
    closing = (async () => {
      try {
        await runUsage(usageRuntime, usageService.close);
      } catch {
        // Never let shutdown cleanup take the process down.
      }
      try {
        await usageRuntime.dispose();
      } catch {
        // ManagedRuntime may already be disposed on reload races.
      }
    })();
    await closing.catch(() => {});
  });
}

function azureStatus(text: string | undefined): string | undefined {
  return text ? `${AZURE_BLUE}${text}${RESET_FOREGROUND}` : undefined;
}

function compactSummary(states: ProviderState[]): string {
  return states
    .map((state) => {
      if (state.status === "ready") {
        return formatStatusline(state.report) ?? `${state.name}: no usage data`;
      }
      if (state.status === "unconfigured") return `${state.name}: not configured`;
      return `${state.name}: error`;
    })
    .join("  |  ");
}

/** One line per window for non-interactive modes (print/RPC). */
function plainTokensSummary(snapshot: ScanResult): string {
  const now = new Date();
  const dayIndex = buildDayIndex(snapshot.records);
  return WINDOW_ORDER.map((key) => {
    const aggregate = aggregateWindow(key, now, dayIndex);
    return `${WINDOW_LABELS[key]}: ${formatTokensCompact(aggregate.totalTokens)} tokens · ${formatCostCompact(
      aggregate.costUSD,
    )} · ${formatTokensFull(aggregate.requests)} requests`;
  }).join("\n");
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
