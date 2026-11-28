import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  BLOCK_END,
  BLOCK_START,
  fishFile,
  HOOK_MARKER,
  removeBlock,
  removeLegacyResume,
  RESUME_DIR,
} from "../lib/cleanup.ts";

const block = `${BLOCK_START}\nhook line\n${BLOCK_END}`;

function sandbox() {
  const home = mkdtempSync(path.join(os.tmpdir(), "pi-rex-cleanup-"));
  const agentDir = path.join(home, "agent");
  return { home, agentDir, env: {} as NodeJS.ProcessEnv };
}

test("removeBlock removes the block and the blank line before it", () => {
  assert.equal(removeBlock(`export A=1\n\n${block}\n`), "export A=1\n");
  assert.equal(removeBlock(`${block}\n`), "");
  assert.equal(removeBlock(`a\n\n${block}\nb\n`), "a\nb\n");
});

test("removeBlock keeps text without a complete block", () => {
  assert.equal(removeBlock("export A=1\n"), "export A=1\n");
  assert.equal(removeBlock(`${BLOCK_START}\nno end\n`), `${BLOCK_START}\nno end\n`);
});

test("removes the fish file, the shell blocks, and the records", () => {
  const { home, agentDir, env } = sandbox();
  const fish = fishFile(env, home);
  mkdirSync(path.dirname(fish), { recursive: true });
  writeFileSync(fish, `${HOOK_MARKER} Edit or delete this file to stop the hook.\nhook\n`);
  const zshrc = path.join(home, ".zshrc");
  writeFileSync(zshrc, `alias g=git\n\n${block}\n`);
  const records = path.join(agentDir, RESUME_DIR);
  mkdirSync(records, { recursive: true });
  writeFileSync(path.join(records, "01a1"), "/repo\npi\n");

  assert.deepEqual(removeLegacyResume({ agentDir, env, home }), [fish, zshrc]);
  assert.ok(!existsSync(fish));
  assert.equal(readFileSync(zshrc, "utf8"), "alias g=git\n");
  assert.ok(!existsSync(records));
});

test("keeps files that the extension did not write", () => {
  const { home, agentDir, env } = sandbox();
  const fish = fishFile(env, home);
  mkdirSync(path.dirname(fish), { recursive: true });
  writeFileSync(fish, "# my own hook\n");
  const profile = path.join(home, ".profile");
  writeFileSync(profile, "export A=1\n");

  assert.deepEqual(removeLegacyResume({ agentDir, env, home }), []);
  assert.equal(readFileSync(fish, "utf8"), "# my own hook\n");
  assert.equal(readFileSync(profile, "utf8"), "export A=1\n");
});

test("reads XDG_CONFIG_HOME and ZDOTDIR", () => {
  const { home, agentDir } = sandbox();
  const env = { XDG_CONFIG_HOME: path.join(home, "xdg"), ZDOTDIR: path.join(home, "zsh") };
  const fish = path.join(home, "xdg", "fish", "conf.d", "rex-resume.fish");
  const zshrc = path.join(home, "zsh", ".zshrc");
  mkdirSync(path.dirname(fish), { recursive: true });
  mkdirSync(path.dirname(zshrc), { recursive: true });
  writeFileSync(fish, `${HOOK_MARKER}\n`);
  writeFileSync(zshrc, `${block}\n`);

  assert.deepEqual(removeLegacyResume({ agentDir, env, home }), [fish, zshrc]);
});
