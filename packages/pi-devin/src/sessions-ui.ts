/**
 * /devin sessions — pick an ACP session to attach or delete. Kept to
 * ctx.ui.select/confirm prompts (no custom overlay) for v1.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DevinListSessionInfo } from "../lib/acp-client.ts";

function shortId(id: string): string {
  return id.length <= 14 ? id : `${id.slice(0, 12)}…`;
}

function describeSession(session: DevinListSessionInfo, currentId?: string): string {
  const title = session.title?.trim() || "(untitled)";
  const locked = session.meta?.["cognition.ai/isLocked"] === true ? " 🔒" : "";
  const here = session.sessionId === currentId ? " — current" : "";
  const updated = session.updatedAt
    ? new Date(session.updatedAt).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";
  return `${title} (${shortId(session.sessionId)})${locked}${here}${updated ? ` · ${updated}` : ""}`;
}

export interface DevinSessionsUiDeps {
  listSessions: () => Promise<DevinListSessionInfo[]>;
  loadSession: (sessionId: string) => Promise<void> | void;
  deleteSession: (sessionId: string) => Promise<void>;
  currentSessionId: () => Promise<string | undefined> | string | undefined;
}

/** Run the /devin sessions flow. Returns a user-facing summary line. */
export async function runDevinSessionsPicker(
  ctx: ExtensionContext,
  deps: DevinSessionsUiDeps,
): Promise<void> {
  const sessions = await deps.listSessions();
  if (sessions.length === 0) {
    ctx.ui.notify("devin: no sessions found.", "info");
    return;
  }
  const current = await deps.currentSessionId();
  const labels = sessions.map((session) => describeSession(session, current));
  const picked = await ctx.ui.select("devin sessions", labels);
  if (!picked) return;
  const session = sessions[labels.indexOf(picked)];
  if (!session) return;

  const action = await ctx.ui.select(`${session.title ?? session.sessionId}`, [
    "Attach to this session",
    "Delete session",
    "Cancel",
  ]);
  if (action === "Attach to this session") {
    await deps.loadSession(session.sessionId);
    return;
  }
  if (action === "Delete session") {
    const sure = await ctx.ui.confirm(
      "Delete devin session",
      `Delete "${session.title ?? session.sessionId}"? This cannot be undone.`,
    );
    if (!sure) return;
    await deps.deleteSession(session.sessionId);
    ctx.ui.notify(`devin: deleted session ${shortId(session.sessionId)}.`, "info");
  }
}
