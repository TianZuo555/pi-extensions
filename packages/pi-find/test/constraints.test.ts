import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  parseConstraint,
  planConstraints as planConstraintResult,
  splitConstraints,
  type ConstraintPlan,
} from "../lib/constraints.ts";

function planConstraints(
  pathConstraint: string | readonly string[] | undefined,
  exclude: string | readonly string[] | undefined,
  cwd?: string,
): ConstraintPlan {
  const result = planConstraintResult(pathConstraint, exclude, cwd);
  if (result.kind === "invalid") {
    throw new Error(`unexpected invalid plan: ${result.reason}`);
  }
  return result.plan;
}

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
    globs: ["Dockerfile", "Dockerfile/**"],
  });
  assert.equal(parseConstraint("src")?.kind, "ambiguous");
  assert.equal(parseConstraint("packages/pi-find")?.kind, "ambiguous");
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
  assert.deepEqual(plan.include, ["Dockerfile", "Dockerfile/**"]);
});

test("extensionless excludes keep both matcher readings", () => {
  const plan = planConstraints(undefined, "Dockerfile");
  assert.deepEqual(plan.exclude, ["Dockerfile", "Dockerfile/**"]);
});

test("parseConstraint keeps bare filename as raw glob for ripgrep/fd", () => {
  assert.deepEqual(parseConstraint("main.rs"), {
    kind: "filename",
    raw: "main.rs",
    globs: ["main.rs"],
  });
});

test("parseConstraint keeps an explicit path rooted", () => {
  assert.deepEqual(parseConstraint("src/main.rs"), {
    kind: "filename",
    raw: "src/main.rs",
    globs: ["src/main.rs"],
  });
});

test("planConstraints extracts searchDirs only for explicit directory constraints", () => {
  const plan1 = planConstraints("src/", undefined);
  assert.deepEqual(plan1.searchDirs, ["src"]);

  const plan2 = planConstraints(["packages/pi-find/", "packages/pi-commit/"], undefined);
  assert.deepEqual(plan2.searchDirs, ["packages/pi-find", "packages/pi-commit"]);

  // Non-directory shapes (filename, ambiguous, glob) are never pushed down as searchDirs
  const plan3 = planConstraints("src/deep/b.ts", undefined);
  assert.deepEqual(plan3.searchDirs, []);

  const plan4 = planConstraints("pkg/LICENSE", undefined);
  assert.deepEqual(plan4.searchDirs, []);

  const plan5 = planConstraints("*.ts", undefined);
  assert.deepEqual(plan5.searchDirs, []);

  const plan6 = planConstraints("src/, *.ts", undefined);
  assert.deepEqual(plan6.searchDirs, []);
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

test("parseConstraint normalizes redundant ./ prefixes and root .", () => {
  assert.deepEqual(parseConstraint("./src/"), {
    kind: "directory",
    raw: "src/",
    globs: ["src/**"],
  });
  assert.deepEqual(parseConstraint("./main.rs"), {
    kind: "filename",
    raw: "main.rs",
    globs: ["main.rs"],
  });
  assert.deepEqual(parseConstraint("."), {
    kind: "directory",
    raw: "./",
    globs: ["**"],
  });
  assert.deepEqual(parseConstraint("./"), {
    kind: "directory",
    raw: "./",
    globs: ["**"],
  });
});

test("parseConstraint normalizes static prefix in globs", () => {
  assert.deepEqual(parseConstraint("./*.ts")?.globs, ["*.ts"]);
  assert.deepEqual(parseConstraint("./src/*.ts")?.globs, ["src/*.ts"]);
  assert.deepEqual(parseConstraint("a/../*.ts")?.globs, ["*.ts"]);
  assert.deepEqual(parseConstraint("./{src,lib}/**")?.globs, ["{src,lib}/**"]);
});

test("planConstraints handles . combined with other directories", () => {
  const plan = planConstraints([".", "src/"], undefined);
  assert.deepEqual(plan.include, ["**", "src/**"]);
  assert.deepEqual(plan.searchDirs, ["."]);

  const excludePlan = planConstraints(undefined, ".");
  assert.deepEqual(excludePlan.exclude, ["**"]);
});

test("planConstraints prunes subsumed child directories from searchDirs", () => {
  const plan = planConstraints(["src/", "src/deep/"], undefined);
  assert.deepEqual(plan.searchDirs, ["src"]);

  const reversePlan = planConstraints(["src/deep/", "src/"], undefined);
  assert.deepEqual(reversePlan.searchDirs, ["src"]);
});

test("parseConstraint normalizes pure .. sequences to directory constraints", () => {
  assert.deepEqual(parseConstraint(".."), {
    kind: "directory",
    raw: "../",
    globs: ["../**"],
  });
  assert.deepEqual(parseConstraint("../"), {
    kind: "directory",
    raw: "../",
    globs: ["../**"],
  });
  assert.deepEqual(parseConstraint("../.."), {
    kind: "directory",
    raw: "../../",
    globs: ["../../**"],
  });
  assert.deepEqual(parseConstraint("../../"), {
    kind: "directory",
    raw: "../../",
    globs: ["../../**"],
  });
});

test("parseConstraint performs lexical normalization on relative paths without globs", () => {
  assert.deepEqual(parseConstraint("a/../b/"), {
    kind: "directory",
    raw: "b/",
    globs: ["b/**"],
  });
  assert.deepEqual(parseConstraint("a/../b"), {
    kind: "ambiguous",
    raw: "b",
    globs: ["b", "b/**"],
  });
  assert.deepEqual(parseConstraint("../a/../b/"), {
    kind: "directory",
    raw: "../b/",
    globs: ["../b/**"],
  });
});

test("planConstraints enforces all-or-nothing gate for searchDirs", () => {
  // If even one constraint is not an explicit directory, searchDirs must be empty
  // so global search/minimatch can discover files outside the directories.
  const planGlob = planConstraints(["src/", "*.ts"], undefined);
  assert.deepEqual(planGlob.searchDirs, []);

  const planFilename = planConstraints(["src/", "README.md"], undefined);
  assert.deepEqual(planFilename.searchDirs, []);
});

test("planConstraints treats parent ../ directory as external root", () => {
  const plan = planConstraints("../sibling/", undefined);
  assert.equal(plan.searchRoot, "../sibling");
  assert.deepEqual(plan.include, []);
  assert.deepEqual(plan.searchDirs, []);
});

test("an absolute filename becomes a root plus exact include", () => {
  const plan = planConstraints("/tmp/project/src/main.ts", undefined);
  assert.equal(plan.searchRoot, "/tmp/project/src");
  assert.deepEqual(plan.include, ["/main.ts"]);
});

test("an absolute glob becomes a root plus relative glob", () => {
  const plan = planConstraints("/tmp/project/src/**/*.ts", undefined);
  assert.equal(plan.searchRoot, "/tmp/project/src");
  assert.deepEqual(plan.include, ["/**/*.ts"]);
});

test("a home-relative glob becomes a root plus relative glob", () => {
  const plan = planConstraints("~/project/src/*.ts", undefined);
  assert.equal(plan.searchRoot, path.join(homedir(), "project/src").replaceAll("\\", "/"));
  assert.deepEqual(plan.include, ["/*.ts"]);
});

test("home paths containing .. stay external absolute paths", () => {
  const expectedFoo = path.join(homedir(), "../foo").replaceAll("\\", "/") + "/";
  assert.equal(parseConstraint("~/../foo/")?.raw, expectedFoo);
  assert.equal(parseConstraint("~/a/../../foo/")?.raw, expectedFoo);

  const parsedGlob = parseConstraint("~/../*.ts");
  const expectedGlobPrefix = path.join(homedir(), "..").replaceAll("\\", "/") + "/";
  assert.equal(parsedGlob?.raw, `${expectedGlobPrefix}*.ts`);
});

test("Windows drive root preserves trailing slash and formats glob without double slash", () => {
  const driveSlash = parseConstraint("C:/");
  assert.equal(driveSlash?.kind, "directory");
  assert.equal(driveSlash?.raw, "C:/");
  assert.deepEqual(driveSlash?.globs, ["C:/**"]);

  const driveBackslash = parseConstraint("C:\\");
  assert.equal(driveBackslash?.kind, "directory");
  assert.equal(driveBackslash?.raw, "C:/");
  assert.deepEqual(driveBackslash?.globs, ["C:/**"]);
});

test("planConstraints rewrites external excludes relative to external searchRoot", () => {
  // 1. Absolute path + absolute exclude
  const planAbs = planConstraints("/tmp/outside/", "/tmp/outside/test/");
  assert.equal(planAbs.searchRoot, "/tmp/outside");
  assert.deepEqual(planAbs.exclude, ["test/**"]);

  // 2. Home path + home exclude
  const homeOutside = path.join(homedir(), "outside").replaceAll("\\", "/");
  const planHome = planConstraints("~/outside/", "~/outside/test/");
  assert.equal(planHome.searchRoot, homeOutside);
  assert.deepEqual(planHome.exclude, ["test/**"]);

  // 3. Parent relative path + parent relative exclude
  const planParent = planConstraints("../outside/", "../outside/test/");
  assert.equal(planParent.searchRoot, "../outside");
  assert.deepEqual(planParent.exclude, ["test/**"]);

  // 4. External root + relative test/ exclude
  const planRelDir = planConstraints("/tmp/outside/", "test/", "/workspace");
  assert.equal(planRelDir.searchRoot, "/tmp/outside");
  assert.deepEqual(planRelDir.exclude, ["test/**"]);

  // 5. External root + nested relative filename exclude
  const planRelFile = planConstraints("/tmp/outside/", "src/deep/drop.ts", "/workspace");
  assert.equal(planRelFile.searchRoot, "/tmp/outside");
  assert.deepEqual(planRelFile.exclude, ["src/deep/drop.ts"]);

  // 6. External root + slashless relative exclude
  const planRelGlob = planConstraints("/tmp/outside/", "*.min.js", "/workspace");
  assert.equal(planRelGlob.searchRoot, "/tmp/outside");
  assert.deepEqual(planRelGlob.exclude, ["*.min.js"]);
});

test("planConstraints normalizes absolute exclude under default cwd or relative path", () => {
  // 1. Default cwd + absolute exclude
  const planCwd = planConstraints(undefined, "/workspace/test/", "/workspace");
  assert.equal(planCwd.searchRoot, undefined);
  assert.deepEqual(planCwd.exclude, ["test/**"]);

  // 2. Relative path + absolute exclude
  const planRel = planConstraints("src/", "/workspace/src/generated/", "/workspace");
  assert.equal(planRel.searchRoot, undefined);
  assert.deepEqual(planRel.include, ["src/**"]);
  assert.deepEqual(planRel.exclude, ["src/generated/**"]);
});

test("planConstraints preserves root-anchored includes and excludes for absolute files and globs", () => {
  // 1. Absolute exact file include
  const planFile = planConstraints("/workspace/main.ts", undefined, "/workspace");
  assert.equal(planFile.searchRoot, "/workspace");
  assert.deepEqual(planFile.include, ["/main.ts"]);

  // 2. Absolute glob include
  const planGlob = planConstraints("/workspace/*.ts", undefined, "/workspace");
  assert.equal(planGlob.searchRoot, "/workspace");
  assert.deepEqual(planGlob.include, ["/*.ts"]);

  // 3. Absolute exact file exclude
  const planFileExcl = planConstraints(undefined, "/workspace/main.ts", "/workspace");
  assert.equal(planFileExcl.searchRoot, undefined);
  assert.deepEqual(planFileExcl.exclude, ["/main.ts"]);

  // 4. Absolute glob exclude
  const planGlobExcl = planConstraints(undefined, "/workspace/*.ts", "/workspace");
  assert.equal(planGlobExcl.searchRoot, undefined);
  assert.deepEqual(planGlobExcl.exclude, ["/*.ts"]);
});

test("planConstraints rebases ancestor glob excludes segment-by-segment", () => {
  const plan = planConstraints("/tmp/project/", "/tmp/*/*.ts", "/workspace");
  assert.equal(plan.searchRoot, "/tmp/project");
  assert.deepEqual(plan.exclude, ["/*.ts"]);

  const planDisjoint = planConstraints("/tmp/project/", "/tmp/other/*.ts", "/workspace");
  assert.equal(planDisjoint.searchRoot, "/tmp/project");
  assert.deepEqual(planDisjoint.exclude, []);
});

test("planConstraints keeps relative exclude in cwd namespace when path is in-workspace absolute", () => {
  const plan = planConstraints("/workspace/src/", "src/deep/", "/workspace");
  assert.equal(plan.searchRoot, "/workspace/src");
  assert.deepEqual(plan.exclude, ["src/deep/**"]);
});

test("planConstraints resolves parent search roots against request cwd before rebasing excludes", () => {
  const cwd = "/workspace";
  const exact = planConstraints(
    "../workspace/src/",
    "/workspace/src/test/drop.ts",
    cwd,
  );
  assert.equal(exact.searchRoot, "../workspace/src");
  assert.deepEqual(exact.exclude, ["/src/test/drop.ts"]);

  const ambiguous = planConstraints(
    "../workspace/src/",
    "/workspace/src/test",
    cwd,
  );
  assert.deepEqual(ambiguous.exclude, ["/src/test", "/src/test/**"]);
});

test("an external extensionless file splits into root plus filename", () => {
  const external = mkdtempSync(path.join(tmpdir(), "pi-find-constraints-"));
  try {
    const file = path.join(external, "LICENSE");
    writeFileSync(file, "MIT\n");
    const plan = planConstraints(file, undefined);
    assert.equal(plan.searchRoot, external);
    assert.deepEqual(plan.include, ["/LICENSE"]);
  } finally {
    rmSync(external, { recursive: true, force: true });
  }
});

test("an external dotless directory keeps the whole path as root", () => {
  const external = mkdtempSync(path.join(tmpdir(), "pi-find-constraints-"));
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

test("an external path mixed with any other include is an invalid plan", () => {
  assert.deepEqual(
    planConstraintResult(["/tmp/a/", "*.ts"], "test/"),
    { kind: "invalid", reason: "mixed-external-path" },
  );
  assert.deepEqual(
    planConstraintResult(["/tmp/a/", "/tmp/b/"], undefined),
    { kind: "invalid", reason: "mixed-external-path" },
  );
});

test("excludes remain engine-neutral matcher globs", () => {
  const plan = planConstraints(undefined, "test/,*.min.js");
  assert.deepEqual(plan.exclude, ["test/**", "*.min.js"]);
});

test("planConstraints keeps relative includes and excludes in one namespace", () => {
  const plan = planConstraints("packages/", "!packages/test/");
  assert.equal(plan.searchRoot, undefined);
  assert.deepEqual(plan.include, ["packages/**"]);
  assert.deepEqual(plan.exclude, ["packages/test/**"]);
});

test("no constraints produce an empty plan", () => {
  const plan = planConstraints(undefined, undefined);
  assert.deepEqual(plan.include, []);
  assert.deepEqual(plan.exclude, []);
  assert.deepEqual(plan.searchDirs, []);
  assert.equal(plan.searchRoot, undefined);
});
