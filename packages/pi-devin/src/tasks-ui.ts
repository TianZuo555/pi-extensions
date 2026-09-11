/**
 * /devin tasks — list devin-side operations still in flight (slow execs,
 * detached background shells). Kept to ctx.ui.select/confirm prompts for v1.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DevinLiveOp } from "./runtime.ts";

function formatElapsed(startedAt: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s === 0 ? `${m}m` : `${m}m${s}s`;
}

export function describeLiveOp(op: DevinLiveOp, now = Date.now()): string {
  const view = op.view;
  const bits: string[] = [];
  if (view.kind) bits.push(view.kind);
  if (view.tool) bits.push(view.tool);
  bits.push(formatElapsed(op.startedAt, now));
  if (view.shellId) bits.push(`bg shell ${view.shellId}`);
  const title = view.title?.trim() || "(untitled op)";
  const line = `${title} — ${bits.join(" · ")}`;
  return line.length > 90 ? `${line.slice(0, 87)}…` : line;
}

export interface DevinTasksUiDeps {
  listOps: () => Promise<DevinLiveOp[]> | DevinLiveOp[];
  /** Send a plain-text instruction into the live devin session. */
  sendToSession: (text: string) => void;
}

/** Run the /devin tasks flow. */
export async function runDevinTasksPicker(
  ctx: ExtensionContext,
  deps: DevinTasksUiDeps,
): Promise<void> {
  const ops = await deps.listOps();
  if (ops.length === 0) {
    ctx.ui.notify("devin: no running operations.", "info");
    return;
  }
  const labels = ops.map((op) => describeLiveOp(op));
  const picked = await ctx.ui.select("devin tasks", labels);
  if (!picked) return;
  const op = ops[labels.indexOf(picked)];
  if (!op?.view.shellId) return;

  const kill = await ctx.ui.confirm(
    "devin tasks",
    `Ask devin to kill background shell ${op.view.shellId}? It runs in devin's process, so only devin can stop it.`,
  );
  if (!kill) return;
  deps.sendToSession(`Kill background shell ${op.view.shellId} and confirm it stopped.`);
  ctx.ui.notify(`devin: asked to kill shell ${op.view.shellId}.`, "info");
}
