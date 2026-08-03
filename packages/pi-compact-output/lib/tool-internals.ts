import type { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type { ToolExecutionInternals } from "./compact-tool-line.ts";

function isComponent(value: unknown): value is Component {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Component).render === "function" &&
    typeof (value as Component).invalidate === "function"
  );
}

function isResultShape(value: unknown): value is NonNullable<ToolExecutionInternals["result"]> {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.isError !== undefined && typeof record.isError !== "boolean") return false;
  if (record.content !== undefined && !Array.isArray(record.content)) return false;
  return true;
}

export function tryReadToolExecutionInternals(
  component: ToolExecutionComponent,
): ToolExecutionInternals | undefined {
  const runtime = component as unknown as Record<string, unknown>;

  const toolName = runtime.toolName;
  if (typeof toolName !== "string" || toolName.length === 0) return undefined;

  const isPartial = runtime.isPartial;
  if (typeof isPartial !== "boolean") return undefined;

  const callRendererComponent = runtime.callRendererComponent;
  if (callRendererComponent !== undefined && !isComponent(callRendererComponent)) return undefined;

  const hideComponent = runtime.hideComponent;
  if (hideComponent !== undefined && typeof hideComponent !== "boolean") return undefined;

  const result = runtime.result;
  if (result !== undefined && !isResultShape(result)) return undefined;

  return {
    toolName,
    args: runtime.args,
    callRendererComponent,
    isPartial,
    result,
    hideComponent: hideComponent as boolean | undefined,
  };
}
