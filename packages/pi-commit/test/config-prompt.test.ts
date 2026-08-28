import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_COMMIT_MODEL, parseModelReference, resolveCommitSettings } from "../lib/config.ts";
import { truncateUtf8, type StagedSnapshot } from "../lib/git.ts";
import {
  buildCommitAllPrompt,
  buildCommitPrompt,
  normalizeEditedCommitMessage,
  normalizeGeneratedCommitMessage,
  normalizeGeneratedCommitPlan,
} from "../lib/prompt.ts";

test("commit settings default to DeepSeek V4 Flash", () => {
  const resolved = resolveCommitSettings({});
  assert.equal(resolved.model.value, DEFAULT_COMMIT_MODEL);
  assert.deepEqual(resolved.warnings, []);
});

test("trusted project commit settings override the global settings", () => {
  const resolved = resolveCommitSettings(
    { piCommit: { model: "anthropic/claude-sonnet", thinkingLevel: "low" } },
    {
      piCommit: {
        model: "openai-codex/gpt-5.6-luna",
        thinkingLevel: "max",
      },
    },
  );
  assert.equal(resolved.model.provider, "openai-codex");
  assert.equal(resolved.model.id, "gpt-5.6-luna");
  assert.equal(resolved.thinkingLevel, "max");
});

test("fallback model and fallback thinking level resolve with project overrides", () => {
  const resolved = resolveCommitSettings(
    {
      piCommit: {
        model: "openai/gpt-test",
        fallbackModel: "deepseek/deepseek-v4-flash",
        fallbackThinkingLevel: "low",
      },
    },
    {
      piCommit: {
        fallbackModel: "anthropic/claude-sonnet",
        fallbackThinkingLevel: "high",
      },
    },
  );
  assert.equal(resolved.fallbackModel?.value, "anthropic/claude-sonnet");
  assert.equal(resolved.fallbackThinkingLevel, "high");
});

test("invalid fallback model is reported without blocking the primary model", () => {
  const resolved = resolveCommitSettings({
    piCommit: { model: "openai/gpt-test", fallbackModel: "missing-provider" },
  });
  assert.equal(resolved.model.value, "openai/gpt-test");
  assert.equal(resolved.fallbackModel, undefined);
  assert.match(resolved.warnings.join("\n"), /fallbackModel/);
});

test("invalid commit thinking levels are reported", () => {
  const resolved = resolveCommitSettings(
    { piCommit: { model: "openai/gpt-test", thinkingLevel: "max" } },
    { piCommit: { thinkingLevel: "turbo" } },
  );
  assert.equal(resolved.thinkingLevel, "max");
  assert.match(resolved.warnings.join("\n"), /thinkingLevel/);
});

test("invalid project model is reported alongside the otherwise resolved global model", () => {
  const resolved = resolveCommitSettings(
    { piCommit: { model: "openai/gpt-test" } },
    { piCommit: { model: "missing-provider" } },
  );
  assert.equal(resolved.model.value, "openai/gpt-test");
  assert.match(resolved.warnings.join("\n"), /provider\/model/);
});

test("model references preserve slashes inside the model ID", () => {
  assert.deepEqual(parseModelReference(" openrouter/anthropic/claude-sonnet "), {
    provider: "openrouter",
    id: "anthropic/claude-sonnet",
    value: "openrouter/anthropic/claude-sonnet",
  });
});

test("generated commit messages shed common model wrappers", () => {
  assert.equal(
    normalizeGeneratedCommitMessage(
      "```text\nfeat: add commit workflow\n\nKeep staging explicit.\n```",
    ),
    "feat: add commit workflow\n\nKeep staging explicit.",
  );
  assert.equal(
    normalizeGeneratedCommitMessage("Commit message: fix: preserve staged files"),
    "fix: preserve staged files",
  );
});

test("edited commit messages reject empty and NUL content", () => {
  assert.throws(() => normalizeEditedCommitMessage("  \n"), /cannot be empty/);
  assert.throws(() => normalizeEditedCommitMessage("bad\0message"), /NUL/);
});

test("UTF-8 truncation does not split a multibyte character", () => {
  const value = "abc😀def";
  const truncated = truncateUtf8(value, 5);
  assert.equal(truncated.text, "abc");
  assert.equal(truncated.totalBytes, Buffer.byteLength(value));
  assert.equal(truncated.omittedBytes, Buffer.byteLength("😀def"));
});

test("commit prompt labels truncation and user guidance", () => {
  const snapshot: StagedSnapshot = {
    branch: "main",
    fingerprint: { head: "head", tree: "tree" },
    paths: ["src/index.ts"],
    nameStatus: "M\tsrc/index.ts",
    stat: "1 file changed, 1 insertion(+)",
    patch: "+new line",
    patchBytes: 1000,
    omittedPatchBytes: 900,
    recentCommitSubjects: "chore: previous",
  };

  const prompt = buildCommitPrompt(snapshot, "focus on the user-facing behavior");
  assert.match(prompt, /focus on the user-facing behavior/);
  assert.match(prompt, /900 of 1000 UTF-8 bytes omitted/);
  assert.match(prompt, /M\tsrc\/index\.ts/);
});

test("commit-all prompt requests whole-file logical commit groups", () => {
  const snapshot: StagedSnapshot = {
    branch: "main",
    fingerprint: { head: "head", tree: "tree" },
    paths: ["src/feature.ts", "test/feature.test.ts"],
    nameStatus: "M\tsrc/feature.ts\nM\ttest/feature.test.ts",
    stat: "2 files changed, 4 insertions(+)",
    patch: "+feature",
    patchBytes: 1000,
    omittedPatchBytes: 0,
    recentCommitSubjects: "feat: previous",
  };

  const prompt = buildCommitAllPrompt(snapshot, "split independent changes");
  assert.match(prompt, /separating independent features and logic changes/);
  assert.match(prompt, /src\/feature\.ts/);
  assert.match(prompt, /test\/feature\.test\.ts/);
});

test("generated commit plans cover each staged path exactly once", () => {
  const plan = normalizeGeneratedCommitPlan(
    '{"commits":[{"paths":["src/feature.ts"],"message":"feat: add feature"},{"paths":["test/feature.test.ts"],"message":"test: cover feature"}]}',
    ["src/feature.ts", "test/feature.test.ts"],
  );
  assert.deepEqual(
    plan.commits.map((commit) => commit.paths),
    [["src/feature.ts"], ["test/feature.test.ts"]],
  );
  assert.throws(
    () =>
      normalizeGeneratedCommitPlan(
        '{"commits":[{"paths":["src/feature.ts", "src/feature.ts"],"message":"bad"}]}',
        ["src/feature.ts"],
      ),
    /duplicate path/,
  );
  assert.throws(
    () =>
      normalizeGeneratedCommitPlan('{"commits":[{"paths":["src/feature.ts"],"message":"bad"}]}', [
        "src/feature.ts",
        "test/feature.test.ts",
      ]),
    /omitted staged path/,
  );
});
