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
const fishContext = () => ({
  env: { SHELL: "/opt/homebrew/bin/fish", XDG_CONFIG_HOME: path.join(dir, "config") },
  home: dir,
});

test("reads the shell from SHELL", () => {
  const shell = (SHELL: string) => detectShell({ env: { SHELL } });
  assert.equal(shell("/opt/homebrew/bin/fish"), "fish");
  assert.equal(shell("/bin/zsh"), "zsh");
  assert.equal(shell("/usr/local/bin/bash"), "bash");
  assert.equal(shell("C:\\Program Files\\Git\\bin\\bash.exe"), "bash");
  assert.equal(shell("/usr/bin/pwsh"), "powershell");
  assert.equal(shell("C:\\Program Files\\PowerShell\\7\\powershell.exe"), "powershell");
  assert.equal(shell("/bin/sh"), undefined);
  assert.equal(detectShell({ env: {} }), undefined);
});

test("reads PowerShell on Windows from PSModulePath", () => {
  const env = { PSModulePath: "C:\\Program Files\\WindowsPowerShell\\Modules" };
  assert.equal(detectShell({ env, platform: "win32" }), "powershell");
  // The same variable can exist on macOS, so the platform decides.
  assert.equal(detectShell({ env, platform: "darwin" }), undefined);
  assert.equal(detectShell({ env: { ...env, SHELL: "/bin/zsh" }, platform: "win32" }), "zsh");
});

test("puts the fish hook in conf.d below XDG_CONFIG_HOME", () => {
  assert.deepEqual(hookTarget("fish", fishContext()), { path: fishFile(), kind: "drop-in" });
  assert.deepEqual(hookTarget("fish", { env: { SHELL: "fish" }, home: "/home/you" }), {
    path: path.join("/home/you", ".config", "fish", "conf.d", "rex-resume.fish"),
    kind: "drop-in",
  });
});

test("puts the zsh hook in .zshrc, and follows ZDOTDIR", () => {
  assert.equal(hookTarget("zsh", { home: "/home/you" }).path, path.join("/home/you", ".zshrc"));
  assert.equal(
    hookTarget("zsh", { env: { ZDOTDIR: path.join(dir, "zdot") }, home: "/home/you" }).path,
    path.join(dir, "zdot", ".zshrc"),
  );
});

test("puts the bash hook in the file a login shell reads first", () => {
  const home = path.join(dir, "home");
  mkdirSync(home, { recursive: true });
  const target = () => hookTarget("bash", { home }).path;
  // Nothing exists: .profile, because a new .bash_profile would hide .profile.
  assert.equal(target(), path.join(home, ".profile"));
  writeFileSync(path.join(home, ".profile"), "");
  assert.equal(target(), path.join(home, ".profile"));
  writeFileSync(path.join(home, ".bash_login"), "");
  assert.equal(target(), path.join(home, ".bash_login"));
  writeFileSync(path.join(home, ".bash_profile"), "");
  assert.equal(target(), path.join(home, ".bash_profile"));
});

test("puts the PowerShell hook in $PROFILE for the platform", () => {
  const home = path.join(dir, "home");
  assert.equal(
    hookTarget("powershell", {
      env: { XDG_CONFIG_HOME: path.join(dir, "config") },
      home,
      platform: "darwin",
    }).path,
    path.join(dir, "config", "powershell", "profile.ps1"),
  );
  assert.equal(
    hookTarget("powershell", { home, platform: "win32" }).path,
    path.join(home, "Documents", "PowerShell", "profile.ps1"),
  );
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
  const before = "export A=1\n";
  const after = "export B=2\n";
  const old = `${BLOCK_START}\nOLD\n${BLOCK_END}\n`;
  assert.equal(
    upsertBlock(`${before}${old}${after}`, "HOOK"),
    `${before}${BLOCK_START}\nHOOK\n${BLOCK_END}\n${after}`,
  );
});

test("creates the fish hook file with its marker", () => {
  assert.deepEqual(installShellHook(fishContext()), { path: fishFile(), status: "created" });
  const text = readFileSync(fishFile(), "utf8");
  assert.ok(text.startsWith(`${HOOK_MARKER}\n`), text);
  assert.ok(text.endsWith(HOOKS.fish), text);
  assert.deepEqual(installShellHook(fishContext()), { path: fishFile(), status: "kept" });
});

test("creates the zsh hook in an empty startup file", () => {
  const file = path.join(dir, ".zshrc");
  const context = { env: { SHELL: "/bin/zsh" }, home: dir };
  assert.deepEqual(installShellHook(context), { path: file, status: "created" });
  const text = readFileSync(file, "utf8");
  assert.ok(text.startsWith(`${BLOCK_START}\n`), text);
  assert.ok(text.includes("REX_BLOCK"), text);
  assert.deepEqual(installShellHook(context), { path: file, status: "kept" });
});

test("adds the block below what the user already has", () => {
  const file = path.join(dir, ".zshrc");
  writeFileSync(file, "export A=1\n");
  const context = { env: { SHELL: "/bin/zsh" }, home: dir };
  assert.deepEqual(installShellHook(context), { path: file, status: "updated" });
  assert.ok(readFileSync(file, "utf8").startsWith("export A=1\n"), readFileSync(file, "utf8"));
});

test("updates a block this extension wrote earlier", () => {
  const file = path.join(dir, ".zshrc");
  writeFileSync(file, `export A=1\n${BLOCK_START}\nOLD\n${BLOCK_END}\n`);
  const context = { env: { SHELL: "/bin/zsh" }, home: dir };
  assert.deepEqual(installShellHook(context), { path: file, status: "updated" });
  assert.ok(readFileSync(file, "utf8").endsWith(`${BLOCK_END}\n`));
});

test("creates the PowerShell profile with the block", () => {
  const file = path.join(dir, "config", "powershell", "profile.ps1");
  const context = {
    env: { SHELL: "/usr/bin/pwsh", XDG_CONFIG_HOME: path.join(dir, "config") },
    home: dir,
    platform: "darwin" as const,
  };
  assert.deepEqual(installShellHook(context), { path: file, status: "created" });
  const text = readFileSync(file, "utf8");
  assert.ok(text.startsWith(`${BLOCK_START}\n`), text);
  assert.ok(text.includes("$env:REX_BLOCK"), text);
  assert.ok(text.endsWith(`${BLOCK_END}\n`), text);
});

test("keeps a fish hook file the user wrote", () => {
  mkdirSync(path.dirname(fishFile()), { recursive: true });
  writeFileSync(fishFile(), "# my own hook\n");
  assert.deepEqual(installShellHook(fishContext()), { path: fishFile(), status: "kept" });
  assert.equal(readFileSync(fishFile(), "utf8"), "# my own hook\n");
});

test("does nothing for a shell without a hook", () => {
  assert.equal(installShellHook({ env: { SHELL: "/bin/sh" }, home: dir }), undefined);
  assert.equal(installShellHook({ env: {}, home: dir }), undefined);
  assert.ok(!existsSync(path.join(dir, ".profile")));
});

test("survives a folder that cannot be written", () => {
  mkdirSync(path.join(dir, "config", "fish"), { recursive: true });
  writeFileSync(path.join(dir, "config", "fish", "conf.d"), "");
  assert.equal(installShellHook(fishContext()), undefined);
});
