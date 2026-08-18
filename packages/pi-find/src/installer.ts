/**
 * Installer helper for rg and fd dependencies.
 *
 * Detects missing binaries at startup, locates available system package managers,
 * and prompts the user via pi's interactive UI to install missing tools.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { exec } from "node:child_process";
import { accessSync, constants } from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import {
  resetBinaryCache,
  resolveBinary,
  type SearchBinary,
} from "./binaries.ts";

const execAsync = promisify(exec);

export function getMissingBinaries(): SearchBinary[] {
  const missing: SearchBinary[] = [];
  if (resolveBinary("rg") === null) missing.push("rg");
  if (resolveBinary("fd") === null) missing.push("fd");
  return missing;
}

export function commandNames(
  command: string,
  platform = process.platform,
  pathExt = process.env.PATHEXT,
): string[] {
  if (platform !== "win32") return [command];
  const extensions = (pathExt ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((extension) => extension.trim())
    .filter((extension) => extension.length > 0)
    .map((extension) => extension.startsWith(".") ? extension : `.${extension}`);
  return [...new Set([command, ...extensions.map((extension) => `${command}${extension}`)])];
}

export function isCommandAvailable(command: string): boolean {
  const entries = (process.env.PATH ?? "").split(path.delimiter);
  const names = commandNames(command);
  return entries
    .filter((entry) => entry.length > 0)
    .some((entry) => names.some((name) => {
      try {
        accessSync(path.join(entry, name), constants.X_OK);
        return true;
      } catch {
        return false;
      }
    }));
}

export interface InstallSpec {
  readonly manager: string;
  readonly command: string;
  readonly requiresPrivilege: boolean;
}

/** Whether the command can run through child_process pipes without a password TTY. */
export function canInstallNoninteractively(spec: InstallSpec): boolean {
  return !spec.requiresPrivilege;
}

export function detectInstallCommand(
  missing: readonly SearchBinary[],
  platform = process.platform,
  checkCommand: (cmd: string) => boolean = isCommandAvailable,
): InstallSpec | undefined {
  if (missing.length === 0) return undefined;

  const packages = (rg: string, fd: string): string => [
    missing.includes("rg") ? rg : "",
    missing.includes("fd") ? fd : "",
  ].filter(Boolean).join(" ");
  const spec = (
    manager: string,
    command: string,
    requiresPrivilege = false,
  ): InstallSpec => ({ manager, command, requiresPrivilege });

  if (platform === "darwin") {
    if (checkCommand("brew")) {
      return spec("Homebrew", `brew install ${packages("ripgrep", "fd")}`);
    }
    if (checkCommand("port")) {
      return spec(
        "MacPorts",
        `sudo port install ${packages("ripgrep", "fd")}`,
        true,
      );
    }
    return undefined;
  }

  if (platform === "win32") {
    if (checkCommand("winget")) {
      return spec(
        "winget",
        `winget install ${packages("BurntSushi.ripgrep.MSVC", "sharkdp.fd")}`,
      );
    }
    if (checkCommand("choco")) {
      return spec(
        "Chocolatey",
        `choco install -y ${packages("ripgrep", "fd")}`,
        true,
      );
    }
    if (checkCommand("scoop")) {
      return spec("Scoop", `scoop install ${packages("ripgrep", "fd")}`);
    }
    return undefined;
  }

  // Linux and other Unix-like platforms
  if (checkCommand("brew")) {
    return spec("Homebrew", `brew install ${packages("ripgrep", "fd")}`);
  }
  if (checkCommand("apt-get")) {
    return spec(
      "APT",
      `sudo apt-get update && sudo apt-get install -y ${packages("ripgrep", "fd-find")}`,
      true,
    );
  }
  if (checkCommand("pacman")) {
    return spec(
      "Pacman",
      `sudo pacman -S --noconfirm ${packages("ripgrep", "fd")}`,
      true,
    );
  }
  if (checkCommand("dnf")) {
    return spec(
      "DNF",
      `sudo dnf install -y ${packages("ripgrep", "fd-find")}`,
      true,
    );
  }
  if (checkCommand("zypper")) {
    return spec(
      "Zypper",
      `sudo zypper install -y ${packages("ripgrep", "fd")}`,
      true,
    );
  }
  if (checkCommand("apk")) {
    return spec("APK", `apk add ${packages("ripgrep", "fd")}`, true);
  }

  return undefined;
}

export function formatMissingNames(missing: readonly SearchBinary[]): string {
  if (missing.length === 0) return "";
  if (missing.length === 1) {
    return missing[0] === "rg" ? "ripgrep (rg)" : "fd";
  }
  return "ripgrep (rg) and fd";
}

let hasPromptedThisSession = false;

export function resetPromptedState(): void {
  hasPromptedThisSession = false;
}

export async function promptAndInstallMissingBinaries(
  ctx: ExtensionContext,
  runner: (cmd: string) => Promise<void> = async (cmd: string) => {
    await execAsync(cmd, {
      timeout: 180_000,
      maxBuffer: 16 * 1024 * 1024,
    });
  },
): Promise<void> {
  if (hasPromptedThisSession) return;

  const missing = getMissingBinaries();
  if (missing.length === 0) return;

  hasPromptedThisSession = true;

  const missingText = formatMissingNames(missing);
  const installSpec = detectInstallCommand(missing);

  if (!installSpec) {
    ctx.ui.notify(
      `pi-find: a supported ${missingText} is unavailable, but no package manager was detected. Please install or upgrade it manually.`,
      "warning",
    );
    return;
  }

  if (!canInstallNoninteractively(installSpec)) {
    // Extension subprocesses are not attached to a terminal, so sudo/password
    // prompts cannot work reliably. Give the user a copyable command instead
    // of hanging until the installer timeout.
    ctx.ui.notify(
      `pi-find requires ${missingText}. Run \`${installSpec.command}\` in a terminal, then retry.`,
      "warning",
    );
    return;
  }

  const title = "Missing search dependencies";
  const message =
    `pi-find requires ${missingText} for workspace search.\n\nRun \`${installSpec.command}\` now?`;

  const confirmed = await ctx.ui.confirm(title, message);
  if (!confirmed) return;

  ctx.ui.notify(`Installing ${missingText} via ${installSpec.manager}...`, "info");

  try {
    await runner(installSpec.command);
    resetBinaryCache();
    const stillMissing = getMissingBinaries();
    if (stillMissing.length === 0) {
      ctx.ui.notify(`Successfully installed ${missingText}!`, "info");
    } else {
      const remainingText = formatMissingNames(stillMissing);
      ctx.ui.notify(
        `Installation completed, but a supported ${remainingText} was not found on PATH. You may need to restart pi or upgrade it manually.`,
        "warning",
      );
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(
      `Failed to install ${missingText}: ${errorMsg}. You can install it manually with \`${installSpec.command}\`.`,
      "error",
    );
  }
}
