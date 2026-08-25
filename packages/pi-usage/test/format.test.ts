import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderReport } from "../lib/providers.ts";
import { ZAI_CN_PROVIDER_ID, ZAI_PROVIDER_ID } from "../lib/providers.ts";
import { dedupeZaiStates, formatReport, type ProviderState } from "../lib/format.ts";

function report(id: string, name: string): ProviderReport {
  return { id, name, windows: [{ label: "5h tokens", remainingPercent: 59 }], notes: [] };
}

function ready(id: string, name: string): ProviderState {
  return { id, name, status: "ready", report: report(id, name) };
}

test("formatReport separates window rows with a blank line", () => {
  const state: ProviderState = {
    id: "openai-codex",
    name: "OpenAI Codex",
    status: "ready",
    report: {
      id: "openai-codex",
      name: "OpenAI Codex",
      plan: "plus",
      windows: [
        { label: "5h limit", remainingPercent: 78 },
        { label: "Weekly limit", remainingPercent: 60 },
      ],
      notes: ["Credits: 48.2"],
    },
  };
  assert.deepEqual(formatReport(state).split("\n"), [
    "OpenAI Codex · Plus",
    "  5h limit:         [████████████████░░░░] 78% left",
    "",
    "  Weekly limit:     [████████████░░░░░░░░] 60% left",
    "  Credits: 48.2",
  ]);
});

test("formatReport keeps single-window layouts unchanged", () => {
  const single = ready(ZAI_PROVIDER_ID, "GLM Coding Plan");
  const formatted = formatReport(single);
  assert.ok(formatted.includes("5h tokens"));
  assert.ok(!formatted.includes("\n\n"));
});

test("dedupeZaiStates keeps everything when the keys differ", () => {
  const states = [
    ready(ZAI_PROVIDER_ID, "GLM Coding Plan"),
    ready(ZAI_CN_PROVIDER_ID, "GLM Coding Plan (China)"),
  ];
  assert.deepEqual(dedupeZaiStates(states, undefined, false), states);
});

test("dedupeZaiStates collapses to one state when the key is shared", () => {
  const zai = ready(ZAI_PROVIDER_ID, "GLM Coding Plan");
  const cn = ready(ZAI_CN_PROVIDER_ID, "GLM Coding Plan (China)");
  assert.deepEqual(dedupeZaiStates([zai, cn], undefined, true), [zai]);
});

test("dedupeZaiStates prefers the active model's region when both are ready", () => {
  const zai = ready(ZAI_PROVIDER_ID, "GLM Coding Plan");
  const cn = ready(ZAI_CN_PROVIDER_ID, "GLM Coding Plan (China)");
  assert.deepEqual(dedupeZaiStates([zai, cn], ZAI_CN_PROVIDER_ID, true), [cn]);
  assert.deepEqual(dedupeZaiStates([zai, cn], ZAI_PROVIDER_ID, true), [zai]);
});

test("dedupeZaiStates keeps the successful region when the other query failed", () => {
  const zai: ProviderState = {
    id: ZAI_PROVIDER_ID,
    name: "GLM Coding Plan",
    status: "error",
    message: "401 Unauthorized",
  };
  const cn = ready(ZAI_CN_PROVIDER_ID, "GLM Coding Plan (China)");
  assert.deepEqual(dedupeZaiStates([zai, cn], undefined, true), [cn]);
  assert.deepEqual(dedupeZaiStates([zai, cn], ZAI_PROVIDER_ID, true), [cn]);
});

test("dedupeZaiStates leaves other providers and partial results alone", () => {
  const codex = ready("openai-codex", "OpenAI Codex");
  const zai = ready(ZAI_PROVIDER_ID, "GLM Coding Plan");
  assert.deepEqual(dedupeZaiStates([codex, zai], undefined, true), [codex, zai]);

  const bothFailed: ProviderState[] = [
    { id: ZAI_PROVIDER_ID, name: "GLM Coding Plan", status: "error", message: "401" },
    { id: ZAI_CN_PROVIDER_ID, name: "GLM Coding Plan (China)", status: "error", message: "401" },
  ];
  assert.equal(dedupeZaiStates(bothFailed, undefined, true).length, 1);
});
