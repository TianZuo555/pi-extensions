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

export function isCommandAvailable(command: string): boolean {
  const exeSuffix = process.platform === "win32" ? ".exe" : "";
  const entries = (process.env.PATH ?? "").split(path.delimiter);
  return entries
    .filter((entry) => entry.length > 0)
    .some((entry) => {
      try {
        accessSync(path.join(entry, `${command}${exeSuffix}`), constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
}

export interface InstallSpec {
  readonly manager: string;
  readonly command: string;
}

export function detectInstallCommand(
  missing: readonly SearchBinary[],
  platform = process.platform,
  checkCommand: (cmd: string) => boolean = isCommandAvailable,
): InstallSpec | undefined {
  if (missing.length === 0) return undefined;

  const needsRg = missing.includes("rg");
  const needsFd = missing.includes("fd");

  if (platform === "darwin") {
    if (checkCommand("brew")) {
      const pkgs = [needsRg ? "ripgrep" : "", needsFd ? "fd" : ""]
        .filter(Boolean)
        .join(" ");
      return { manager: "Homebrew", command: `brew install ${pkgs}` };
    }
    if (checkCommand("port")) {
      const pkgs = [needsRg ? "ripgrep" : "", needsFd ? "fd" : ""]
        .filter(Boolean)
        .join(" ");
      return { manager: "MacPorts", command: `sudo port install ${pkgs}` };
    }
    return undefined;
  }

  if (platform === "win32") {
    if (checkCommand("winget")) {
      const pkgs = [
        needsRg ? "BurntSushi.ripgrep.MSVC" : "",
        needsFd ? "sharkdp.fd" : "",
      ]
        .filter(Boolean)
        .join(" ");
      return { manager: "winget", command: `winget install ${pkgs}` };
    }
    if (checkCommand("choco")) {
      const pkgs = [needsRg ? "ripgrep" : "", needsFd ? "fd" : ""]
        .filter(Boolean)
        .join(" ");
      return { manager: "Chocolatey", command: `choco install -y ${pkgs}` };
    }
    if (checkCommand("scoop")) {
      const pkgs = [needsRg ? "ripgrep" : "", needsFd ? "fd" : ""]
        .filter(Boolean)
        .join(" ");
      return { manager: "Scoop", command: `scoop install ${pkgs}` };
    }
    return undefined;
  }

  // Linux and other Unix-like platforms
  if (checkCommand("brew")) {
    const pkgs = [needsRg ? "ripgrep" : "", needsFd ? "fd" : ""]
      .filter(Boolean)
      .join(" ");
    return { manager: "Homebrew", command: `brew install ${pkgs}` };
  }
  if (checkCommand("apt-get")) {
    const pkgs = [needsRg ? "ripgrep" : "", needsFd ? "fd-find" : ""]
      .filter(Boolean)
      .join(" ");
    return {
      manager: "APT",
      command: `sudo apt-get update && sudo apt-get install -y ${pkgs}`,
    };
  }
  if (checkCommand("pacman")) {
    const pkgs = [needsRg ? "ripgrep" : "", needsFd ? "fd" : ""]
      .filter(Boolean)
      .join(" ");
    return {
      manager: "Pacman",
      command: `sudo pacman -S --noconfirm ${pkgs}`,
    };
  }
  if (checkCommand("dnf")) {
    const pkgs = [needsRg ? "ripgrep" : "", needsFd ? "fd-find" : ""]
      .filter(Boolean)
      .join(" ");
    return { manager: "DNF", command: `sudo dnf install -y ${pkgs}` };
  }
  if (checkCommand("zypper")) {
    const pkgs = [needsRg ? "ripgrep" : "", needsFd ? "fd" : ""]
      .filter(Boolean)
      .join(" ");
    return {
      manager: "Zypper",
      command: `sudo zypper install -y ${pkgs}`,
    };
  }
  if (checkCommand("apk")) {
    const pkgs = [needsRg ? "ripgrep" : "", needsFd ? "fd" : ""]
      .filter(Boolean)
      .join(" ");
    return { manager: "APK", command: `apk add ${pkgs}` };
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
    await execAsync(cmd, { timeout: 180_000 });
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
      `pi-find: ${missingText} is missing, but no supported package manager was detected. Please install manually.`,
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
        `Installation completed, but ${remainingText} was not found on PATH. You may need to restart pi or check your PATH.`,
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
