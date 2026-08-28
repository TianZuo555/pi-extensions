/**
 * Shared async git subprocess helpers (non-blocking event loop).
 */

import { execFile as execFileCallback, spawn } from "node:child_process";

export const GIT_DEFAULT_TIMEOUT_MS = 30_000;

export function runGitBuffer(
  args: string[],
  cwd: string,
  options?: { timeout?: number; maxBuffer?: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFileCallback(
      "git",
      args,
      { cwd, timeout: options?.timeout, maxBuffer: options?.maxBuffer },
      (error: Error | null, stdout: string | Buffer) => {
        if (error) reject(error);
        else resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout));
      },
    );
  });
}

export function runGitWithInput(
  args: string[],
  cwd: string,
  input: Buffer,
  timeout = GIT_DEFAULT_TIMEOUT_MS,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`git ${args.join(" ")} timed out after ${timeout}ms`));
    }, timeout);

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`git ${args.join(" ")} exited with code ${code ?? "?"}`));
    });

    child.stdin?.end(input);
  });
}

export function runGitText(
  args: string[],
  cwd: string,
  timeout = GIT_DEFAULT_TIMEOUT_MS,
): Promise<string> {
  return runGitBuffer(args, cwd, { timeout }).then((stdout) => stdout.toString().trim());
}
