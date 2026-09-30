import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  isolateProviderEnv,
  PROVIDER_ENV_PREFIXES,
  restoreProviderEnv,
  snapshotProviderEnv,
} from "./helpers.ts";

isolateProviderEnv();

const packageRoot = path.resolve(import.meta.dirname, "..");

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith(".ts") ? [full] : [];
  });
}

test("every provider env var the source reads has a prefix the tests scrub", () => {
  const files = [
    path.join(packageRoot, "index.ts"),
    ...sourceFiles(path.join(packageRoot, "lib")),
    ...sourceFiles(path.join(packageRoot, "src")),
  ];
  const names = new Set<string>();
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    // Literal reads, plus API-key names passed to the generic resolvers as strings.
    for (const match of text.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) names.add(match[1]);
    for (const match of text.matchAll(/\b[A-Z][A-Z0-9]*_API_KEY\b/g)) names.add(match[0]);
  }

  assert.ok(names.size >= 10, `scan looks broken, found only: ${[...names].join(", ")}`);
  const unscrubbed = [...names].filter(
    (name) => !PROVIDER_ENV_PREFIXES.some((prefix) => name.startsWith(prefix)),
  );
  assert.deepEqual(
    unscrubbed,
    [],
    "add the provider's prefix to PROVIDER_ENV_PREFIXES in test/helpers.ts",
  );
});

test("restoreProviderEnv puts snapshotted variables back and drops ones added meanwhile", () => {
  process.env.BRAVE_API_KEY = "before";
  const snapshot = snapshotProviderEnv();
  assert.equal(snapshot.BRAVE_API_KEY, "before");

  process.env.BRAVE_API_KEY = "after";
  process.env.TINYFISH_FETCH_URL = "https://fetch.example";
  process.env.UNRELATED_VARIABLE_FOR_TEST = "keep";
  try {
    restoreProviderEnv(snapshot);
    assert.equal(process.env.BRAVE_API_KEY, "before");
    assert.equal(process.env.TINYFISH_FETCH_URL, undefined);
    assert.equal(process.env.UNRELATED_VARIABLE_FOR_TEST, "keep");
  } finally {
    delete process.env.UNRELATED_VARIABLE_FOR_TEST;
  }
});
