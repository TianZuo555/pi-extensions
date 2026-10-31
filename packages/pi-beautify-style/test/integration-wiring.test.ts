import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { applyCustomFooter } from "../extensions/feature/shell/footer.ts";
import { config } from "../extensions/config/config.ts";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "..");

function readSource(relative: string): string {
  return readFileSync(join(packageRoot, relative), "utf8");
}

// Render the active footer with a fixed set of extension statuses. The stub
// ctx/ui/footerData mirrors what Pi hands the footer factory.
function footerWithStatuses(statuses: Map<string, string>): {
  render: (width: number) => string[];
  dispose: () => void;
} {
  let footer!: { render: (width: number) => string[]; dispose: () => void };
  const ctx = {
    cwd: process.cwd(),
    hasUI: true,
    model: undefined,
    thinkingLevel: "off",
    getContextUsage: () => undefined,
    sessionManager: {
      getBranch: () => [],
      getEntries: () => [],
      getSessionName: () => undefined,
    },
    ui: {
      setFooter: (factory: any) => {
        footer = factory(
          { requestRender: () => {} },
          {
            fg: (_color: string, text: string) => text,
            getThinkingBorderColor: () => (text: string) => text,
          },
          {
            getGitBranch: () => undefined,
            getExtensionStatuses: () => statuses,
            onBranchChange: () => () => {},
          },
        );
      },
    },
  };
  applyCustomFooter(ctx as never);
  return footer;
}

function plainLines(footer: { render: (width: number) => string[] }): string[] {
  return footer.render(200).map((line) => line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ""));
}

function countOccurrences(lines: string[], text: string): number {
  return lines.join("\n").split(text).length - 1;
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

test("setStatus('usage') text renders once, on the plugin line", (t) => {
  const previousHidden = config.footerHiddenKeys;
  t.after(() => {
    config.footerHiddenKeys = previousHidden;
  });
  const footer = footerWithStatuses(new Map([["usage", "Codex 80%"]]));
  t.after(() => footer.dispose());
  const lines = plainLines(footer);
  assert.equal(lines.length, 3, `usage opens the third row: ${JSON.stringify(lines)}`);
  assert.ok(
    lines[2]!.includes("Codex 80%"),
    `usage text must render on the plugin line, got: ${lines[2]}`,
  );
  assert.equal(
    countOccurrences(lines, "Codex 80%"),
    1,
    "the usage status must not render as a second chip",
  );

  // 隐藏 pi-usage 时别名跟着消失：两者共用同一个槽位。
  config.footerHiddenKeys = ["pi-usage"];
  assert.equal(
    countOccurrences(plainLines(footer), "Codex 80%"),
    0,
    "the usage alias shares the pi-usage slot, including its hidden state",
  );
});

test("the usage alias takes the pi-usage slot instead of rendering beside it", (t) => {
  const footer = footerWithStatuses(
    new Map([
      ["pi-usage", "xAI 14%"],
      ["usage", "Codex 80%"],
    ]),
  );
  t.after(() => footer.dispose());
  const lines = plainLines(footer);
  assert.ok(lines[2]!.includes("Codex 80%"));
  assert.equal(
    countOccurrences(lines, "Codex 80%"),
    1,
    "the usage alias fills the pi-usage slot rather than adding a chip",
  );
  assert.equal(
    countOccurrences(lines, "xAI 14%"),
    0,
    "the alias wins the shared usage slot",
  );
});

test("setStatus('token-speed') fills the rate chip instead of a second chip", (t) => {
  const footer = footerWithStatuses(new Map([["token-speed", "120 tok/s"]]));
  t.after(() => footer.dispose());
  const lines = plainLines(footer);
  assert.ok(
    lines[0]!.includes("120 tok/s"),
    `token-speed text must fill the rate slot on line 1, got: ${lines[0]}`,
  );
  assert.equal(
    countOccurrences(lines, "120 tok/s"),
    1,
    "the token-speed status must not render as a separate plugin chip",
  );
});

test("all plugin chips share line 3 so the first two lines never grow", (t) => {
  const footer = footerWithStatuses(
    new Map([
      ["ponytail", "PONYTAIL"],
      ["lsp", "LSP"],
      ["cloud-quota", "QUOTA"],
      ["usage", "USAGE"],
    ]),
  );
  t.after(() => footer.dispose());
  const lines = plainLines(footer);
  assert.equal(lines.length, 3, `footer keeps exactly three rows: ${JSON.stringify(lines)}`);
  assert.ok(lines[0]!.includes("no-model"), `line1 carries the model chip: ${lines[0]}`);
  assert.ok(!lines[0]!.includes("PONYTAIL"), `line1 stays free of plugin chips: ${lines[0]}`);
  assert.ok(lines[1]!.includes("pi-beautify-style"), `line2 carries the cwd: ${lines[1]}`);
  assert.ok(!lines[1]!.includes("PONYTAIL"), `line2 stays free of plugin chips: ${lines[1]}`);
  for (const text of ["QUOTA", "LSP", "PONYTAIL", "USAGE"]) {
    assert.ok(lines[2]!.includes(text), `line3 carries ${text}: ${lines[2]}`);
  }
});

test("the MCP chip rides the location row, not the plugin row", () => {
  // MCP 是位置信息（和 cwd、分支同排），由本包自己画，不走 setStatus 通道。
  const source = readSource("extensions/feature/shell/footer.ts");
  assert.match(
    source,
    /const line2 = joinChips\(\[\s*builtinLine\(FOOTER_LINE2_KEYS\),\s*mcpChip \?/,
    "line2 must concatenate the MCP chip after the location chips",
  );
  assert.doesNotMatch(
    source,
    /pluginTexts\.set\(MCP_STATUS_KEY/,
    "the MCP chip must not enter the plugin channel that feeds line 3",
  );
});

test("line3 disappears entirely when no plugin publishes text", (t) => {
  const footer = footerWithStatuses(new Map());
  t.after(() => footer.dispose());
  const lines = plainLines(footer);
  assert.equal(lines.length, 2, `two rows without plugins: ${JSON.stringify(lines)}`);
});

test("model-facing reference text lives in lib/prompt.ts", () => {
  const prompt = readSource("lib/prompt.ts");
  assert.match(prompt, /export function subagentDelegationMessage/);
  assert.match(prompt, /export const SESSION_REFERENCE_HEADER/);

  // 运行时文件只做拼接，不再内嵌提示文本。
  const subagent = readSource("extensions/feature/reference/subagent.ts");
  assert.match(subagent, /subagentDelegationMessage\(agentList\)/);
  assert.doesNotMatch(subagent, /You MUST use the Agent tool/);

  const session = readSource("extensions/feature/reference/session.ts");
  assert.match(session, /SESSION_REFERENCE_HEADER/);
  assert.doesNotMatch(session, /untrusted background context/);
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
  assert.match(source, /export \{ isAskUserTool \}/);
});
