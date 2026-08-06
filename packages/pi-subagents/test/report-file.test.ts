import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
  buildHandoffInstructions,
  readReportFile,
  reportPathFor,
  semanticReportFromFile,
} from "../lib/report-file.ts";

function tempArtifactRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-report-"));
}

describe("report-file", () => {
  it("reportPathFor creates a private run directory", () => {
    const root = tempArtifactRoot();
    const reportPath = reportPathFor(root, "sa-test123");
    assert.equal(reportPath, path.join(root, "runs", "sa-test123", "report.json"));
    const mode = fs.statSync(path.join(root, "runs", "sa-test123")).mode & 0o777;
    assert.equal(mode, 0o700);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("buildHandoffInstructions names the report path and schema", () => {
    const text = buildHandoffInstructions("/tmp/report.json");
    assert.match(text, /## Required handoff/);
    assert.match(text, /\/tmp\/report\.json/);
    assert.match(text, /Do not print the JSON/);
  });

  it("readReportFile returns missing when the file does not exist", () => {
    const root = tempArtifactRoot();
    const reportPath = reportPathFor(root, "sa-missing");
    const outcome = readReportFile(reportPath);
    assert.equal(outcome.kind, "missing");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("readReportFile returns invalid for oversized files without reading content", () => {
    const root = tempArtifactRoot();
    const reportPath = reportPathFor(root, "sa-big");
    fs.writeFileSync(reportPath, "x".repeat(300_000), { mode: 0o600 });
    const outcome = readReportFile(reportPath);
    assert.equal(outcome.kind, "invalid");
    if (outcome.kind === "invalid") {
      assert.match(outcome.reason, /exceeds/);
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("readReportFile returns invalid for unparseable JSON", () => {
    const root = tempArtifactRoot();
    const reportPath = reportPathFor(root, "sa-bad-json");
    fs.writeFileSync(reportPath, "{not-json", { mode: 0o600 });
    const outcome = readReportFile(reportPath);
    assert.equal(outcome.kind, "invalid");
    if (outcome.kind === "invalid") {
      assert.match(outcome.reason, /not valid JSON/);
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("readReportFile returns invalid when schema validation fails", () => {
    const root = tempArtifactRoot();
    const reportPath = reportPathFor(root, "sa-bad-schema");
    fs.writeFileSync(reportPath, JSON.stringify({ status: "completed", summary: 123 }), {
      mode: 0o600,
    });
    const outcome = readReportFile(reportPath);
    assert.equal(outcome.kind, "invalid");
    if (outcome.kind === "invalid") {
      assert.match(outcome.reason, /schema/);
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("readReportFile returns valid for a schema-compliant report", () => {
    const root = tempArtifactRoot();
    const reportPath = reportPathFor(root, "sa-valid");
    fs.writeFileSync(
      reportPath,
      JSON.stringify({ status: "completed", summary: "all good" }),
      { mode: 0o600 },
    );
    const outcome = readReportFile(reportPath);
    assert.equal(outcome.kind, "valid");
    if (outcome.kind === "valid") {
      assert.equal(outcome.report.summary, "all good");
      const semantic = semanticReportFromFile(outcome, "fallback", "diag");
      assert.equal(semantic.kind, "structured");
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
});
