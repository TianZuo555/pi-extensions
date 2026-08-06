// Presentation helpers: a multi-line report for the /usage menu and a compact
// single-line string for the footer statusline.

import {
  CODEX_PROVIDER_ID,
  COPILOT_PROVIDER_ID,
  DEEPSEEK_PROVIDER_ID,
  ZAI_CN_PROVIDER_ID,
  ZAI_PROVIDER_ID,
  formatMoney,
  type ProviderReport,
  type UsageWindow,
} from "./providers.ts";

const BAR_SEGMENTS = 20;
const LABEL_COLUMN = 18;

/** State for one provider as shown in the /usage menu. */
export type ProviderState =
  | { id: string; name: string; status: "ready"; report: ProviderReport }
  | { id: string; name: string; status: "unconfigured" | "error"; message: string };

/** Build the multi-line body shown as the /usage menu title. */
export function formatReport(state: ProviderState): string {
  if (state.status !== "ready") {
    const prefix = state.status === "unconfigured" ? "Not configured" : "Query failed";
    return `${state.name}\n  ${prefix}: ${state.message}`;
  }

  const report = state.report;
  const header = report.plan ? `${report.name} · ${titleCase(report.plan)}` : report.name;
  const lines = [header];
  if (report.windows.length === 0) lines.push("  No usage windows reported.");
  for (const window of report.windows) {
    lines.push(`  ${formatWindow(window)}`);
  }
  for (const note of report.notes) lines.push(`  ${note}`);
  return lines.join("\n");
}

/** Combine multiple provider states into one menu body. */
export function formatReports(states: readonly ProviderState[]): string {
  return states
    .filter((state) => state.status !== "unconfigured")
    .map(formatReport)
    .join("\n\n");
}

function formatWindow(window: UsageWindow): string {
  const label = `${window.label}:`.padEnd(LABEL_COLUMN);
  if (window.unlimited) return `${label}unlimited`;

  const parts: string[] = [];
  if (window.remainingPercent !== undefined) {
    parts.push(`${bar(window.remainingPercent)} ${Math.round(window.remainingPercent)}% left`);
  }
  const unit = window.credits ? " credits" : "";
  if (window.currency && window.remaining !== undefined) {
    parts.push(formatMoney(window.remaining, window.currency));
  } else if (window.remaining !== undefined && window.entitlement !== undefined) {
    parts.push(`${formatCount(window.remaining)} / ${formatCount(window.entitlement)}${unit}`);
  } else if (window.remaining !== undefined) {
    parts.push(`${formatCount(window.remaining)}${unit} left`);
  }
  if (window.resetsAt !== undefined) {
    const reset = formatReset(window.resetsAt);
    if (reset) parts.push(`resets ${reset}`);
  }
  return `${label}${parts.length > 0 ? parts.join(" · ") : "unavailable"}`;
}

/** Compact footer text for the active provider, or undefined when not applicable. */
export function formatStatusline(report: ProviderReport): string | undefined {
  if (report.id === CODEX_PROVIDER_ID) {
    const parts = report.windows
      .filter((window) => window.remainingPercent !== undefined)
      .map((window) => `${Math.round(window.remainingPercent as number)}% ${shortWindow(window.label)}`);
    return parts.length > 0 ? `codex ${parts.join(" ")}` : undefined;
  }
  if (report.id === COPILOT_PROVIDER_ID) {
    // The premium bucket is the only metered one; it is reported as credits on
    // token-based-billing accounts and as requests otherwise.
    const premium = report.windows[0];
    if (!premium) return undefined;
    const unit = premium.credits ? "credits" : "premium";
    if (premium.unlimited) return "copilot unlimited";
    if (premium.remainingPercent !== undefined) {
      return `copilot ${Math.round(premium.remainingPercent)}% ${unit}`;
    }
    return undefined;
  }
  if (report.id === ZAI_PROVIDER_ID || report.id === ZAI_CN_PROVIDER_ID) {
    // Both GLM Coding Plan regions surface the 5-hour token pool.
    const tokens = report.windows.find((window) => /5h/.test(window.label));
    if (tokens?.remainingPercent !== undefined) {
      const label = report.id === ZAI_CN_PROVIDER_ID ? "zai-cn" : "zai";
      return `${label} ${Math.round(tokens.remainingPercent)}% 5h`;
    }
    return undefined;
  }
  if (report.id === DEEPSEEK_PROVIDER_ID) {
    // DeepSeek has no percentage quota — the footer shows the money balance.
    const balance = report.windows.find(
      (window) => window.remaining !== undefined && window.currency !== undefined,
    );
    if (balance?.remaining !== undefined && balance.currency !== undefined) {
      return `deepseek ${formatMoney(balance.remaining, balance.currency)}`;
    }
    return undefined;
  }
  return undefined;
}

// --- helpers ----------------------------------------------------------------

function bar(remainingPercent: number): string {
  const filled = Math.round((clampPercent(remainingPercent) / 100) * BAR_SEGMENTS);
  return `[${"█".repeat(filled)}${"░".repeat(BAR_SEGMENTS - filled)}]`;
}

function shortWindow(label: string): string {
  const normalized = label.toLowerCase();
  if (normalized.includes("week")) return "wk";
  return label.replace(/\s*limit$/i, "").trim() || label;
}

function formatCount(value: number): string {
  const rounded = Math.round(value);
  if (Math.abs(rounded) >= 1000) return rounded.toLocaleString("en-US");
  return String(rounded);
}

function formatReset(epochSeconds: number): string | undefined {
  const reset = new Date(epochSeconds * 1000);
  if (Number.isNaN(reset.getTime())) return undefined;
  const time = `${pad(reset.getHours())}:${pad(reset.getMinutes())}`;
  const now = new Date();
  if (reset.toDateString() === now.toDateString()) return time;
  return `${time} on ${reset.getDate()} ${reset.toLocaleDateString("en-US", { month: "short" })}`;
}

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function titleCase(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .trim();
}
