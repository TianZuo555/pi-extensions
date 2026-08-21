/** Real NDJSON captured from `agy --print --dangerously-skip-permissions
 * --output-format stream-json` (agy 1.1.17, 2026-08-21). Paths trimmed. */

export const CONVERSATION_ID = "4df4b685-e326-4498-b423-4732961ac2e4";

export const REAL_CAPTURE = [
  JSON.stringify({
    event: "init",
    conversation_id: CONVERSATION_ID,
    init: {
      cwd: "/Users/tian.zuo/Workspace/pi-tian-extensions",
      tools: ["ask_question", "run_command", "view_file", "write_to_file"],
      permission_mode: "request-review",
    },
  }),
  JSON.stringify({
    event: "step_update",
    step_update: { conversation_id: CONVERSATION_ID, step_index: 0, state: "DONE", step_type: "user_input" },
  }),
  JSON.stringify({
    event: "step_update",
    step_update: {
      conversation_id: CONVERSATION_ID,
      step_index: 2,
      state: "DONE",
      step_type: "agent_response",
      duration_seconds: 1.761,
      usage: { input_tokens: 13712, output_tokens: 264, thinking_tokens: 191, cache_read_tokens: 0, total_tokens: 13976 },
    },
  }),
  JSON.stringify({
    event: "step_update",
    step_update: {
      conversation_id: CONVERSATION_ID,
      step_index: 3,
      state: "ACTIVE",
      step_type: "tool",
      tool_name: "view_file",
      tool_info: { name: "view_file", parameters: { AbsolutePath: "/tmp/notes/todo.md" } },
    },
  }),
  JSON.stringify({
    event: "step_update",
    step_update: {
      conversation_id: CONVERSATION_ID,
      step_index: 3,
      state: "DONE",
      step_type: "tool",
      tool_name: "view_file",
      duration_seconds: 0.061531,
      tool_info: { name: "view_file", parameters: { AbsolutePath: "/tmp/notes/todo.md" } },
      output: "55 lines, 2955 bytes",
    },
  }),
  JSON.stringify({
    event: "step_update",
    step_update: {
      conversation_id: CONVERSATION_ID,
      step_index: 7,
      state: "ACTIVE",
      step_type: "tool",
      tool_name: "run_command",
      tool_info: { name: "run_command", parameters: { CommandLine: "echo hi" } },
    },
  }),
  JSON.stringify({
    event: "step_update",
    step_update: {
      conversation_id: CONVERSATION_ID,
      step_index: 7,
      state: "ERROR",
      step_type: "tool",
      tool_name: "run_command",
      duration_seconds: 0.066267,
      tool_info: { name: "run_command", parameters: { CommandLine: "echo hi" } },
      error: { type: "TOOL_ERROR", message: "permission check failed" },
    },
  }),
  JSON.stringify({
    event: "result",
    result: {
      conversation_id: CONVERSATION_ID,
      status: "ERROR",
      response: "",
      error: 'permission check failed for command "echo hi": user denied permission',
      duration_seconds: 8.014562,
      num_turns: 1,
      usage: { input_tokens: 44909, output_tokens: 610, thinking_tokens: 395, cache_read_tokens: 0, total_tokens: 45519 },
    },
  }),
].join("\n");

/** Synthetic successful turn with streaming tool activity and final text. */
export const OK_CAPTURE = [
  JSON.stringify({ event: "init", conversation_id: "c-ok-1", init: { cwd: "/tmp", tools: [], permission_mode: "auto" } }),
  JSON.stringify({
    event: "step_update",
    step_update: { conversation_id: "c-ok-1", step_index: 1, state: "ACTIVE", step_type: "tool", tool_name: "list_dir", tool_info: { name: "list_dir", parameters: { Path: "/tmp" } } },
  }),
  JSON.stringify({
    event: "step_update",
    step_update: { conversation_id: "c-ok-1", step_index: 1, state: "DONE", step_type: "tool", tool_name: "list_dir", duration_seconds: 0.1, output: "3 entries" },
  }),
  JSON.stringify({
    event: "step_update",
    step_update: { conversation_id: "c-ok-1", step_index: 2, state: "ACTIVE", step_type: "agent_response", text_delta: "Hello " },
  }),
  JSON.stringify({
    event: "step_update",
    step_update: { conversation_id: "c-ok-1", step_index: 2, state: "DONE", step_type: "agent_response", text_delta: "from agy!", duration_seconds: 0.4, usage: { input_tokens: 100, output_tokens: 20, thinking_tokens: 5, cache_read_tokens: 0, total_tokens: 120 } },
  }),
  JSON.stringify({
    event: "result",
    result: {
      conversation_id: "c-ok-1",
      status: "OK",
      response: "Hello from agy!",
      duration_seconds: 2.5,
      num_turns: 1,
      usage: { input_tokens: 100, output_tokens: 20, thinking_tokens: 5, cache_read_tokens: 0, total_tokens: 120 },
    },
  }),
].join("\n");

/** `agy models` output shape (agy 1.1.17). */
export const MODELS_OUTPUT = `Fetching available models...
gemini-3.7-flash-high\tGemini 3.7 Flash (High)
gemini-3.7-flash-medium\tGemini 3.7 Flash (Medium)
gemini-3.7-pro-high\tGemini 3.7 Pro (High)
gemini-3.6-flash-high\tGemini 3.6 Flash (High)
`;
