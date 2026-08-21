import assert from "node:assert/strict";
import { test } from "node:test";
import { agyToolLabel, formatAgyCall, summarizeAgyResult } from "../lib/render.ts";

// Minimal Theme stand-in: renderers only use fg() and bold().
const theme = {
  bold: (s: string) => s,
  fg: (_color: string, s: string) => s,
} as never;

test("agyToolLabel maps agy tools to native-equivalent labels", () => {
  assert.equal(agyToolLabel("grep_search"), "grep");
  assert.equal(agyToolLabel("find_by_name"), "find");
  assert.equal(agyToolLabel("view_file"), "read");
  assert.equal(agyToolLabel("list_dir"), "ls");
  assert.equal(agyToolLabel("run_command"), "bash");
  assert.equal(agyToolLabel("search_web"), "search_web");
});

test("formatAgyCall renders native-style call lines", () => {
  assert.equal(
    formatAgyCall("search_web", { query: "LA weather" }, theme),
    'search_web "LA weather"',
  );
  assert.equal(
    formatAgyCall("grep_search", { Query: "version", SearchPath: "/tmp/pkg" }, theme),
    'grep "version" in /tmp/pkg',
  );
  assert.equal(
    formatAgyCall("find_by_name", { Pattern: "*.fish", SearchDirectory: "/tmp/dot" }, theme),
    "find *.fish in /tmp/dot",
  );
  assert.equal(
    formatAgyCall("list_dir", { DirectoryPath: "/tmp/x" }, theme),
    "ls /tmp/x",
  );
  assert.equal(
    formatAgyCall("view_file", { AbsolutePath: "/tmp/a.md" }, theme),
    "read /tmp/a.md",
  );
  assert.equal(
    formatAgyCall("run_command", { command: "just test" }, theme),
    "bash just test",
  );
  assert.equal(
    formatAgyCall("run_command", { CommandLine: "sleep 120" }, theme),
    "bash sleep 120",
  );
});

test("formatAgyCall shortens $HOME paths and bounds unknown-tool JSON", () => {
  const home = process.env.HOME ?? "";
  assert.equal(
    formatAgyCall("view_file", { AbsolutePath: `${home}/notes` }, theme),
    "read ~/notes",
  );
  const long = formatAgyCall("custom_tool", { blob: "x".repeat(200) }, theme);
  assert.ok(long.length < 130, `unexpectedly long: ${long.length}`);
});

test("formatAgyCall covers orchestration and media tools", () => {
  assert.equal(
    formatAgyCall("ask_question", { Question: "Proceed?" }, theme),
    'ask_question "Proceed?"',
  );
  assert.equal(
    formatAgyCall("generate_image", { prompt: "a logo" }, theme),
    'generate_image "a logo"',
  );
  assert.equal(
    formatAgyCall("invoke_subagent", { Name: "researcher" }, theme),
    "invoke_subagent researcher",
  );
  assert.equal(
    formatAgyCall("send_message", { to: "researcher", Message: "status?" }, theme),
    'send_message researcher "status?"',
  );
  assert.equal(
    formatAgyCall("manage_task", { Action: "list" }, theme),
    "manage_task list",
  );
  // Unknown shapes fall back to a bounded key/value summary, not raw JSON.
  const generic = formatAgyCall("schedule", { cron: "* * * * *", prompt: "run tests" }, theme);
  assert.match(generic, /schedule/);
  assert.match(generic, /cron/);
  assert.ok(!generic.includes("{"));
});

test("summarizeAgyResult counts grep matches and find results", () => {
  const grep = summarizeAgyResult("grep_search", './a.ts: one\n./a.ts: two\n./b.ts: three\n');
  assert.deepEqual(grep, { counts: "3 matches in 2 files" });

  const single = summarizeAgyResult("grep_search", "./package.json: \"version\"");
  assert.deepEqual(single, { counts: "1 match in 1 file" });

  const found = summarizeAgyResult("find_by_name", "x.txt\ny.txt\n");
  assert.deepEqual(found, { counts: "2 results" });

  const one = summarizeAgyResult("find_by_name", "x.txt\n");
  assert.deepEqual(one, { counts: "1 result" });

  const none = summarizeAgyResult("find_by_name", "");
  assert.deepEqual(none, { counts: "no results" });

  assert.deepEqual(summarizeAgyResult("search_web", undefined), {});
});
