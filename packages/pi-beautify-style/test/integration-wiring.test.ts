import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "..");

function readSource(relative: string): string {
  return readFileSync(join(packageRoot, relative), "utf8");
}

// These assert the fork's wiring stays in place. They are deliberately
// source-level: the behavior they guard (which tools the vendored renderer
// treats as shell-like, which config path it reads) is decided at module load
// and is otherwise only observable through a live TUI.

test("the shell card treats background-terminal tools as shell-like", () => {
  const source = readSource("extensions/renderer/tool/ccstyle-tool.ts");
  assert.match(
    source,
    /return SHELL_TOOL_NAMES\.has\(toolName\) \|\| BACKGROUND_TERMINAL_TOOL_NAMES\.has\(toolName\)/,
  );
});

test("terminal tools are declared in the vendored name table", () => {
  const source = readSource("extensions/renderer/tool/names.ts");
  for (const name of ["terminal_wait", "terminal_stop", "terminal_log_read"]) {
    assert.ok(source.includes(`"${name}"`), `${name} missing from names.ts`);
  }
});

test("both ask-user tool names route to the answer-tree renderer", () => {
  const askUser = readSource("extensions/renderer/tool/ask-user-question.ts");
  assert.match(askUser, /export const ASK_USER_TOOL_NAME = "ask_user"/);
  assert.match(askUser, /export function isAskUserTool/);

  for (const file of [
    "extensions/renderer/tool/ccstyle-tool.ts",
    "extensions/renderer/tool/grouping.ts",
  ]) {
    const source = readSource(file);
    assert.ok(source.includes("isAskUserTool("), `${file} should route through isAskUserTool`);
    assert.ok(
      !source.includes("toolName === ASK_USER_QUESTION_TOOL_NAME"),
      `${file} still compares against the upstream name directly`,
    );
  }
});

test("compact mode keeps both ask-user names out of the summary count", () => {
  const source = readSource("extensions/renderer/compact-mode.ts");
  const outerTools = source.match(/const OUTER_TOOLS = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(outerTools, "OUTER_TOOLS declaration not found");
  assert.ok(outerTools[1].includes("ASK_USER_TOOL_NAME"));
  assert.ok(outerTools[1].includes("ASK_USER_QUESTION_TOOL_NAME"));
});

test("the footer folds this repo's usage status key into the usage chip", () => {
  const source = readSource("extensions/feature/shell/footer-layout.ts");
  assert.match(source, /export const LOCAL_USAGE_STATUS_KEY = "usage"/);
  assert.match(source, /new Set\(\["localUsage", "piUsage", LOCAL_USAGE_STATUS_KEY\]\)/);
});

test("the package has no runtime configuration surface", () => {
  // No settings panel, no /ccstyle command, no JSON file: every knob is a
  // source constant in extensions/config/config.ts.
  const config = readSource("extensions/config/config.ts");
  assert.doesNotMatch(config, /readFileSync|writeFileSync|CONFIG_PATH/);
  assert.doesNotMatch(config, /normalizeConfig|setConfig|updateConfig/);

  const renderer = readSource("extensions/renderer/index.ts");
  assert.doesNotMatch(renderer, /registerCommand\("ccstyle"/);
  assert.doesNotMatch(renderer, /showCcstylePanel/);
});

test("the package ships the vendored tree and both licenses", () => {
  const manifest = JSON.parse(readSource("package.json")) as {
    name: string;
    files: string[];
    pi: { extensions: string[] };
    dependencies: Record<string, string>;
  };
  assert.equal(manifest.name, "@tian.zuo/pi-beautify-style");
  for (const entry of ["index.ts", "extensions", "lib", "ATTRIBUTION.md"]) {
    assert.ok(manifest.files.includes(entry), `files is missing ${entry}`);
  }
  assert.deepEqual(manifest.pi.extensions, ["./index.ts"]);
  assert.equal("themes" in manifest.pi, false, "the package ships no theme files");
  // Vendored renderer imports @shikijs/cli lazily; it must be a real dependency.
  assert.ok(manifest.dependencies["@shikijs/cli"], "@shikijs/cli dependency missing");
});

test("the entry point boots the vendored style and exports the bridges", () => {
  const source = readSource("index.ts");
  assert.match(source, /claudeCodeStyle\(pi, installCompactThinking/);
  assert.match(source, /export \{[\s\S]*normalizeAnswers[\s\S]*\} from "\.\/lib\/our-tools\.ts"/);
});
