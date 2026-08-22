import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  formatSkillCatalog,
  nonWorkspaceSkills,
  readSkillBundle,
  skillToolName,
  type SkillLite,
} from "../lib/skills.ts";

const SKILL: SkillLite = {
  name: "grilling",
  description: "Interview the user relentlessly about a plan or design.",
  filePath: "/skills/grilling/SKILL.md",
  baseDir: "/skills/grilling",
};

test("formatSkillCatalog lists name, one-liner, and path", () => {
  const block = formatSkillCatalog([SKILL], "bridge");
  assert.ok(block);
  assert.ok(block.includes("## pi Agent Skills"));
  assert.ok(block.includes("- grilling: Interview the user relentlessly"));
  assert.ok(block.includes("(/skills/grilling/SKILL.md)"));
  assert.ok(block.includes("pi__<skill_name>"));
  assert.ok(!block.includes("read its SKILL.md file directly"));
});

test("formatSkillCatalog advertises the session's bridge prefix exactly", () => {
  const block = formatSkillCatalog([SKILL], "bridge", "pi__p4242__");
  assert.ok(block);
  assert.ok(block.includes("pi__p4242__<skill_name>"));
  assert.ok(!block.includes("pi__<skill_name>"));
});

test("skillToolName sanitizes to MCP-safe characters", () => {
  assert.equal(skillToolName(SKILL), "grilling");
  assert.equal(
    skillToolName({ ...SKILL, name: "pro360 workflow v2!" }),
    "pro360_workflow_v2_",
  );
});

test("formatSkillCatalog direct mode instructs reading the file", () => {
  const block = formatSkillCatalog([SKILL], "direct");
  assert.ok(block);
  assert.ok(block.includes("read its SKILL.md file directly"));
  assert.ok(!block.includes("pi__activate_skill"));
});

test("formatSkillCatalog truncates long descriptions and returns undefined when empty", () => {
  const long: SkillLite = { ...SKILL, description: "x".repeat(500) };
  const block = formatSkillCatalog([long], "bridge");
  assert.ok(block);
  assert.ok(block.length < 700);
  assert.equal(formatSkillCatalog([], "bridge"), undefined);
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

test("nonWorkspaceSkills drops skills inside the session cwd, keeps globals", () => {
  const project: SkillLite = { ...SKILL, filePath: "/repo/.agents/skills/proj/SKILL.md" };
  const global: SkillLite = {
    ...SKILL,
    name: "herdr",
    filePath: "/Users/x/.pi/agent/skills/herdr/SKILL.md",
  };
  const filtered = nonWorkspaceSkills([project, global], "/repo");
  assert.deepEqual(filtered.map((skill) => skill.name), ["herdr"]);
  // No session cwd (pre-session_start) → keep everything.
  assert.equal(nonWorkspaceSkills([project], undefined).length, 1);
});
