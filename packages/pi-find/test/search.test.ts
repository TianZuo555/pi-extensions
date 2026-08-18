/**
 * End-to-end tests against a real fixture tree, running the actual rg and fd
 * binaries. These are the tests that catch flag mistakes: unit tests on the
 * DSL cannot tell whether ripgrep interprets the globs the way we intend.
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, before, test } from "node:test";
import { resolveBinary } from "../src/binaries.ts";
import {
  createSearchRuntime,
  rgTypeGlobs,
  runSearch,
  SearchRuntime,
  type SearchRuntimeInstance,
} from "../src/runtime.ts";

let root: string;
let runtime: SearchRuntimeInstance;

const hasRg = resolveBinary("rg") !== null;
const hasFd = resolveBinary("fd") !== null;

before(() => {
  root = mkdtempSync(path.join(tmpdir(), "pi-find-"));
  mkdirSync(path.join(root, "src", "deep"), { recursive: true });
  mkdirSync(path.join(root, "test"), { recursive: true });
  mkdirSync(path.join(root, "vendor"), { recursive: true });

  writeFileSync(path.join(root, "main.rs"), "fn needle() {}\n");
  writeFileSync(path.join(root, "src", "a.ts"), "const needle = 1;\n");
  writeFileSync(
    path.join(root, "src", "deep", "b.ts"),
    "// leading\nexport const needle = 2;\n// trailing\n",
  );
  writeFileSync(path.join(root, "src", "deep", "main.rs"), "fn needle() {}\n");
  writeFileSync(path.join(root, "src", "deep", "c.min.js"), "var needle=3;\n");
  writeFileSync(path.join(root, "test", "d.ts"), "const needle = 4;\n");
  writeFileSync(path.join(root, "vendor", "e.min.js"), "var needle=5;\n");
  writeFileSync(path.join(root, "Mixed.ts"), "const Needle = 6;\n");
  writeFileSync(path.join(root, "call.ts"), "needle(arg\nneedle(?= )\n");

  runtime = createSearchRuntime();
});

after(async () => {
  await runtime.dispose();
  rmSync(root, { recursive: true, force: true });
});

function grep(request: Record<string, unknown>) {
  const service = runtime.runSync(SearchRuntime);
  return runSearch(
    runtime,
    service.grep({
      patterns: ["needle"],
      literalOnly: false,
      limit: 50,
      cwd: root,
      ...request,
    } as Parameters<typeof service.grep>[0]),
  );
}

function find(request: Record<string, unknown>) {
  const service = runtime.runSync(SearchRuntime);
  return runSearch(
    runtime,
    service.find({
      pattern: "",
      limit: 50,
      cwd: root,
      ...request,
    } as Parameters<typeof service.find>[0]),
  );
}

function matchedPaths(matches: readonly { path: string; isMatch: boolean }[]) {
  return [...new Set(matches.filter((m) => m.isMatch).map((m) => m.path))].sort();
}

test("rg type hints require an entirely simple extension include set", () => {
  assert.deepEqual(rgTypeGlobs(["*.ts"]), ["*.ts"]);
  assert.deepEqual(rgTypeGlobs(["*.ts", "*.tsx", "*.ts"]), ["*.ts", "*.tsx"]);
  assert.deepEqual(rgTypeGlobs(["*.d.ts"]), ["*.d.ts"]);
  assert.equal(rgTypeGlobs([]), undefined);
  assert.equal(rgTypeGlobs(["profile.h"]), undefined);
  assert.equal(rgTypeGlobs(["src/**/*.ts"]), undefined);
  assert.equal(rgTypeGlobs(["*.ts", "src/**"]), undefined);
  assert.equal(rgTypeGlobs(["*.{ts,tsx}"]), undefined);
});

test("grep finds matches across the tree", { skip: !hasRg }, async () => {
  const outcome = await grep({});
  assert.deepEqual(matchedPaths(outcome.matches), [
    "Mixed.ts",
    "call.ts",
    "main.rs",
    "src/a.ts",
    "src/deep/b.ts",
    "src/deep/c.min.js",
    "src/deep/main.rs",
    "test/d.ts",
    "vendor/e.min.js",
  ]);
});

test("grep paths carry no ./ prefix", { skip: !hasRg }, async () => {
  // rg reports './src/a.ts' for a '.' root; the model compares these against
  // find and read output, which never carry the prefix.
  const outcome = await grep({});
  for (const match of outcome.matches) {
    assert.equal(match.path.startsWith("./"), false, match.path);
  }
});

test("grep keeps directory-constrained paths cwd-relative", { skip: !hasRg }, async () => {
  const outcome = await grep({ path: "src/" });
  assert.deepEqual(matchedPaths(outcome.matches), [
    "src/a.ts",
    "src/deep/b.ts",
    "src/deep/c.min.js",
    "src/deep/main.rs",
  ]);
});

test("grep matches a bare filename at any depth", { skip: !hasRg }, async () => {
  const outcome = await grep({ path: "main.rs" });
  assert.deepEqual(matchedPaths(outcome.matches), [
    "main.rs",
    "src/deep/main.rs",
  ]);
});

test("grep applies exclude filters", { skip: !hasRg }, async () => {
  const outcome = await grep({ exclude: "test/,*.min.js,Mixed.ts" });
  assert.deepEqual(matchedPaths(outcome.matches), [
    "call.ts",
    "main.rs",
    "src/a.ts",
    "src/deep/b.ts",
    "src/deep/main.rs",
  ]);
});

test("grep keeps directory paths and excludes in one namespace", {
  skip: !hasRg,
}, async () => {
  const outcome = await grep({ path: "src/", exclude: "src/deep/" });
  assert.deepEqual(matchedPaths(outcome.matches), ["src/a.ts"]);
});

test("grep smart-case matches both cases for a lowercase pattern", {
  skip: !hasRg,
}, async () => {
  const outcome = await grep({ patterns: ["needle"], path: "Mixed.ts" });
  assert.equal(outcome.matches.filter((m) => m.isMatch).length, 1);
});

test("grep caseSensitive forces an exact match", { skip: !hasRg }, async () => {
  const outcome = await grep({
    patterns: ["needle"],
    path: "Mixed.ts",
    caseSensitive: true,
  });
  assert.equal(outcome.matches.length, 0);
});

test("grep returns context lines around a hit", { skip: !hasRg }, async () => {
  const outcome = await grep({ path: "src/deep/b.ts", context: 1 });
  const kinds = outcome.matches.map((m) => `${m.lineNumber}${m.isMatch ? "!" : "-"}`);
  assert.deepEqual(kinds, ["1-", "2!", "3-"]);
});

test("grep limit counts matches, not context lines", { skip: !hasRg }, async () => {
  const outcome = await grep({ limit: 2, context: 1 });
  assert.equal(outcome.matches.filter((m) => m.isMatch).length, 2);
  assert.equal(outcome.truncated, true);
});

test("grep does not leak context-only files from the limit probe", {
  skip: !hasRg,
}, async () => {
  const probeRoot = mkdtempSync(path.join(tmpdir(), "pi-find-probe-"));
  try {
    writeFileSync(path.join(probeRoot, "a.ts"), "before a\nneedle a\nafter a\n");
    writeFileSync(path.join(probeRoot, "b.ts"), "before b\nneedle b\nafter b\n");
    const outcome = await grep({ cwd: probeRoot, limit: 1, context: 1 });
    const matchPaths = new Set(
      outcome.matches.filter((match) => match.isMatch).map((match) => match.path),
    );
    assert.equal(matchPaths.size, 1);
    for (const context of outcome.matches.filter((match) => !match.isMatch)) {
      assert.ok(matchPaths.has(context.path), `leaked context from ${context.path}`);
    }
  } finally {
    rmSync(probeRoot, { recursive: true, force: true });
  }
});

test("grep reports no matches for an absent pattern", { skip: !hasRg }, async () => {
  const outcome = await grep({ patterns: ["absolutely-not-present"] });
  assert.deepEqual(outcome.matches, []);
  assert.equal(outcome.truncated, false);
});

test("grep refuses a wildcard-only pattern", { skip: !hasRg }, async () => {
  await assert.rejects(
    () => grep({ patterns: [".*"] }),
    /wildcard-only pattern/,
  );
});

test("mixed external path errors describe the sole-constraint rule", async () => {
  const expected = /must be the call's sole path constraint/;
  await assert.rejects(
    () => grep({ path: ["/tmp/a", "*.ts"] }),
    expected,
  );
  await assert.rejects(
    () => find({ path: ["/tmp/a", "*.ts"] }),
    expected,
  );
});

test("grep searches literally when regex syntax does not compile", {
  skip: !hasRg,
}, async () => {
  const outcome = await grep({ patterns: ["needle(arg"] });
  assert.deepEqual(matchedPaths(outcome.matches), ["call.ts"]);
});

test("grep retries JavaScript-only regex syntax literally", {
  skip: !hasRg,
}, async () => {
  const outcome = await grep({ patterns: ["needle(?= )"] });
  assert.deepEqual(matchedPaths(outcome.matches), ["call.ts"]);
});

test("grep keeps in-workspace absolute constraints cwd-relative", {
  skip: !hasRg,
}, async () => {
  const outcome = await grep({ path: path.join(root, "src", "a.ts") });
  assert.equal(outcome.matches.filter((match) => match.isMatch).length, 1);
  assert.equal(outcome.matches[0]?.path, "src/a.ts");
});

test("grep returns absolute paths for external constraints", { skip: !hasRg }, async () => {
  const external = mkdtempSync(path.join(tmpdir(), "pi-find-external-"));
  try {
    const target = path.join(external, "outside.ts");
    writeFileSync(target, "needle outside\n");
    const outcome = await grep({ path: target });
    assert.equal(outcome.matches[0]?.path, target);
  } finally {
    rmSync(external, { recursive: true, force: true });
  }
});

test("grep matches extensionless filenames at any depth", {
  skip: !hasRg,
}, async () => {
  const tree = mkdtempSync(path.join(tmpdir(), "pi-find-ext-"));
  try {
    writeFileSync(path.join(tree, "Dockerfile"), "FROM node\n");
    mkdirSync(path.join(tree, "sub"), { recursive: true });
    writeFileSync(path.join(tree, "sub", "LICENSE"), "MIT license\n");
    const docker = await grep({ cwd: tree, path: "Dockerfile", patterns: ["FROM"] });
    assert.deepEqual(matchedPaths(docker.matches), ["Dockerfile"]);
    const license = await grep({ cwd: tree, path: "LICENSE", patterns: ["MIT"] });
    assert.deepEqual(matchedPaths(license.matches), ["sub/LICENSE"]);
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
});

test("grep still searches an extensionless directory by its contents", {
  skip: !hasRg,
}, async () => {
  const tree = mkdtempSync(path.join(tmpdir(), "pi-find-extdir-"));
  try {
    mkdirSync(path.join(tree, "vendor"));
    writeFileSync(path.join(tree, "vendor", "x.ts"), "needle vendor\n");
    const outcome = await grep({ cwd: tree, path: "vendor" });
    assert.deepEqual(matchedPaths(outcome.matches), ["vendor/x.ts"]);
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
});

test("grep can exclude an extensionless file", { skip: !hasRg }, async () => {
  const tree = mkdtempSync(path.join(tmpdir(), "pi-find-extexcl-"));
  try {
    writeFileSync(path.join(tree, "Dockerfile"), "FROM node\n");
    writeFileSync(path.join(tree, "app.ts"), "FROM elsewhere\n");
    const outcome = await grep({
      cwd: tree,
      patterns: ["FROM"],
      exclude: "Dockerfile",
    });
    assert.deepEqual(matchedPaths(outcome.matches), ["app.ts"]);
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
});

test("grep treats an external extensionless file as a file", {
  skip: !hasRg,
}, async () => {
  const external = mkdtempSync(path.join(tmpdir(), "pi-find-extfile-"));
  try {
    const license = path.join(external, "LICENSE");
    writeFileSync(license, "needle license\n");
    const outcome = await grep({ path: license });
    assert.equal(outcome.matches[0]?.path, license);
  } finally {
    rmSync(external, { recursive: true, force: true });
  }
});

test("find matches extensionless filenames", { skip: !hasFd }, async () => {
  const tree = mkdtempSync(path.join(tmpdir(), "pi-find-extfind-"));
  try {
    writeFileSync(path.join(tree, "Dockerfile"), "x\n");
    mkdirSync(path.join(tree, "sub"), { recursive: true });
    writeFileSync(path.join(tree, "sub", "LICENSE"), "x\n");
    const docker = await find({ cwd: tree, path: "Dockerfile", pattern: "" });
    assert.deepEqual(docker.files, ["Dockerfile"]);
    const license = await find({ cwd: tree, path: "LICENSE", pattern: "" });
    assert.deepEqual(license.files, ["sub/LICENSE"]);
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
});

test("grep accepts path strings containing spaces", { skip: !hasRg }, async () => {
  const spaced = mkdtempSync(path.join(tmpdir(), "pi-find-space-"));
  try {
    mkdirSync(path.join(spaced, "space dir"));
    writeFileSync(path.join(spaced, "space dir", "file.ts"), "needle space\n");
    const outcome = await grep({ cwd: spaced, path: "space dir/" });
    assert.deepEqual(matchedPaths(outcome.matches), ["space dir/file.ts"]);
  } finally {
    rmSync(spaced, { recursive: true, force: true });
  }
});

test("grep with multiple patterns finds any of several literal patterns", {
  skip: !hasRg,
}, async () => {
  const outcome = await grep({
    patterns: ["export const", "var needle"],
    literalOnly: true,
  });
  assert.deepEqual(matchedPaths(outcome.matches), [
    "src/deep/b.ts",
    "src/deep/c.min.js",
    "vendor/e.min.js",
  ]);
});

test("find keeps directory-constrained paths cwd-relative and prunes traversal", { skip: !hasFd }, async () => {
  const outcome = await find({ path: "src/" });
  assert.deepEqual([...outcome.files].sort(), [
    "src/a.ts",
    "src/deep/b.ts",
    "src/deep/c.min.js",
    "src/deep/main.rs",
  ]);

  const deepOutcome = await find({ path: "src/deep/" });
  assert.deepEqual([...deepOutcome.files].sort(), [
    "src/deep/b.ts",
    "src/deep/c.min.js",
    "src/deep/main.rs",
  ]);
});

test("find AND-matches whole-path terms in any order", {
  skip: !hasFd,
}, async () => {
  const outcome = await find({ pattern: "deep b" });
  assert.deepEqual(outcome.files, ["src/deep/b.ts"]);

  const reversed = await find({ pattern: "b deep" });
  assert.deepEqual(reversed.files, ["src/deep/b.ts"]);

  const constrained = await find({ pattern: "src deep", path: "src/" });
  assert.deepEqual([...constrained.files].sort(), [
    "src/deep/b.ts",
    "src/deep/c.min.js",
    "src/deep/main.rs",
  ]);
});

test("find matches substrings, not scattered characters", {
  skip: !hasFd,
}, async () => {
  const tree = mkdtempSync(path.join(tmpdir(), "pi-find-substring-"));
  try {
    mkdirSync(path.join(tree, "profiles"), { recursive: true });
    writeFileSync(path.join(tree, "profiles", "x.cc"), "x\n");
    writeFileSync(path.join(tree, "prompt-file-cache.ts"), "x\n");

    const substring = await find({ cwd: tree, pattern: "prof" });
    assert.deepEqual(substring.files, ["profiles/x.cc"]);

    // Fuzzy scoring would rank prompt-file-cache.ts here (p…r…f…l in order);
    // substring semantics must not.
    const scattered = await find({ cwd: tree, pattern: "prfl" });
    assert.deepEqual(scattered.files, []);
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
});

test("find treats regex terms as regex and falls back to literal", {
  skip: !hasFd,
}, async () => {
  const tree = mkdtempSync(path.join(tmpdir(), "pi-find-regex-"));
  try {
    mkdirSync(path.join(tree, "src"), { recursive: true });
    writeFileSync(path.join(tree, "src", "a.ts"), "x\n");
    writeFileSync(path.join(tree, "src", "b.tsx"), "x\n");
    writeFileSync(path.join(tree, "weird(name.ts"), "x\n");

    const suffix = await find({ cwd: tree, pattern: "\\.tsx$" });
    assert.deepEqual(suffix.files, ["src/b.tsx"]);

    const anchored = await find({ cwd: tree, pattern: "^src" });
    assert.deepEqual([...anchored.files].sort(), ["src/a.ts", "src/b.tsx"]);

    // '(' does not compile as a regex, so it is retried as a literal.
    const literal = await find({ cwd: tree, pattern: "weird(" });
    assert.deepEqual(literal.files, ["weird(name.ts"]);
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
});

test("find smart-cases terms against the path", {
  skip: !hasFd,
}, async () => {
  const lower = await find({ pattern: "mixed" });
  assert.deepEqual(lower.files, ["Mixed.ts"]);

  const exact = await find({ pattern: "Mixed" });
    assert.deepEqual(exact.files, ["Mixed.ts"]);

  const upper = await find({ pattern: "MIXED" });
  assert.deepEqual(upper.files, []);
});

test("find refuses a wildcard-only pattern", { skip: !hasFd }, async () => {
  await assert.rejects(
    () => find({ pattern: ".*" }),
    /wildcard-only pattern matches every path/,
  );
});

test("find matches path segments, not just filenames", {
  skip: !hasFd,
}, async () => {
  const outcome = await find({ pattern: "vendor" });
  assert.deepEqual(outcome.files, ["vendor/e.min.js"]);
});

test("find applies exclude filters", { skip: !hasFd }, async () => {
  const outcome = await find({ exclude: "test/,*.min.js,vendor/" });
  assert.equal(
    outcome.files.some((file) => file.includes("min.js")),
    false,
  );
  assert.equal(
    outcome.files.some((file) => file.startsWith("test/")),
    false,
  );

  const constrained = await find({ path: "src/", exclude: "src/deep/" });
  assert.deepEqual(constrained.files, ["src/a.ts"]);
});

test("find applies an include glob", { skip: !hasFd }, async () => {
  const outcome = await find({ path: "**/*.rs" });
  assert.deepEqual([...outcome.files].sort(), ["main.rs", "src/deep/main.rs"]);
});

test("find gives slashless globs basename semantics at any depth", {
  skip: !hasFd,
}, async () => {
  const outcome = await find({ path: "*.ts" });
  assert.ok(outcome.files.includes("src/a.ts"));
  assert.ok(outcome.files.includes("src/deep/b.ts"));
  assert.ok(outcome.files.includes("test/d.ts"));
});

test("grep unions extension type hints without bypassing ignores", {
  skip: !hasRg,
}, async () => {
  const tree = mkdtempSync(path.join(tmpdir(), "pi-find-rg-type-hints-"));
  try {
    mkdirSync(path.join(tree, ".git"));
    mkdirSync(path.join(tree, "src"));
    writeFileSync(path.join(tree, ".gitignore"), "src/ignored.tsx\n");
    writeFileSync(path.join(tree, "src", "a.ts"), "needle ts\n");
    writeFileSync(path.join(tree, "src", "b.tsx"), "needle tsx\n");
    writeFileSync(path.join(tree, "src", "ignored.tsx"), "needle ignored\n");
    writeFileSync(path.join(tree, "src", "c.js"), "needle js\n");

    const outcome = await grep({
      cwd: tree,
      path: ["*.ts", "*.tsx"],
      patterns: ["needle"],
    });
    assert.deepEqual(matchedPaths(outcome.matches), ["src/a.ts", "src/b.tsx"]);
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
});

test("find accepts an absolute glob constraint", { skip: !hasFd }, async () => {
  const outcome = await find({ path: path.join(root, "src", "**", "*.ts") });
  assert.deepEqual([...outcome.files].sort(), ["src/a.ts", "src/deep/b.ts"]);
});

test("find returns absolute paths for external roots", { skip: !hasFd }, async () => {
  const external = mkdtempSync(path.join(tmpdir(), "pi-find-find-external-"));
  try {
    const target = path.join(external, "outside.ts");
    writeFileSync(target, "outside\n");
    const outcome = await find({ path: `${external}/` });
    assert.deepEqual(outcome.files, [target]);
  } finally {
    rmSync(external, { recursive: true, force: true });
  }
});

test("find applies a nested include glob", { skip: !hasFd }, async () => {
  const outcome = await find({ path: "src/**/*.ts" });
  assert.deepEqual([...outcome.files].sort(), ["src/a.ts", "src/deep/b.ts"]);
});

test("find honours and reports the limit", { skip: !hasFd }, async () => {
  const outcome = await find({ limit: 2 });
  assert.equal(outcome.files.length, 2);
  assert.equal(outcome.limitReached, true);
});

test("find respects .gitignore outside a Git repository", {
  skip: !hasFd,
}, async () => {
  const outside = mkdtempSync(path.join(tmpdir(), "pi-find-ignore-"));
  try {
    writeFileSync(path.join(outside, ".gitignore"), "ignored.ts\n");
    writeFileSync(path.join(outside, "ignored.ts"), "ignored\n");
    writeFileSync(path.join(outside, "kept.ts"), "kept\n");
    const outcome = await find({ cwd: outside });
    assert.equal(outcome.files.includes("ignored.ts"), false);
    assert.equal(outcome.files.includes("kept.ts"), true);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("grep respects .gitignore outside a Git repository", {
  skip: !hasRg,
}, async () => {
  const outside = mkdtempSync(path.join(tmpdir(), "pi-grep-ignore-"));
  try {
    writeFileSync(path.join(outside, ".gitignore"), "ignored.ts\n");
    writeFileSync(path.join(outside, "ignored.ts"), "needle ignored\n");
    writeFileSync(path.join(outside, "kept.ts"), "needle kept\n");
    const outcome = await grep({ cwd: outside });
    assert.deepEqual(matchedPaths(outcome.matches), ["kept.ts"]);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("find preserves leading and trailing spaces in filenames", {
  skip: !hasFd,
}, async () => {
  const outside = mkdtempSync(path.join(tmpdir(), "pi-find-whitespace-"));
  try {
    writeFileSync(path.join(outside, " leading.ts"), "x\n");
    writeFileSync(path.join(outside, "trailing.ts "), "x\n");
    const outcome = await find({ cwd: outside });
    assert.deepEqual([...outcome.files].sort(), [" leading.ts", "trailing.ts "]);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("find reports nothing for an unmatchable query", {
  skip: !hasFd,
}, async () => {
  const outcome = await find({ pattern: "zzzznotapath" });
  assert.deepEqual(outcome.files, []);
});

test("find when path points to a file returns the file without error", {
  skip: !hasFd,
}, async () => {
  const tree = mkdtempSync(path.join(tmpdir(), "pi-find-file-path-"));
  try {
    mkdirSync(path.join(tree, "pkg"), { recursive: true });
    writeFileSync(path.join(tree, "pkg", "LICENSE"), "MIT\n");
    writeFileSync(path.join(tree, "pkg", "normal.ts"), "export const a = 1;\n");

    const extless = await find({ cwd: tree, path: "pkg/LICENSE" });
    assert.deepEqual(extless.files, ["pkg/LICENSE"]);

    const normal = await find({ cwd: tree, path: "pkg/normal.ts" });
    assert.deepEqual(normal.files, ["pkg/normal.ts"]);
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
});

test("find when path contains a typo or nonexistent directory returns empty list", {
  skip: !hasFd,
}, async () => {
  const withoutSlash = await find({ path: "nonexistent_dir" });
  assert.deepEqual(withoutSlash.files, []);

  const withSlash = await find({ path: "a/nonexistent_dir/" });
  assert.deepEqual(withSlash.files, []);
});

test("find with multiple search directories and single dir exclude does not exclude sibling directories", {
  skip: !hasFd,
}, async () => {
  const tree = mkdtempSync(path.join(tmpdir(), "pi-find-sibling-exclude-"));
  try {
    mkdirSync(path.join(tree, "src", "deep"), { recursive: true });
    mkdirSync(path.join(tree, "test", "deep"), { recursive: true });
    writeFileSync(path.join(tree, "src", "a.ts"), "a\n");
    writeFileSync(path.join(tree, "src", "deep", "dropme.ts"), "drop\n");
    writeFileSync(path.join(tree, "test", "c.ts"), "c\n");
    writeFileSync(path.join(tree, "test", "deep", "keepme.ts"), "keep\n");

    const outcome = await find({
      cwd: tree,
      path: ["src/", "test/"],
      exclude: "src/deep/",
    });

    assert.deepEqual([...outcome.files].sort(), [
      "src/a.ts",
      "test/c.ts",
      "test/deep/keepme.ts",
    ]);
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
});

test("grep and find behave consistently on identical path constraints", {
  skip: !hasRg || !hasFd,
}, async () => {
  const tree = mkdtempSync(path.join(tmpdir(), "pi-find-consistency-"));
  try {
    mkdirSync(path.join(tree, "pkg"), { recursive: true });
    writeFileSync(path.join(tree, "pkg", "LICENSE"), "needle\n");

    const findOutcome = await find({ cwd: tree, path: "pkg/LICENSE" });
    assert.deepEqual(findOutcome.files, ["pkg/LICENSE"]);

    const grepOutcome = await grep({ cwd: tree, path: "pkg/LICENSE", patterns: ["needle"] });
    assert.deepEqual(matchedPaths(grepOutcome.matches), ["pkg/LICENSE"]);
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
});

test("grep refuses empty patterns but accepts whitespace literals", {
  skip: !hasRg,
}, async () => {
  await assert.rejects(
    () => grep({ patterns: [""] }),
    (error: Error) => {
      assert.match(error.message, /Search pattern cannot be empty/);
      return true;
    },
  );

  const tree = mkdtempSync(path.join(tmpdir(), "pi-find-whitespace-pattern-"));
  try {
    writeFileSync(path.join(tree, "spaced.ts"), "if (x)  {\n\treturn true;\n}\n");

    const spaces = await grep({ cwd: tree, patterns: ["  "] });
    assert.deepEqual(matchedPaths(spaces.matches), ["spaced.ts"]);

    const tab = await grep({ cwd: tree, patterns: ["\t"] });
    assert.deepEqual(matchedPaths(tab.matches), ["spaced.ts"]);
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
});

test("grep and find normalize ./ and . paths identically", {
  skip: !hasRg || !hasFd,
}, async () => {
  const findDot = await find({ path: "." });
  assert.ok(findDot.files.includes("src/a.ts"));
  assert.ok(findDot.files.includes("main.rs"));

  const grepDot = await grep({ path: ".", patterns: ["needle"] });
  assert.ok(matchedPaths(grepDot.matches).includes("src/a.ts"));
  assert.ok(matchedPaths(grepDot.matches).includes("main.rs"));

  const findDotSlash = await find({ path: "./src/" });
  assert.ok(findDotSlash.files.includes("src/a.ts"));
  assert.ok(!findDotSlash.files.includes("main.rs"));

  const grepDotSlash = await grep({ path: "./src/", patterns: ["needle"] });
  assert.ok(matchedPaths(grepDotSlash.matches).includes("src/a.ts"));
  assert.ok(!matchedPaths(grepDotSlash.matches).includes("main.rs"));
});

test("find deduplicates results and handles overlapping search paths without duplicate hits", {
  skip: !hasFd,
}, async () => {
  const outcome = await find({ path: ["src/", "src/deep/"] });
  const counts = new Map<string, number>();
  for (const f of outcome.files) {
    counts.set(f, (counts.get(f) ?? 0) + 1);
  }
  for (const [file, count] of counts.entries()) {
    assert.equal(count, 1, `file "${file}" appeared ${count} times`);
  }
  assert.ok(outcome.files.includes("src/deep/b.ts"));
  assert.ok(outcome.files.includes("src/a.ts"));
});

test("path [., src/] and exclude . behave correctly", {
  skip: !hasRg || !hasFd,
}, async () => {
  const combined = await find({ path: [".", "src/"] });
  assert.ok(combined.files.includes("main.rs"));
  assert.ok(combined.files.includes("src/a.ts"));

  const excludedFind = await find({ exclude: "." });
  assert.deepEqual(excludedFind.files, []);

  const excludedGrep = await grep({ patterns: ["needle"], exclude: "." });
  assert.deepEqual(excludedGrep.matches, []);
});

test("glob paths with ./ and a/../ prefixes normalize and match consistently", {
  skip: !hasRg || !hasFd,
}, async () => {
  const findGlob = await find({ path: "./src/*.ts" });
  assert.deepEqual(findGlob.files, ["src/a.ts"]);

  const grepGlob = await grep({ path: "./src/*.ts", patterns: ["needle"] });
  assert.deepEqual(matchedPaths(grepGlob.matches), ["src/a.ts"]);

  const findNormalized = await find({ path: "src/../*.rs" });
  assert.deepEqual([...findNormalized.files].sort(), ["main.rs", "src/deep/main.rs"].sort());

  const grepNormalized = await grep({ path: "src/../*.rs", patterns: ["needle"] });
  assert.deepEqual([...matchedPaths(grepNormalized.matches)].sort(), ["main.rs", "src/deep/main.rs"].sort());
});

test("grep and find support parent ../ and bare .. paths with exact equivalence", {
  skip: !hasRg || !hasFd,
}, async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "pi-find-parent-bare-test-"));
  try {
    const workspace = path.join(baseDir, "workspace");
    const sibling = path.join(baseDir, "sibling");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(sibling, { recursive: true });
    writeFileSync(path.join(sibling, "sibling_file.ts"), "const needle = 'found_in_sibling';\n");
    writeFileSync(path.join(baseDir, "LICENSE"), "MIT License\nneedle\n");

    // 1. Bare ".." and "../" equivalence in find
    const findBareDotDot = await find({ cwd: workspace, path: ".." });
    const findSlashDotDot = await find({ cwd: workspace, path: "../" });
    assert.ok(findBareDotDot.files.length > 0);
    assert.deepEqual([...findBareDotDot.files].sort(), [...findSlashDotDot.files].sort());

    // 2. Bare ".." in grep
    const grepBareDotDot = await grep({
      cwd: workspace,
      path: "..",
      patterns: ["found_in_sibling"],
    });
    assert.equal(grepBareDotDot.matches.length, 1);
    assert.equal(grepBareDotDot.matches[0]?.path, path.join(sibling, "sibling_file.ts"));

    // 3. Parent extensionless file "../LICENSE"
    const findLicense = await find({ cwd: workspace, path: "../LICENSE" });
    assert.deepEqual(findLicense.files, [path.join(baseDir, "LICENSE")]);

    const grepLicense = await grep({
      cwd: workspace,
      path: "../LICENSE",
      patterns: ["needle"],
    });
    assert.deepEqual(matchedPaths(grepLicense.matches), [path.join(baseDir, "LICENSE")]);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("grep and find honour external absolute excludes under an external search root", {
  skip: !hasRg || !hasFd,
}, async () => {
  const outsideDir = mkdtempSync(path.join(tmpdir(), "pi-find-outside-exclude-test-"));
  try {
    const subtest = path.join(outsideDir, "test");
    const subsrc = path.join(outsideDir, "src");
    mkdirSync(subtest, { recursive: true });
    mkdirSync(subsrc, { recursive: true });
    writeFileSync(path.join(subtest, "drop.ts"), "const needle = 'drop';\n");
    writeFileSync(path.join(subsrc, "keep.ts"), "const needle = 'keep';\n");

    // 1. find with absolute path + absolute exclude
    const findOutcome = await find({
      path: `${outsideDir}/`,
      exclude: `${subtest}/`,
    });
    assert.equal(findOutcome.files.length, 1);
    assert.equal(findOutcome.files[0], path.join(subsrc, "keep.ts"));

    // 2. grep with absolute path + absolute exclude
    const grepOutcome = await grep({
      path: `${outsideDir}/`,
      exclude: `${subtest}/`,
      patterns: ["needle"],
    });
    assert.equal(grepOutcome.matches.length, 1);
    assert.equal(grepOutcome.matches[0]?.path, path.join(subsrc, "keep.ts"));
  } finally {
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

test("grep and find honour absolute excludes under default cwd and relative paths", {
  skip: !hasRg || !hasFd,
}, async () => {
  // 1. Default cwd + absolute exclude
  const findCwd = await find({ exclude: path.join(root, "test") + "/" });
  assert.equal(findCwd.files.includes("test/d.ts"), false);
  assert.equal(findCwd.files.includes("src/a.ts"), true);

  const grepCwd = await grep({ exclude: path.join(root, "test") + "/" });
  assert.equal(matchedPaths(grepCwd.matches).includes("test/d.ts"), false);
  assert.equal(matchedPaths(grepCwd.matches).includes("src/a.ts"), true);

  // 2. Relative path + absolute exclude
  const findRel = await find({
    path: "src/",
    exclude: path.join(root, "src", "deep") + "/",
  });
  assert.deepEqual(findRel.files, ["src/a.ts"]);

  const grepRel = await grep({
    path: "src/",
    exclude: path.join(root, "src", "deep") + "/",
  });
  assert.deepEqual(matchedPaths(grepRel.matches), ["src/a.ts"]);
});

test("grep and find honour relative and nested excludes under external search roots", {
  skip: !hasRg || !hasFd,
}, async () => {
  const outsideDir = mkdtempSync(path.join(tmpdir(), "pi-find-outside-rel-exclude-"));
  try {
    const subtest = path.join(outsideDir, "test");
    const subsrc = path.join(outsideDir, "src", "deep");
    mkdirSync(subtest, { recursive: true });
    mkdirSync(subsrc, { recursive: true });
    writeFileSync(path.join(subtest, "drop.ts"), "const needle = 'drop';\n");
    writeFileSync(path.join(subsrc, "keep.ts"), "const needle = 'keep';\n");
    writeFileSync(path.join(subsrc, "drop_file.ts"), "const needle = 'drop_file';\n");

    // 1. External root + relative directory exclude "test/"
    const findRelDir = await find({
      path: `${outsideDir}/`,
      exclude: "test/",
    });
    assert.deepEqual([...findRelDir.files].sort(), [
      path.join(subsrc, "drop_file.ts"),
      path.join(subsrc, "keep.ts"),
    ]);

    const grepRelDir = await grep({
      path: `${outsideDir}/`,
      exclude: "test/",
      patterns: ["needle"],
    });
    assert.deepEqual(matchedPaths(grepRelDir.matches), [
      path.join(subsrc, "drop_file.ts"),
      path.join(subsrc, "keep.ts"),
    ]);

    // 2. External root + nested relative filename exclude "src/deep/drop_file.ts"
    const findRelFile = await find({
      path: `${outsideDir}/`,
      exclude: ["test/", "src/deep/drop_file.ts"],
    });
    assert.deepEqual(findRelFile.files, [path.join(subsrc, "keep.ts")]);

    const grepRelFile = await grep({
      path: `${outsideDir}/`,
      exclude: ["test/", "src/deep/drop_file.ts"],
      patterns: ["needle"],
    });
    assert.deepEqual(matchedPaths(grepRelFile.matches), [path.join(subsrc, "keep.ts")]);
  } finally {
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

test("grep and find behave identically on in-workspace absolute path + absolute exclude", {
  skip: !hasRg || !hasFd,
}, async () => {
  const absPath = path.join(root, "src") + "/";
  const absExclude = path.join(root, "src", "deep") + "/";

  const findOutcome = await find({ path: absPath, exclude: absExclude });
  assert.deepEqual(findOutcome.files, ["src/a.ts"]);

  const grepOutcome = await grep({ path: absPath, exclude: absExclude });
  assert.deepEqual(matchedPaths(grepOutcome.matches), ["src/a.ts"]);
});

test("grep and find return empty when exclude is an ancestor of search root", {
  skip: !hasRg || !hasFd,
}, async () => {
  // 1. In-workspace search where exclude is ancestor
  const findAncestor = await find({
    path: path.join(root, "src", "deep") + "/",
    exclude: path.join(root, "src") + "/",
  });
  assert.deepEqual(findAncestor.files, []);

  const grepAncestor = await grep({
    path: path.join(root, "src", "deep") + "/",
    exclude: path.join(root, "src") + "/",
  });
  assert.deepEqual(grepAncestor.matches, []);

  // 2. External search where exclude is ancestor
  const outsideDir = mkdtempSync(path.join(tmpdir(), "pi-find-outside-ancestor-"));
  try {
    const sub = path.join(outsideDir, "project", "sub");
    mkdirSync(sub, { recursive: true });
    writeFileSync(path.join(sub, "file.ts"), "const needle = 1;\n");

    const findExtAncestor = await find({
      path: `${sub}/`,
      exclude: `${path.join(outsideDir, "project")}/`,
    });
    assert.deepEqual(findExtAncestor.files, []);

    const grepExtAncestor = await grep({
      path: `${sub}/`,
      exclude: `${path.join(outsideDir, "project")}/`,
      patterns: ["needle"],
    });
    assert.deepEqual(grepExtAncestor.matches, []);
  } finally {
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

test("grep and find preserve exact file and root-level glob anchoring", {
  skip: !hasRg || !hasFd,
}, async () => {
  const tree = mkdtempSync(path.join(tmpdir(), "pi-find-anchor-include-"));
  try {
    mkdirSync(path.join(tree, "sub", "deep"), { recursive: true });
    writeFileSync(path.join(tree, "main.ts"), "const needle = 'root';\n");
    writeFileSync(path.join(tree, "sub", "main.ts"), "const needle = 'nested';\n");
    writeFileSync(path.join(tree, "top.ts"), "const needle = 'top';\n");
    writeFileSync(path.join(tree, "sub", "deep", "nested.ts"), "const needle = 'deep';\n");

    // 1. Exact absolute file path matches only the root file, not the nested one
    const findExact = await find({
      cwd: tree,
      path: path.join(tree, "main.ts"),
    });
    assert.deepEqual(findExact.files, ["main.ts"]);

    const grepExact = await grep({
      cwd: tree,
      path: path.join(tree, "main.ts"),
      patterns: ["needle"],
    });
    assert.deepEqual(matchedPaths(grepExact.matches), ["main.ts"]);

    // 2. Root-level absolute glob matches only root files, not subdirectories
    const findGlob = await find({
      cwd: tree,
      path: path.join(tree, "*.ts"),
    });
    assert.deepEqual([...findGlob.files].sort(), ["main.ts", "top.ts"]);

    const grepGlob = await grep({
      cwd: tree,
      path: path.join(tree, "*.ts"),
      patterns: ["needle"],
    });
    assert.deepEqual([...matchedPaths(grepGlob.matches)].sort(), ["main.ts", "top.ts"]);
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
});

test("grep and find preserve exact file and root-level glob exclude anchoring", {
  skip: !hasRg || !hasFd,
}, async () => {
  const tree = mkdtempSync(path.join(tmpdir(), "pi-find-anchor-exclude-"));
  try {
    mkdirSync(path.join(tree, "sub"), { recursive: true });
    writeFileSync(path.join(tree, "main.ts"), "const needle = 'root';\n");
    writeFileSync(path.join(tree, "sub", "main.ts"), "const needle = 'nested';\n");
    writeFileSync(path.join(tree, "top.ts"), "const needle = 'top';\n");
    writeFileSync(path.join(tree, "sub", "deep.ts"), "const needle = 'deep';\n");

    // 1. Exact absolute file exclude excludes only root main.ts, keeps sub/main.ts
    const findFileExcl = await find({
      cwd: tree,
      exclude: path.join(tree, "main.ts"),
    });
    assert.deepEqual([...findFileExcl.files].sort(), [
      "sub/deep.ts",
      "sub/main.ts",
      "top.ts",
    ]);

    const grepFileExcl = await grep({
      cwd: tree,
      exclude: path.join(tree, "main.ts"),
      patterns: ["needle"],
    });
    assert.deepEqual([...matchedPaths(grepFileExcl.matches)].sort(), [
      "sub/deep.ts",
      "sub/main.ts",
      "top.ts",
    ]);

    // 2. Root-level absolute glob exclude excludes top-level *.ts, keeps sub/*.ts
    const findGlobExcl = await find({
      cwd: tree,
      exclude: path.join(tree, "*.ts"),
    });
    assert.deepEqual([...findGlobExcl.files].sort(), [
      "sub/deep.ts",
      "sub/main.ts",
    ]);

    const grepGlobExcl = await grep({
      cwd: tree,
      exclude: path.join(tree, "*.ts"),
      patterns: ["needle"],
    });
    assert.deepEqual([...matchedPaths(grepGlobExcl.matches)].sort(), [
      "sub/deep.ts",
      "sub/main.ts",
    ]);
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
});

test("grep and find rebase excludes correctly when a parent path resolves inside cwd", {
  skip: !hasRg || !hasFd,
}, async () => {
  const base = mkdtempSync(path.join(tmpdir(), "pi-find-parent-rebase-"));
  const cwd = path.join(base, "workspace");
  try {
    mkdirSync(path.join(cwd, "src", "test"), { recursive: true });
    writeFileSync(path.join(cwd, "src", "keep.ts"), "needle keep\n");
    writeFileSync(path.join(cwd, "src", "test", "drop.ts"), "needle drop\n");

    const searchPath = "../workspace/src/";
    const exclude = path.join(cwd, "src", "test", "drop.ts");
    const findOutcome = await find({ cwd, path: searchPath, exclude });
    assert.deepEqual(findOutcome.files, ["src/keep.ts"]);

    const grepOutcome = await grep({ cwd, path: searchPath, exclude });
    assert.deepEqual(matchedPaths(grepOutcome.matches), ["src/keep.ts"]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("grep and find preserve cwd-relative semantics when path is in-workspace absolute and exclude is relative", {
  skip: !hasRg || !hasFd,
}, async () => {
  const absSrc = path.join(root, "src") + "/";
  const findOutcome = await find({
    path: absSrc,
    exclude: "src/deep/",
  });
  assert.deepEqual(findOutcome.files, ["src/a.ts"]);

  const grepOutcome = await grep({
    path: absSrc,
    exclude: "src/deep/",
    patterns: ["needle"],
  });
  assert.deepEqual(matchedPaths(grepOutcome.matches), ["src/a.ts"]);
});

test("grep and find support ancestor glob excludes", {
  skip: !hasRg || !hasFd,
}, async () => {
  const outsideDir = mkdtempSync(path.join(tmpdir(), "pi-find-ancestor-glob-"));
  try {
    const projectDir = path.join(outsideDir, "project");
    mkdirSync(path.join(projectDir, "sub"), { recursive: true });
    writeFileSync(path.join(projectDir, "x.ts"), "const needle = 'root';\n");
    writeFileSync(path.join(projectDir, "sub", "deep.ts"), "const needle = 'deep';\n");

    const findOutcome = await find({
      path: `${projectDir}/`,
      exclude: `${path.join(outsideDir, "*", "*.ts")}`,
    });
    assert.deepEqual(findOutcome.files, [path.join(projectDir, "sub", "deep.ts")]);

    const grepOutcome = await grep({
      path: `${projectDir}/`,
      exclude: `${path.join(outsideDir, "*", "*.ts")}`,
      patterns: ["needle"],
    });
    assert.deepEqual(matchedPaths(grepOutcome.matches), [
      path.join(projectDir, "sub", "deep.ts"),
    ]);
  } finally {
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

test("grep path filters preserve .gitignore and always exclude .git", {
  skip: !hasRg,
}, async () => {
  const tree = mkdtempSync(path.join(tmpdir(), "pi-find-grep-ignore-path-"));
  try {
    mkdirSync(path.join(tree, ".git", "objects"), { recursive: true });
    mkdirSync(path.join(tree, "node_modules", "dep"), { recursive: true });
    mkdirSync(path.join(tree, "src"), { recursive: true });
    writeFileSync(path.join(tree, ".gitignore"), "node_modules/\nsrc/ignored.ts\n");
    writeFileSync(path.join(tree, ".git", "objects", "pack.idx"), "needle git\n");
    writeFileSync(path.join(tree, "node_modules", "dep", "index.ts"), "needle dependency\n");
    writeFileSync(path.join(tree, "src", "ignored.ts"), "needle ignored\n");
    writeFileSync(path.join(tree, "src", "a.ts"), "needle kept\n");

    for (const constraint of [undefined, ".", "./", "**", "*", "src/**", "*.ts"]) {
      const outcome = await grep({
        cwd: tree,
        path: constraint,
        patterns: ["needle"],
      });
      assert.deepEqual(
        matchedPaths(outcome.matches),
        ["src/a.ts"],
        `path=${String(constraint)}`,
      );
    }
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
});

test("grep and find keep excludes rooted when directory traversal is pruned", {
  skip: !hasRg || !hasFd,
}, async () => {
  const tree = mkdtempSync(path.join(tmpdir(), "pi-find-search-path-exclude-"));
  try {
    mkdirSync(path.join(tree, "src", "deep", "skip"), { recursive: true });
    mkdirSync(path.join(tree, "deep"), { recursive: true });
    writeFileSync(path.join(tree, "src", "deep", "a.ts"), "needle a\n");
    writeFileSync(path.join(tree, "src", "deep", "skip", "b.ts"), "needle b\n");
    writeFileSync(path.join(tree, "src", "top.ts"), "needle top\n");
    writeFileSync(path.join(tree, "deep", "root.ts"), "needle root\n");

    const findSrc = await find({ cwd: tree, path: "src/", exclude: "deep/" });
    const grepSrc = await grep({ cwd: tree, path: "src/", exclude: "deep/" });
    const expectedSrc = [
      "src/deep/a.ts",
      "src/deep/skip/b.ts",
      "src/top.ts",
    ];
    assert.deepEqual([...findSrc.files].sort(), expectedSrc);
    assert.deepEqual(matchedPaths(grepSrc.matches), expectedSrc);

    const findDeep = await find({ cwd: tree, path: "src/deep/", exclude: "skip/" });
    const grepDeep = await grep({ cwd: tree, path: "src/deep/", exclude: "skip/" });
    const expectedDeep = ["src/deep/a.ts", "src/deep/skip/b.ts"];
    assert.deepEqual([...findDeep.files].sort(), expectedDeep);
    assert.deepEqual(matchedPaths(grepDeep.matches), expectedDeep);
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
});

test("a search is abortable", { skip: !hasRg }, async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => grep({ signal: controller.signal }), (error: Error) => {
    assert.equal(error.name, "AbortError");
    return true;
  });
});
