import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import {
  ACTIVATE_SKILL_TOOL_NAME,
  activateSkillDescription,
  activateSkillParameters,
  findSkillByName,
  formatSkillCatalog,
  handleActivateSkill,
  nonWorkspaceSkills,
  readSkillBundle,
  usableSkillCatalog,
  type SkillLite,
} from "../lib/skills.ts";

const SKILL: SkillLite = {
  name: "grilling",
  description: "Interview the user relentlessly about a plan or design.",
  filePath: "/skills/grilling/SKILL.md",
  baseDir: "/skills/grilling",
};

test("activate_skill schema enum is the catalog", () => {
  const other: SkillLite = { ...SKILL, name: "herdr", filePath: "/skills/herdr/SKILL.md" };
  const schema = activateSkillParameters([SKILL, other]);
  assert.equal(ACTIVATE_SKILL_TOOL_NAME, "activate_skill");
  assert.deepEqual(schema, {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Skill name to activate (from this tool's enum).",
        enum: ["grilling", "herdr"],
      },
    },
    required: ["name"],
  });
});

test("activateSkillDescription carries each skill's one-liner", () => {
  const other: SkillLite = {
    ...SKILL,
    name: "herdr",
    description: "Control Herdr, a terminal multiplexer for coding agents.",
    filePath: "/skills/herdr/SKILL.md",
  };
  const description = activateSkillDescription([SKILL, other]);
  // Progressive disclosure: agy must be able to tell WHEN a skill applies
  // from tools/list alone, not just from its bare name in the enum.
  assert.match(description, /Pass `name` from this tool's enum/);
  assert.match(description, /- grilling: Interview the user relentlessly/);
  assert.match(description, /- herdr: Control Herdr, a terminal multiplexer/);
});

test("activateSkillDescription truncates one-liners and omits an empty catalog", () => {
  const long: SkillLite = { ...SKILL, description: "x".repeat(500) };
  const description = activateSkillDescription([long]);
  assert.ok(description.length < 400);
  assert.ok(!activateSkillDescription([]).includes("Available skills:"));
});

test("usableSkillCatalog skips empty paths and keeps the first name", () => {
  const dup: SkillLite = { ...SKILL, filePath: "/other/grilling/SKILL.md" };
  const empty: SkillLite = { ...SKILL, name: "ghost", filePath: "" };
  assert.deepEqual(
    usableSkillCatalog([SKILL, dup, empty]).map((skill) => skill.filePath),
    [SKILL.filePath],
  );
  assert.equal(findSkillByName([SKILL, dup], " grilling "), SKILL);
});

test("formatSkillCatalog lists name, one-liner, and path for direct reads", () => {
  const block = formatSkillCatalog([SKILL]);
  assert.ok(block);
  assert.ok(block.includes("## pi Agent Skills"));
  assert.ok(block.includes("- grilling: Interview the user relentlessly"));
  assert.ok(block.includes("/skills/grilling/SKILL.md"));
  assert.ok(block.includes("read its SKILL.md file directly"));
  assert.ok(!block.includes("pi__skill__"));
  assert.ok(!block.includes("activate_skill"));
});

test("formatSkillCatalog truncates long descriptions and returns undefined when empty", () => {
  const long: SkillLite = { ...SKILL, description: "x".repeat(500) };
  const block = formatSkillCatalog([long]);
  assert.ok(block);
  assert.ok(block.length < 700);
  assert.equal(formatSkillCatalog([]), undefined);
});

test("handleActivateSkill returns the bundle or lists available names", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "agy-skill-activate-"));
  try {
    await writeFile(path.join(dir, "SKILL.md"), "Do the grilling.\n");
    const skill: SkillLite = {
      ...SKILL,
      filePath: path.join(dir, "SKILL.md"),
      baseDir: dir,
    };
    const ok = await handleActivateSkill([skill], { name: "grilling" });
    assert.equal(ok.isError, false);
    assert.ok(ok.content.includes("Do the grilling."));

    const missing = await handleActivateSkill([skill], { name: "nope" });
    assert.equal(missing.isError, true);
    assert.match(missing.content, /skill "nope" is not available/);
    assert.match(missing.content, /Available: grilling/);

    const blank = await handleActivateSkill([skill], { name: "  " });
    assert.equal(blank.isError, true);
    assert.match(blank.content, /no skill name was provided/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readSkillBundle returns SKILL.md body and absolute resource paths", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "agy-skill-"));
  try {
    await writeFile(path.join(dir, "SKILL.md"), "---\nname: demo\n---\n\nDo the thing.\n");
    await writeFile(path.join(dir, "helper.sh"), "echo hi");
    await mkdir(path.join(dir, "docs"));
    const bundle = await readSkillBundle({
      name: "demo",
      description: "",
      filePath: path.join(dir, "SKILL.md"),
      baseDir: dir,
    });
    assert.equal(bundle.isError, false);
    assert.ok(bundle.content.includes("Do the thing."));
    assert.ok(bundle.content.includes(`- ${path.join(dir, "docs")}/`));
    assert.ok(bundle.content.includes(`- ${path.join(dir, "helper.sh")}`));
    assert.ok(!bundle.content.includes("SKILL.md\n- "));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readSkillBundle reports unreadable skills as errors", async () => {
  const result = await readSkillBundle({
    name: "ghost",
    description: "",
    filePath: "/nonexistent/SKILL.md",
    baseDir: "/nonexistent",
  });
  assert.equal(result.isError, true);
  assert.match(result.content, /failed to read skill "ghost"/);
});

test("readSkillBundle returns the complete SKILL.md instructions", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "agy-skill-long-"));
  try {
    const tail = "END-OF-SKILL-INSTRUCTIONS";
    await writeFile(path.join(dir, "SKILL.md"), `${"x".repeat(30_000)}\n${tail}\n`);
    const bundle = await readSkillBundle({
      name: "long",
      description: "",
      filePath: path.join(dir, "SKILL.md"),
      baseDir: dir,
    });
    assert.equal(bundle.isError, false);
    assert.ok(bundle.content.includes(tail));
    assert.ok(!bundle.content.includes("truncated after"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("nonWorkspaceSkills drops skills inside the session cwd, keeps globals", () => {
  const project: SkillLite = { ...SKILL, filePath: "/repo/.agents/skills/proj/SKILL.md" };
  const ancestorProject: SkillLite = {
    ...SKILL,
    name: "ancestor",
    filePath: "/repo/.agents/skills/ancestor/SKILL.md",
  };
  const global: SkillLite = {
    ...SKILL,
    name: "herdr",
    filePath: "/Users/x/.pi/agent/skills/herdr/SKILL.md",
  };
  const homeGlobal: SkillLite = {
    ...SKILL,
    name: "home-global",
    filePath: path.join(homedir(), ".agents/skills/home-global/SKILL.md"),
  };
  const filtered = nonWorkspaceSkills(
    [project, ancestorProject, global, homeGlobal],
    "/repo/packages/child",
  );
  assert.deepEqual(
    filtered.map((skill) => skill.name),
    ["herdr", "home-global"],
  );
  // No session cwd (pre-session_start) → keep everything.
  assert.equal(nonWorkspaceSkills([project], undefined).length, 1);
});
