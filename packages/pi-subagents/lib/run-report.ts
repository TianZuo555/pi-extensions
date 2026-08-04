/**
 * Fixed RunReport contract for child report_result handoff.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { REPORT_MAX_BYTES, truncateUtf8 } from "./domain.ts";

export const REPORT_STATUS_VALUES = ["completed", "blocked", "failed"] as const;
export type ReportStatus = (typeof REPORT_STATUS_VALUES)[number];

const MAX_SUMMARY_CHARS = 8_000;
const MAX_STRING_CHARS = 2_000;
const MAX_ARRAY_ITEMS = 32;
const MAX_QUESTION_CHARS = 1_000;

const EvidenceSchema = Type.Object({
  path: Type.String({ maxLength: 512 }),
  line: Type.Optional(Type.Integer({ minimum: 1, maximum: 10_000_000 })),
  detail: Type.String({ maxLength: MAX_STRING_CHARS }),
});

const ChangeSchema = Type.Object({
  path: Type.String({ maxLength: 512 }),
  summary: Type.String({ maxLength: MAX_STRING_CHARS }),
});

const CheckSchema = Type.Object({
  command: Type.String({ maxLength: 512 }),
  status: StringEnum(["passed", "failed", "not-run"] as const),
  summary: Type.Optional(Type.String({ maxLength: MAX_STRING_CHARS })),
});

const ArtifactSchema = Type.Object({
  kind: StringEnum(["transcript", "patch", "log", "file"] as const),
  path: Type.String({ maxLength: 512 }),
  description: Type.String({ maxLength: MAX_STRING_CHARS }),
  sha256: Type.Optional(Type.String({ maxLength: 128 })),
});

export const RunReportSchema = Type.Object({
  status: StringEnum(REPORT_STATUS_VALUES),
  summary: Type.String({ minLength: 1, maxLength: MAX_SUMMARY_CHARS }),
  evidence: Type.Optional(Type.Array(EvidenceSchema, { maxItems: MAX_ARRAY_ITEMS })),
  changes: Type.Optional(Type.Array(ChangeSchema, { maxItems: MAX_ARRAY_ITEMS })),
  checks: Type.Optional(Type.Array(CheckSchema, { maxItems: MAX_ARRAY_ITEMS })),
  questions: Type.Optional(
    Type.Array(Type.String({ maxLength: MAX_QUESTION_CHARS }), { maxItems: MAX_ARRAY_ITEMS }),
  ),
  artifacts: Type.Optional(Type.Array(ArtifactSchema, { maxItems: MAX_ARRAY_ITEMS })),
});

export type RunReport = Static<typeof RunReportSchema>;

export interface StructuredRunReport {
  kind: "structured";
  report: RunReport;
}

export interface UnstructuredRunReport {
  kind: "unstructured";
  text: string;
  diagnostic: string;
}

export type ChildSemanticReport = StructuredRunReport | UnstructuredRunReport;

export function parseRunReportDetails(details: unknown): RunReport | undefined {
  if (!Check(RunReportSchema, details)) return undefined;
  return details;
}

export function renderRunReport(report: RunReport): string {
  const lines: string[] = [`Status: ${report.status}`, "", report.summary];

  if (report.changes?.length) {
    lines.push("", "## Changes");
    for (const change of report.changes) {
      lines.push(`- ${change.path}: ${change.summary}`);
    }
  }

  if (report.evidence?.length) {
    lines.push("", "## Evidence");
    for (const item of report.evidence) {
      const loc = item.line ? `${item.path}:${item.line}` : item.path;
      lines.push(`- ${loc} — ${item.detail}`);
    }
  }

  if (report.checks?.length) {
    lines.push("", "## Checks");
    for (const check of report.checks) {
      const summary = check.summary ? ` — ${check.summary}` : "";
      lines.push(`- [${check.status}] ${check.command}${summary}`);
    }
  }

  if (report.questions?.length) {
    lines.push("", "## Questions");
    for (const question of report.questions) {
      lines.push(`- ${question}`);
    }
  }

  if (report.artifacts?.length) {
    lines.push("", "## Artifacts");
    for (const artifact of report.artifacts) {
      lines.push(`- ${artifact.kind}: ${artifact.path} — ${artifact.description}`);
    }
  }

  return truncateUtf8(lines.join("\n"), REPORT_MAX_BYTES);
}

export function buildSemanticReport(
  details: unknown,
  fallbackText: string,
  diagnostic: string,
): ChildSemanticReport {
  const parsed = parseRunReportDetails(details);
  if (parsed) {
    return { kind: "structured", report: parsed };
  }
  return {
    kind: "unstructured",
    text: truncateUtf8(fallbackText.trim() || "(no output)", REPORT_MAX_BYTES),
    diagnostic,
  };
}
