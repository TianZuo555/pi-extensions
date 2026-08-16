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
  runSearch,
  SearchRuntime,
  type SearchRuntimeInstance,
} from "../src/runtime.ts";

let root: string;
let runtime: SearchRuntimeInstance;

const hasRg = resolveBinary("rg") !== null;
const hasFd = resolveBinary("fd") !== null;

before(() => {
  root = mkdtempSync(path.join(tmpdir(), "pi-search-"));
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
  const probeRoot = mkdtempSync(path.join(tmpdir(), "pi-search-probe-"));
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
  const external = mkdtempSync(path.join(tmpdir(), "pi-search-external-"));
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
  const tree = mkdtempSync(path.join(tmpdir(), "pi-search-ext-"));
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
  const tree = mkdtempSync(path.join(tmpdir(), "pi-search-extdir-"));
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
  const tree = mkdtempSync(path.join(tmpdir(), "pi-search-extexcl-"));
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
  const external = mkdtempSync(path.join(tmpdir(), "pi-search-extfile-"));
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
  const tree = mkdtempSync(path.join(tmpdir(), "pi-search-extfind-"));
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
  const spaced = mkdtempSync(path.join(tmpdir(), "pi-search-space-"));
  try {
    mkdirSync(path.join(spaced, "space dir"));
    writeFileSync(path.join(spaced, "space dir", "file.ts"), "needle space\n");
    const outcome = await grep({ cwd: spaced, path: "space dir/" });
    assert.deepEqual(matchedPaths(outcome.matches), ["space dir/file.ts"]);
  } finally {
    rmSync(spaced, { recursive: true, force: true });
  }
});

test("multi_grep finds any of several literal patterns", {
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

test("find keeps directory-constrained paths cwd-relative", { skip: !hasFd }, async () => {
  const outcome = await find({ path: "src/" });
  assert.deepEqual([...outcome.files].sort(), [
    "src/a.ts",
    "src/deep/b.ts",
    "src/deep/c.min.js",
    "src/deep/main.rs",
  ]);
});

test("find scores a fuzzy query against the whole path", {
  skip: !hasFd,
}, async () => {
  const outcome = await find({ pattern: "deep b" });
  assert.equal(outcome.files[0], "src/deep/b.ts");

  const constrained = await find({ pattern: "src deep", path: "src/" });
  assert.equal(constrained.files[0], "src/deep/b.ts");
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

test("find accepts an absolute glob constraint", { skip: !hasFd }, async () => {
  const outcome = await find({ path: path.join(root, "src", "**", "*.ts") });
  assert.deepEqual([...outcome.files].sort(), ["src/a.ts", "src/deep/b.ts"]);
});

test("find returns absolute paths for external roots", { skip: !hasFd }, async () => {
  const external = mkdtempSync(path.join(tmpdir(), "pi-search-find-external-"));
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
  const outside = mkdtempSync(path.join(tmpdir(), "pi-search-ignore-"));
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

test("find reports nothing for an unmatchable query", {
  skip: !hasFd,
}, async () => {
  const outcome = await find({ pattern: "zzzznotapath" });
  assert.deepEqual(outcome.files, []);
});

test("a search is abortable", { skip: !hasRg }, async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => grep({ signal: controller.signal }), (error: Error) => {
    assert.equal(error.name, "AbortError");
    return true;
  });
});
