/**
 * Run tsrs — the Rust port of the TypeScript 7 checker — as a second,
 * faster type check next to `tsc`.
 *
 * tsrs 0.18.0 publishes prebuilt binaries only for darwin-arm64 and for
 * Linux x64/arm64 (see its `optionalDependencies`), so every other host
 * skips instead of failing a pre-push check it cannot satisfy.
 */

import { spawnSync } from "node:child_process";

const supported =
  (process.platform === "darwin" && process.arch === "arm64") ||
  (process.platform === "linux" && (process.arch === "x64" || process.arch === "arm64"));

if (!supported) {
  console.log(
    `tsrs: skipped — this tsrs release ships no binary for ${process.platform}-${process.arch}.`,
  );
  process.exit(0);
}

const result = spawnSync("tsrs", ["--noEmit", ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(result.status ?? 1);
