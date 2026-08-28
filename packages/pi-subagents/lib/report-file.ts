/**
 * Report file contract for Herdr-backed subagent handoff.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Check } from "typebox/value";
import {
  buildSemanticReport,
  RunReportSchema,
  type ChildSemanticReport,
  type RunReport,
} from "./run-report.ts";

const REPORT_FILE_MAX_BYTES = 256 * 1024;

export type ReportFileOutcome =
  | { kind: "valid"; report: RunReport }
  | { kind: "missing" }
  | { kind: "invalid"; reason: string };

function ensurePrivateRunDir(artifactRoot: string, runId: string): string {
  const dir = join(artifactRoot, "runs", runId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

export function reportPathFor(artifactRoot: string, runId: string): string {
  ensurePrivateRunDir(artifactRoot, runId);
  return join(artifactRoot, "runs", runId, "report.json");
}

export function buildHandoffInstructions(reportPath: string): string {
  return [
    "## Required handoff",
    "When you are finished, write your final report as JSON to:",
    `  ${reportPath}`,
    'Schema: {"status":"completed"|"blocked"|"failed","summary":string,',
    '  "evidence":[{"path":string,"line"?:number,"detail":string}],',
    '  "changes":[{"path":string,"summary":string}],',
    '  "checks":[{"command":string,"status":"passed"|"failed"|"not-run","summary"?:string}],',
    '  "questions":[string],"artifacts":[{"kind":...,"path":string,"description":string}]}',
    "Then reply with only that path and nothing else. Do not print the JSON in the terminal.",
  ].join("\n");
}

export function readReportFile(reportPath: string): ReportFileOutcome {
  if (!existsSync(reportPath)) {
    return { kind: "missing" };
  }

  const size = statSync(reportPath).size;
  if (size > REPORT_FILE_MAX_BYTES) {
    return {
      kind: "invalid",
      reason: `report file exceeds ${REPORT_FILE_MAX_BYTES} bytes`,
    };
  }

  let raw: string;
  try {
    raw = readFileSync(reportPath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { kind: "invalid", reason: `could not read report file: ${message}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "invalid", reason: "report file is not valid JSON" };
  }

  if (!Check(RunReportSchema, parsed)) {
    return { kind: "invalid", reason: "report file violates RunReport schema" };
  }

  return { kind: "valid", report: parsed as RunReport };
}

export function semanticReportFromFile(
  outcome: ReportFileOutcome,
  fallbackText: string,
  diagnostic: string,
): ChildSemanticReport {
  if (outcome.kind === "valid") {
    return buildSemanticReport(outcome.report, fallbackText, diagnostic);
  }
  return buildSemanticReport(undefined, fallbackText, diagnostic);
}
