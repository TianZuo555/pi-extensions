import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
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
    globs: ["src/**"],
  });
});

test("a dotless token is ambiguous between file and directory", () => {
  // `Dockerfile` and `LICENSE` are files without an extension; a
  // directory-only glob would silently return nothing for them.
  assert.deepEqual(parseConstraint("Dockerfile"), {
    kind: "ambiguous",
    raw: "Dockerfile",
    globs: ["**/Dockerfile", "Dockerfile/**"],
  });
  assert.equal(parseConstraint("src")?.kind, "ambiguous");
  assert.equal(parseConstraint("packages/pi-search")?.kind, "ambiguous");
});

test("a nested dotless token stays rooted for the file reading", () => {
  assert.deepEqual(parseConstraint("src/LICENSE"), {
    kind: "ambiguous",
    raw: "src/LICENSE",
    globs: ["src/LICENSE", "src/LICENSE/**"],
  });
});

test("ambiguous tokens emit both readings in the plan", () => {
  const plan = planConstraints("Dockerfile", undefined);
  assert.deepEqual(plan.include, ["**/Dockerfile", "Dockerfile/**"]);
});

test("extensionless excludes negate both readings", () => {
  const plan = planConstraints(undefined, "Dockerfile");
  assert.deepEqual(plan.exclude, ["!**/Dockerfile", "!Dockerfile/**"]);
});

test("parseConstraint makes a bare filename match at any depth", () => {
  // Rooted 'main.rs' would only match the top level, silently hiding nested hits.
  assert.deepEqual(parseConstraint("main.rs"), {
    kind: "filename",
    raw: "main.rs",
    globs: ["**/main.rs"],
  });
});

test("parseConstraint keeps an explicit path rooted", () => {
  assert.deepEqual(parseConstraint("src/main.rs"), {
    kind: "filename",
    raw: "src/main.rs",
    globs: ["src/main.rs"],
  });
});

test("parseConstraint passes globs through untouched", () => {
  assert.deepEqual(parseConstraint("*.ts")?.globs, ["*.ts"]);
  assert.deepEqual(parseConstraint("src/**/*.cc")?.globs, ["src/**/*.cc"]);
  assert.deepEqual(parseConstraint("{src,lib}/**")?.globs, ["{src,lib}/**"]);
});

test("parseConstraint tolerates model path prefixes", () => {
  assert.deepEqual(parseConstraint("!test/")?.globs, ["test/**"]);
  assert.deepEqual(parseConstraint("! *.min.js")?.globs, ["*.min.js"]);
  assert.deepEqual(parseConstraint("@src/")?.globs, ["src/**"]);
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

test("an external extensionless file splits into root plus filename", () => {
  const external = mkdtempSync(path.join(tmpdir(), "pi-search-constraints-"));
  try {
    const file = path.join(external, "LICENSE");
    writeFileSync(file, "MIT\n");
    const plan = planConstraints(file, undefined);
    assert.equal(plan.searchRoot, external);
    assert.deepEqual(plan.include, ["LICENSE"]);
  } finally {
    rmSync(external, { recursive: true, force: true });
  }
});

test("an external dotless directory keeps the whole path as root", () => {
  const external = mkdtempSync(path.join(tmpdir(), "pi-search-constraints-"));
  try {
    const plan = planConstraints(path.join(external, "notes"), undefined);
    assert.equal(plan.searchRoot, path.join(external, "notes"));
    assert.deepEqual(plan.include, []);
  } finally {
    rmSync(external, { recursive: true, force: true });
  }
});

test("an unresolvable external dotless path defaults to the directory reading", () => {
  const plan = planConstraints("/definitely/not/here", undefined);
  assert.equal(plan.searchRoot, "/definitely/not/here");
  assert.deepEqual(plan.include, []);
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
