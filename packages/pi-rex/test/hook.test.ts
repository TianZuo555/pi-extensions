import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { FISH_HOOK, HOOK_MARKER, fishHookPath, installShellHook } from "../lib/hook.ts";

let dir = "";
const env = (): NodeJS.ProcessEnv => ({
  SHELL: "/opt/homebrew/bin/fish",
  XDG_CONFIG_HOME: dir,
});

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "pi-rex-hook-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const file = () => path.join(dir, "fish", "conf.d", "rex-resume.fish");

test("finds the fish hook under XDG_CONFIG_HOME", () => {
  assert.equal(fishHookPath(env()), file());
  assert.equal(fishHookPath({ SHELL: "/bin/zsh", XDG_CONFIG_HOME: dir }), undefined);
  assert.equal(fishHookPath({ XDG_CONFIG_HOME: dir }), undefined);
  // An empty value falls back to the home folder, as fish does.
  assert.match(fishHookPath({ SHELL: "fish", XDG_CONFIG_HOME: "" }) ?? "", /\.config\/fish/);
});

test("creates the hook file with its marker", () => {
  assert.deepEqual(installShellHook(env()), { path: file(), status: "created" });
  const text = readFileSync(file(), "utf8");
  assert.ok(text.startsWith(`${HOOK_MARKER}\n`), text);
  assert.ok(text.includes("--on-event fish_prompt"), text);
  assert.ok(text.endsWith(FISH_HOOK), text);
});

test("keeps the file when it is already right", () => {
  installShellHook(env());
  assert.deepEqual(installShellHook(env()), { path: file(), status: "kept" });
});

test("replaces a hook file this extension wrote earlier", () => {
  mkdirSync(path.dirname(file()), { recursive: true });
  writeFileSync(file(), `${HOOK_MARKER}\nold hook\n`);
  assert.deepEqual(installShellHook(env()), { path: file(), status: "updated" });
  assert.ok(readFileSync(file(), "utf8").endsWith(FISH_HOOK));
});

test("keeps a hook file the user wrote", () => {
  mkdirSync(path.dirname(file()), { recursive: true });
  writeFileSync(file(), "# my own hook\n");
  assert.deepEqual(installShellHook(env()), { path: file(), status: "kept" });
  assert.equal(readFileSync(file(), "utf8"), "# my own hook\n");
});

test("does nothing outside fish", () => {
  assert.equal(installShellHook({ SHELL: "/bin/bash", XDG_CONFIG_HOME: dir }), undefined);
  assert.ok(!existsSync(file()));
});

test("survives a folder that cannot be written", () => {
  // A file where the folder must go makes mkdirSync fail.
  mkdirSync(path.join(dir, "fish"), { recursive: true });
  writeFileSync(path.join(dir, "fish", "conf.d"), "");
  assert.equal(installShellHook(env()), undefined);
});
