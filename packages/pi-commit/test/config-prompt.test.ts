import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_COMMIT_MODEL,
  parseModelReference,
  resolveCommitSettings,
} from "../lib/config.ts";
import { truncateUtf8, type StagedSnapshot } from "../lib/git.ts";
import {
  buildCommitPrompt,
  normalizeEditedCommitMessage,
  normalizeGeneratedCommitMessage,
} from "../lib/prompt.ts";

test("commit settings default to DeepSeek V4 Flash", () => {
  const resolved = resolveCommitSettings({});
  assert.equal(resolved.model.value, DEFAULT_COMMIT_MODEL);
  assert.deepEqual(resolved.warnings, []);
});

test("trusted project commit model overrides the global model", () => {
  const resolved = resolveCommitSettings(
    { piCommit: { model: "anthropic/claude-sonnet" } },
    { piCommit: { model: "deepseek/deepseek-v4-flash" } },
  );
  assert.equal(resolved.model.provider, "deepseek");
  assert.equal(resolved.model.id, "deepseek-v4-flash");
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
    normalizeGeneratedCommitMessage("```text\nfeat: add commit workflow\n\nKeep staging explicit.\n```"),
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
