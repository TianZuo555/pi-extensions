/**
 * Child-only extension: registers the terminating report_result tool.
 *
 * Loaded explicitly via `pi --no-extensions -e <path>/child-runtime.ts`.
 */

import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { RunReportSchema } from "./run-report.ts";
import { REPORT_RESULT_TOOL_NAME } from "./report-result-tool.ts";
import {
  REPORT_RESULT_PROMPT_GUIDELINES,
  REPORT_RESULT_PROMPT_SNIPPET,
  REPORT_RESULT_TOOL_DESCRIPTION,
} from "./prompt.ts";

const reportResultTool = defineTool({
  name: REPORT_RESULT_TOOL_NAME,
  label: "Report Result",
  description: REPORT_RESULT_TOOL_DESCRIPTION,
  promptSnippet: REPORT_RESULT_PROMPT_SNIPPET,
  promptGuidelines: REPORT_RESULT_PROMPT_GUIDELINES,
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
