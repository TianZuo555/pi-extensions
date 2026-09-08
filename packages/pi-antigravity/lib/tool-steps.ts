import type { AgyActivity } from "./reducer.ts";

/** Missing step IDs use the same best-effort name key as replay correlation. */
export function agyToolStepKey(activity: { stepId?: number; name: string }): string {
  return activity.stepId === undefined ? `name:${activity.name}` : `step:${activity.stepId}`;
}

/** Repeated ACTIVE updates are idempotent; one completion cannot clear siblings. */
export function trackActiveToolStep(active: Set<string>, activity: AgyActivity): void {
  if (activity.type === "tool_start") active.add(agyToolStepKey(activity));
  else if (activity.type === "tool_done" || activity.type === "tool_error") {
    active.delete(agyToolStepKey(activity));
  }
}
