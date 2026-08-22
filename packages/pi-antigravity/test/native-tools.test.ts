import assert from "node:assert/strict";
import { test } from "node:test";
import { mapAgyToolToNative } from "../lib/native-tools.ts";

test("maps read-only agy tools to native pi builtin calls", () => {
  assert.deepEqual(mapAgyToolToNative("view_file", { AbsolutePath: "/tmp/a.ts" }), {
    tool: "read",
    args: { path: "/tmp/a.ts" },
  });
  assert.deepEqual(mapAgyToolToNative("list_dir", { Path: "/tmp" }), {
    tool: "ls",
    args: { path: "/tmp" },
  });
  assert.deepEqual(
    mapAgyToolToNative("grep_search", { Query: "TODO", SearchPath: "/tmp" }),
    { tool: "grep", args: { pattern: "TODO", path: "/tmp" } },
  );
  assert.deepEqual(
    mapAgyToolToNative("find_by_name", { pattern: "*.test.ts" }),
    { tool: "find", args: { pattern: "*.test.ts" } },
  );
});

test("never maps mutating or specialty tools", () => {
  for (const tool of [
    "run_command",
    "write_to_file",
    "replace_file_content",
    "multi_replace_file_content",
    "sed_file",
    "search_web",
    "ask_question",
    "generate_image",
    "invoke_subagent",
    "call_mcp_tool",
  ]) {
    assert.equal(mapAgyToolToNative(tool, { path: "/tmp" }), undefined, tool);
  }
});

test("returns undefined when a required argument is missing", () => {
  assert.equal(mapAgyToolToNative("view_file", {}), undefined);
  assert.equal(mapAgyToolToNative("grep_search", { SearchPath: "/tmp" }), undefined);
  assert.equal(mapAgyToolToNative("find_by_name", {}), undefined);
  assert.equal(mapAgyToolToNative("list_dir", { path: "  " }), undefined);
});
