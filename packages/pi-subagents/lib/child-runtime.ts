/**
 * Child-only extension: registers the terminating report_result tool.
 *
 * Loaded explicitly via `pi --no-extensions -e <path>/child-runtime.ts`.
 */

import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { RunReportSchema } from "./run-report.ts";
import { REPORT_RESULT_TOOL_NAME } from "./report-result-tool.ts";

const reportResultTool = defineTool({
  name: REPORT_RESULT_TOOL_NAME,
  label: "Report Result",
  description:
    "Return the final structured run report. Call this alone as your last action when the task is finished, blocked, or failed.",
  promptSnippet: "Emit the final structured run report as report_result",
  promptGuidelines: [
    "Call report_result alone as your final action when you are done, blocked, or failed.",
    "After calling report_result, do not emit another assistant response in the same turn.",
  ],
  parameters: RunReportSchema,

  async execute(_toolCallId, params) {
    return {
      content: [{ type: "text", text: `Reported: ${params.status}` }],
      details: params,
      terminate: true,
    };
  },
});

export default function childRuntimeExtension(pi: ExtensionAPI) {
  pi.registerTool(reportResultTool);
}
