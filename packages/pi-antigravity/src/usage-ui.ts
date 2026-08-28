/**
 * /agy-usage UI — same interaction as pi-usage `/usage`: a cancellable loader,
 * then ctx.ui.select with the formatted report as the title and Refresh / Close.
 * Data comes from lib/usage.ts (`agy --print /usage`).
 */

import { BorderedLoader, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { formatAgyUsageReport, type AgyUsageReport } from "../lib/usage.ts";

const REFRESH = "Refresh";
const CLOSE = "Close";

type LoaderResult<T> = { ok: true; value: T } | { ok: false; error: unknown } | null;

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

async function runWithLoader<T>(
  ctx: ExtensionCommandContext,
  label: string,
  parentSignal: AbortSignal,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T | undefined> {
  if (ctx.mode !== "tui") return operation(parentSignal);
  const result = await ctx.ui.custom<LoaderResult<T>>((tui, theme, _keybindings, done) => {
    const loader = new BorderedLoader(tui, theme, label, { cancellable: true });
    let finished = false;
    const finish = (value: LoaderResult<T>) => {
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
}

function notifyError(ctx: ExtensionCommandContext, error: unknown): void {
  ctx.ui.notify(`agy-usage: ${error instanceof Error ? error.message : error}`, "error");
}

/** Entry point: fetch quotas (with a TUI loader) and open the /usage-style menu. */
export async function openAgyUsagePicker(
  ctx: ExtensionCommandContext,
  fetchReport: (signal?: AbortSignal) => Promise<AgyUsageReport>,
): Promise<void> {
  if (!ctx.hasUI) {
    try {
      ctx.ui.notify(formatAgyUsageReport(await fetchReport()), "info");
    } catch (error) {
      notifyError(ctx, error);
    }
    return;
  }

  const controller = new AbortController();
  try {
    let report = await runWithLoader(ctx, "Checking agy quota…", controller.signal, fetchReport);
    if (!report) return;
    while (!controller.signal.aborted) {
      const action = await ctx.ui.select(formatAgyUsageReport(report), [REFRESH, CLOSE], {
        signal: controller.signal,
      });
      if (!action || action === CLOSE) return;
      if (action === REFRESH) {
        try {
          const refreshed = await runWithLoader(
            ctx,
            "Refreshing usage…",
            controller.signal,
            fetchReport,
          );
          if (refreshed) report = refreshed;
        } catch (error) {
          if (isAbortError(error)) return;
          notifyError(ctx, error);
        }
      }
    }
  } catch (error) {
    if (isAbortError(error)) return;
    notifyError(ctx, error);
  } finally {
    controller.abort();
  }
}
