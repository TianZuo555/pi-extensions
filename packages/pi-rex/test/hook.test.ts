import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
  BLOCK_END,
  BLOCK_START,
  HOOKS,
  HOOK_MARKER,
  detectShell,
  hookTarget,
  installShellHook,
  upsertBlock,
} from "../lib/hook.ts";

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "pi-rex-hook-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const fishFile = () => path.join(dir, "config", "fish", "conf.d", "rex-resume.fish");
const fishEnv = (): NodeJS.ProcessEnv => ({
  SHELL: "/opt/homebrew/bin/fish",
  XDG_CONFIG_HOME: path.join(dir, "config"),
});

test("reads the shell from SHELL", () => {
  assert.equal(detectShell({ SHELL: "/opt/homebrew/bin/fish" }), "fish");
  assert.equal(detectShell({ SHELL: "/bin/zsh" }), "zsh");
  assert.equal(detectShell({ SHELL: "/usr/local/bin/bash" }), "bash");
  assert.equal(detectShell({ SHELL: "C:\\Program Files\\Git\\bin\\bash.exe" }), "bash");
  assert.equal(detectShell({ SHELL: "/bin/sh" }), undefined);
  assert.equal(detectShell({ SHELL: "/usr/bin/pwsh" }), undefined);
  assert.equal(detectShell({}), undefined);
});

test("puts the fish hook in conf.d below XDG_CONFIG_HOME", () => {
  assert.equal(hookTarget("fish", fishEnv(), "/home/you").path, fishFile());
  assert.equal(hookTarget("fish", fishEnv(), "/home/you").kind, "drop-in");
  assert.equal(
    hookTarget("fish", { SHELL: "fish" }, "/home/you").path,
    "/home/you/.config/fish/conf.d/rex-resume.fish",
  );
});

test("puts the zsh hook in .zshrc, and follows ZDOTDIR", () => {
  assert.equal(hookTarget("zsh", { SHELL: "zsh" }, "/home/you").path, "/home/you/.zshrc");
  assert.equal(
    hookTarget("zsh", { SHELL: "zsh", ZDOTDIR: path.join(dir, "zdot") }, "/home/you").path,
    path.join(dir, "zdot", ".zshrc"),
  );
});

test("puts the bash hook in the file a login shell reads first", () => {
  const home = path.join(dir, "home");
  mkdirSync(home, { recursive: true });
  // Nothing exists: .profile, because a new .bash_profile would hide .profile.
  assert.equal(hookTarget("bash", { SHELL: "bash" }, home).path, path.join(home, ".profile"));
  writeFileSync(path.join(home, ".profile"), "");
  assert.equal(hookTarget("bash", { SHELL: "bash" }, home).path, path.join(home, ".profile"));
  writeFileSync(path.join(home, ".bash_login"), "");
  assert.equal(hookTarget("bash", { SHELL: "bash" }, home).path, path.join(home, ".bash_login"));
  writeFileSync(path.join(home, ".bash_profile"), "");
  assert.equal(hookTarget("bash", { SHELL: "bash" }, home).path, path.join(home, ".bash_profile"));
});

test("appends the marked block to a startup file", () => {
  assert.equal(upsertBlock("", "HOOK"), `${BLOCK_START}\nHOOK\n${BLOCK_END}\n`);
  assert.equal(
    upsertBlock("export A=1\n", "HOOK"),
    `export A=1\n\n${BLOCK_START}\nHOOK\n${BLOCK_END}\n`,
  );
  assert.equal(
    upsertBlock("export A=1", "HOOK"),
    `export A=1\n\n${BLOCK_START}\nHOOK\n${BLOCK_END}\n`,
  );
});

test("replaces an old block and keeps the rest of the file", () => {
  const before = `export A=1\n`;
  const after = `export B=2\n`;
  const old = `${BLOCK_START}\nOLD\n${BLOCK_END}\n`;
  assert.equal(
    upsertBlock(`${before}${old}${after}`, "HOOK"),
    `${before}${BLOCK_START}\nHOOK\n${BLOCK_END}\n${after}`,
  );
});

test("creates the fish hook file with its marker", () => {
  assert.deepEqual(installShellHook(fishEnv(), dir), { path: fishFile(), status: "created" });
  const text = readFileSync(fishFile(), "utf8");
  assert.ok(text.startsWith(`${HOOK_MARKER}\n`), text);
  assert.ok(text.endsWith(HOOKS.fish), text);
  assert.deepEqual(installShellHook(fishEnv(), dir), { path: fishFile(), status: "kept" });
});

test("creates the zsh hook in an empty startup file", () => {
  const result = installShellHook({ SHELL: "/bin/zsh" }, dir);
  const file = path.join(dir, ".zshrc");
  assert.deepEqual(result, { path: file, status: "created" });
  const text = readFileSync(file, "utf8");
  assert.ok(text.startsWith(`${BLOCK_START}\n`), text);
  assert.ok(text.includes("REX_BLOCK"), text);
  assert.deepEqual(installShellHook({ SHELL: "/bin/zsh" }, dir), { path: file, status: "kept" });
});

test("adds the block below what the user already has", () => {
  const file = path.join(dir, ".zshrc");
  writeFileSync(file, "export A=1\n");
  assert.deepEqual(installShellHook({ SHELL: "/bin/zsh" }, dir), { path: file, status: "updated" });
  assert.ok(readFileSync(file, "utf8").startsWith("export A=1\n"), readFileSync(file, "utf8"));
});

test("updates a block this extension wrote earlier", () => {
  const file = path.join(dir, ".zshrc");
  writeFileSync(file, `export A=1\n${BLOCK_START}\nOLD\n${BLOCK_END}\n`);
  assert.deepEqual(installShellHook({ SHELL: "/bin/zsh" }, dir), { path: file, status: "updated" });
  assert.ok(readFileSync(file, "utf8").endsWith(`${BLOCK_END}\n`));
});

test("keeps a fish hook file the user wrote", () => {
  mkdirSync(path.dirname(fishFile()), { recursive: true });
  writeFileSync(fishFile(), "# my own hook\n");
  assert.deepEqual(installShellHook(fishEnv(), dir), { path: fishFile(), status: "kept" });
  assert.equal(readFileSync(fishFile(), "utf8"), "# my own hook\n");
});

test("does nothing for a shell without a hook", () => {
  assert.equal(installShellHook({ SHELL: "/bin/sh" }, dir), undefined);
  assert.equal(installShellHook({}, dir), undefined);
  assert.ok(!existsSync(path.join(dir, ".profile")));
});

test("survives a folder that cannot be written", () => {
  mkdirSync(path.join(dir, "config", "fish"), { recursive: true });
  writeFileSync(path.join(dir, "config", "fish", "conf.d"), "");
  assert.equal(installShellHook(fishEnv(), dir), undefined);
});
