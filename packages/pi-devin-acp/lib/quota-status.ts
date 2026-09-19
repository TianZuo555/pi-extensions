import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatDevinQuotaStatusline, type DevinQuotaResult } from "./quota.ts";

const STATUS_KEY = "devin-usage";
const VIOLET = "\x1b[38;2;167;139;250m";
const RESET_FOREGROUND = "\x1b[39m";
const TTL_MS = 60_000;

type StatusContext = Pick<ExtensionContext, "model"> & {
  ui: Pick<ExtensionContext["ui"], "setStatus">;
};

/** Account-wide cache; publication belongs only to the latest active refresh. */
export function createDevinQuotaStatus(
  fetchQuota: () => Promise<DevinQuotaResult>,
  now: () => number = Date.now,
) {
  let cached: { at: number; result: DevinQuotaResult } | undefined;
  let inflight: Promise<DevinQuotaResult> | undefined;
  let generation = 0;

  const setStatus = (ctx: StatusContext, text: string | undefined) => {
    try {
      ctx.ui.setStatus(STATUS_KEY, text);
    } catch {
      // No UI, or a stale context after session shutdown.
    }
  };

  return {
    clear(ctx?: StatusContext): void {
      generation++;
      if (ctx) setStatus(ctx, undefined);
    },
    async refresh(ctx: StatusContext): Promise<void> {
      const current = ++generation;
      if (ctx.model?.provider !== "devin") {
        setStatus(ctx, undefined);
        return;
      }
      let result = cached && now() - cached.at < TTL_MS ? cached.result : undefined;
      if (!result) {
        if (!inflight) {
          inflight = fetchQuota()
            .then((value) => {
              cached = { at: now(), result: value };
              return value;
            })
            .finally(() => {
              inflight = undefined;
            });
        }
        result = await inflight;
      }
      // Switching models/sessions or shutting down invalidates pending writes.
      if (current !== generation) return;
      if (ctx.model?.provider !== "devin") {
        setStatus(ctx, undefined);
        return;
      }
      const text = result.ok ? formatDevinQuotaStatusline(result.quota) : undefined;
      setStatus(ctx, text ? `${VIOLET}${text}${RESET_FOREGROUND}` : undefined);
    },
  };
}
