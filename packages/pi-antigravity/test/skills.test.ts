import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import {
  assignSkillToolNames,
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
  assert.ok(block.includes("/skills/grilling/SKILL.md"));
  assert.ok(block.includes("tool: pi__skill__grilling"));
  assert.ok(!block.includes("read its SKILL.md file directly"));
});

test("formatSkillCatalog advertises the session's bridge prefix exactly", () => {
  const block = formatSkillCatalog([SKILL], "bridge", "pi__p4242__");
  assert.ok(block);
  assert.ok(block.includes("tool: pi__p4242__skill__grilling"));
  assert.ok(!block.includes("tool: pi__skill__grilling"));
});

test("skillToolName reserves a namespace and sanitizes to MCP-safe characters", () => {
  assert.equal(skillToolName(SKILL), "skill__grilling");
  assert.equal(
    skillToolName({ ...SKILL, name: "pro360 workflow v2!" }),
    "skill__pro360_workflow_v2_",
  );
});

test("assignSkillToolNames gives sanitization collisions stable unique names", () => {
  const first = { ...SKILL, name: "a b", filePath: "/one/SKILL.md" };
  const second = { ...SKILL, name: "a?b", filePath: "/two/SKILL.md" };
  const assigned = assignSkillToolNames([first, second]);
  assert.equal(new Set(assigned.map(({ toolName }) => toolName)).size, 2);
  assert.ok(assigned.every(({ toolName }) => /^skill__a_b__[a-f0-9]{8}$/.test(toolName)));
  assert.deepEqual(assignSkillToolNames([first, second]), assigned);
  assert.deepEqual(assignSkillToolNames([first, { ...first }]), [
    { skill: first, toolName: "skill__a_b" },
  ]);
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
