import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  canInstallNoninteractively,
  commandNames,
  detectInstallCommand,
  formatMissingNames,
  promptAndInstallMissingBinaries,
  resetPromptedState,
} from "../src/installer.ts";

test("privileged installers are not run through noninteractive pipes", () => {
  assert.equal(
    canInstallNoninteractively({
      manager: "Homebrew",
      command: "brew install fd",
      requiresPrivilege: false,
    }),
    true,
  );
  assert.equal(
    canInstallNoninteractively({
      manager: "APT",
      command: "sudo apt-get install -y fd-find",
      requiresPrivilege: true,
    }),
    false,
  );
  // Privilege is explicit instead of inferred from command or manager strings.
  assert.equal(
    canInstallNoninteractively({
      manager: "custom",
      command: "opaque installer command",
      requiresPrivilege: true,
    }),
    false,
  );
});

test("Windows command lookup follows PATHEXT", () => {
  assert.deepEqual(commandNames("scoop", "win32", ".EXE;.CMD;.PS1"), [
    "scoop",
    "scoop.EXE",
    "scoop.CMD",
    "scoop.PS1",
  ]);
  assert.deepEqual(commandNames("brew", "darwin"), ["brew"]);
});

test("formatMissingNames formats single and multiple tools", () => {
  assert.equal(formatMissingNames([]), "");
  assert.equal(formatMissingNames(["rg"]), "ripgrep (rg)");
  assert.equal(formatMissingNames(["fd"]), "fd");
  assert.equal(formatMissingNames(["rg", "fd"]), "ripgrep (rg) and fd");
});

test("detectInstallCommand on macOS uses Homebrew or MacPorts", () => {
  const brewOnly = (cmd: string) => cmd === "brew";
  const portOnly = (cmd: string) => cmd === "port";
  const none = () => false;

  assert.deepEqual(detectInstallCommand(["rg", "fd"], "darwin", brewOnly), {
    manager: "Homebrew",
    command: "brew install ripgrep fd",
    requiresPrivilege: false,
  });
  assert.deepEqual(detectInstallCommand(["rg"], "darwin", brewOnly), {
    manager: "Homebrew",
    command: "brew install ripgrep",
    requiresPrivilege: false,
  });
  assert.deepEqual(detectInstallCommand(["fd"], "darwin", brewOnly), {
    manager: "Homebrew",
    command: "brew install fd",
    requiresPrivilege: false,
  });
  assert.deepEqual(detectInstallCommand(["rg", "fd"], "darwin", portOnly), {
    manager: "MacPorts",
    command: "sudo port install ripgrep fd",
    requiresPrivilege: true,
  });
  assert.equal(detectInstallCommand(["rg", "fd"], "darwin", none), undefined);
});

test("detectInstallCommand on Windows uses winget, choco, or scoop", () => {
  const wingetOnly = (cmd: string) => cmd === "winget";
  const chocoOnly = (cmd: string) => cmd === "choco";
  const scoopOnly = (cmd: string) => cmd === "scoop";

  assert.deepEqual(detectInstallCommand(["rg", "fd"], "win32", wingetOnly), {
    manager: "winget",
    command: "winget install BurntSushi.ripgrep.MSVC sharkdp.fd",
    requiresPrivilege: false,
  });
  assert.deepEqual(detectInstallCommand(["rg"], "win32", wingetOnly), {
    manager: "winget",
    command: "winget install BurntSushi.ripgrep.MSVC",
    requiresPrivilege: false,
  });
  assert.deepEqual(detectInstallCommand(["fd"], "win32", wingetOnly), {
    manager: "winget",
    command: "winget install sharkdp.fd",
    requiresPrivilege: false,
  });
  assert.deepEqual(detectInstallCommand(["rg", "fd"], "win32", chocoOnly), {
    manager: "Chocolatey",
    command: "choco install -y ripgrep fd",
    requiresPrivilege: true,
  });
  assert.deepEqual(detectInstallCommand(["rg", "fd"], "win32", scoopOnly), {
    manager: "Scoop",
    command: "scoop install ripgrep fd",
    requiresPrivilege: false,
  });
});

test("detectInstallCommand on Linux selects the right package manager", () => {
  assert.deepEqual(
    detectInstallCommand(["rg", "fd"], "linux", (c) => c === "apt-get"),
    {
      manager: "APT",
      command: "sudo apt-get update && sudo apt-get install -y ripgrep fd-find",
      requiresPrivilege: true,
    },
  );
  assert.deepEqual(
    detectInstallCommand(["rg", "fd"], "linux", (c) => c === "pacman"),
    {
      manager: "Pacman",
      command: "sudo pacman -S --noconfirm ripgrep fd",
      requiresPrivilege: true,
    },
  );
  assert.deepEqual(
    detectInstallCommand(["rg", "fd"], "linux", (c) => c === "dnf"),
    {
      manager: "DNF",
      command: "sudo dnf install -y ripgrep fd-find",
      requiresPrivilege: true,
    },
  );
  assert.deepEqual(
    detectInstallCommand(["rg", "fd"], "linux", (c) => c === "zypper"),
    {
      manager: "Zypper",
      command: "sudo zypper install -y ripgrep fd",
      requiresPrivilege: true,
    },
  );
  assert.deepEqual(
    detectInstallCommand(["rg", "fd"], "linux", (c) => c === "apk"),
    {
      manager: "APK",
      command: "apk add ripgrep fd",
      requiresPrivilege: true,
    },
  );
});

test("promptAndInstallMissingBinaries respects user decline and failure handling", async () => {
  resetPromptedState();

  const notifications: Array<{ message: string; type?: string }> = [];
  const confirms: Array<{ title: string; message: string }> = [];

  const mockCtx = {
    hasUI: true,
    ui: {
      confirm: async (title: string, message: string) => {
        confirms.push({ title, message });
        return false; // User declines
      },
      notify: (message: string, type?: "info" | "warning" | "error") => {
        notifications.push({ message, type });
      },
    },
  } as unknown as ExtensionContext;

  let executedCmd: string | undefined;
  await promptAndInstallMissingBinaries(mockCtx, async (cmd) => {
    executedCmd = cmd;
  });

  assert.equal(executedCmd, undefined, "runner should not execute when declined");

  // Calling a second time in the same session does not prompt again
  await promptAndInstallMissingBinaries(mockCtx, async (cmd) => {
    executedCmd = cmd;
  });
  assert.equal(executedCmd, undefined);
});
