import assert from "node:assert/strict";
import { test } from "node:test";
import { piDocumentationSection, piSystemInstructionsPrompt } from "../lib/prompt.ts";

const SNAPSHOT = [
  "You are an expert coding assistant operating inside pi, a coding agent harness.",
  "",
  "Available tools:",
  "- read: Read file contents",
  "- bash: Run Bash; long commands yield and notify on exit",
  "",
  "Guidelines:",
  "- Use read to examine files instead of cat or sed.",
  "",
  "Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):",
  "- Main documentation: /opt/pi/README.md",
  "- Additional docs: /opt/pi/docs",
  "- Examples: /opt/pi/examples (extensions, custom tools, SDK)",
  "- Always read pi .md files completely and follow links to related docs",
  "",
  "<project_context>",
  "repo rules",
  "</project_context>",
  "",
  "Current working directory: /repo",
].join("\n");

test("piDocumentationSection extracts only the doc block", () => {
  const section = piDocumentationSection(SNAPSHOT);
  assert.match(section, /^Pi documentation/);
  assert.match(section, /Main documentation: \/opt\/pi\/README\.md/);
  assert.match(section, /Always read pi \.md files completely/);
  assert.doesNotMatch(section, /Available tools|project_context|working directory|Guidelines/);
});

test("piDocumentationSection falls back to the full snapshot", () => {
  assert.equal(piDocumentationSection("be terse"), "be terse");
});

test("piSystemInstructionsPrompt relays only the doc section", () => {
  const text = piSystemInstructionsPrompt(SNAPSHOT);
  assert.match(text, /Main documentation: \/opt\/pi\/README\.md/);
  assert.doesNotMatch(text, /Available tools/);
  assert.doesNotMatch(text, /repo rules/);
});

test("piSystemInstructionsPrompt reports a missing doc section", () => {
  assert.match(piSystemInstructionsPrompt(""), /no documentation section/);
});
