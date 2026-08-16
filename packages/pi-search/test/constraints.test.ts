import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseConstraint,
  planConstraints,
  splitConstraints,
  toGlobArgs,
} from "../lib/constraints.ts";

test("splitConstraints separates strings on commas but preserves spaces", () => {
  assert.deepEqual(splitConstraints("test/,*.min.js"), ["test/", "*.min.js"]);
  assert.deepEqual(splitConstraints("space dir/"), ["space dir/"]);
  assert.deepEqual(splitConstraints("test/, *.min.js"), ["test/", "*.min.js"]);
});

test("splitConstraints keeps brace alternations intact", () => {
  assert.deepEqual(splitConstraints("{src,lib}/**"), ["{src,lib}/**"]);
  assert.deepEqual(splitConstraints("**/*.{rs,go},test/"), [
    "**/*.{rs,go}",
    "test/",
  ]);
});

test("splitConstraints treats array elements as verbatim tokens", () => {
  assert.deepEqual(splitConstraints(["src/", "", "  ", "space dir,file.ts"]), [
    "src/",
    "space dir,file.ts",
  ]);
});

test("parseConstraint classifies directory prefixes", () => {
  assert.deepEqual(parseConstraint("src/"), {
    kind: "directory",
    raw: "src/",
    glob: "src/**",
  });
  // No trailing slash and no dot: still a directory.
  assert.equal(parseConstraint("src")?.kind, "directory");
  assert.equal(parseConstraint("packages/pi-search")?.kind, "directory");
});

test("parseConstraint makes a bare filename match at any depth", () => {
  // Rooted 'main.rs' would only match the top level, silently hiding nested hits.
  assert.deepEqual(parseConstraint("main.rs"), {
    kind: "filename",
    raw: "main.rs",
    glob: "**/main.rs",
  });
});

test("parseConstraint keeps an explicit path rooted", () => {
  assert.deepEqual(parseConstraint("src/main.rs"), {
    kind: "filename",
    raw: "src/main.rs",
    glob: "src/main.rs",
  });
});

test("parseConstraint passes globs through untouched", () => {
  assert.equal(parseConstraint("*.ts")?.glob, "*.ts");
  assert.equal(parseConstraint("src/**/*.cc")?.glob, "src/**/*.cc");
  assert.equal(parseConstraint("{src,lib}/**")?.glob, "{src,lib}/**");
});

test("parseConstraint tolerates model path prefixes", () => {
  assert.equal(parseConstraint("!test/")?.glob, "test/**");
  assert.equal(parseConstraint("! *.min.js")?.glob, "*.min.js");
  assert.equal(parseConstraint("@src/")?.glob, "src/**");
});

test("parseConstraint rejects empty tokens", () => {
  assert.equal(parseConstraint(""), undefined);
  assert.equal(parseConstraint("   "), undefined);
  assert.equal(parseConstraint("!"), undefined);
});

test("a lone relative directory remains a cwd-relative glob", () => {
  const plan = planConstraints("src/", undefined);
  assert.equal(plan.searchRoot, undefined);
  assert.deepEqual(plan.include, ["src/**"]);
});

test("a directory mixed with other tokens stays a glob", () => {
  // A root plus globs would mean AND where the model meant OR.
  const plan = planConstraints("src/, *.ts", undefined);
  assert.equal(plan.searchRoot, undefined);
  assert.deepEqual(plan.include, ["src/**", "*.ts"]);
});

test("an absolute filename becomes a root plus exact include", () => {
  const plan = planConstraints("/tmp/project/src/main.ts", undefined);
  assert.equal(plan.searchRoot, "/tmp/project/src");
  assert.deepEqual(plan.include, ["main.ts"]);
});

test("an absolute glob becomes a root plus relative glob", () => {
  const plan = planConstraints("/tmp/project/src/**/*.ts", undefined);
  assert.equal(plan.searchRoot, "/tmp/project/src");
  assert.deepEqual(plan.include, ["**/*.ts"]);
});

test("a home-relative glob becomes a root plus relative glob", () => {
  const plan = planConstraints("~/project/src/*.ts", undefined);
  assert.equal(plan.searchRoot, "~/project/src");
  assert.deepEqual(plan.include, ["*.ts"]);
});

test("mixed external roots are rejected by the runtime plan", () => {
  const plan = planConstraints(["/tmp/a/", "/tmp/b/"], undefined);
  assert.equal(plan.hasMixedExternalRoots, true);
});

test("excludes are negated for ripgrep", () => {
  const plan = planConstraints(undefined, "test/,*.min.js");
  assert.deepEqual(plan.exclude, ["!test/**", "!*.min.js"]);
});

test("planConstraints keeps relative includes and excludes in one namespace", () => {
  const plan = planConstraints("packages/", "!packages/test/");
  assert.equal(plan.searchRoot, undefined);
  assert.deepEqual(plan.include, ["packages/**"]);
  assert.deepEqual(plan.exclude, ["!packages/test/**"]);
});

test("toGlobArgs emits includes before negations", () => {
  const plan = planConstraints("*.ts", "test/");
  assert.deepEqual(toGlobArgs(plan), [
    "--glob",
    "*.ts",
    "--glob",
    "!test/**",
  ]);
});

test("no constraints produce no glob arguments", () => {
  const plan = planConstraints(undefined, undefined);
  assert.deepEqual(toGlobArgs(plan), []);
  assert.equal(plan.searchRoot, undefined);
});
