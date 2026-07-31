/**
 * Model-facing strings for the `todo` tool.
 *
 * Scope rule: the description carries only the CALL CONTRACT (replace-whole-list
 * semantics, stable ids), because that is what the model cannot infer. When to
 * use a todo list at all is behaviour, so it lives in promptGuidelines, which pi
 * injects into the system prompt whenever the tool is active. Nothing is stated
 * twice, and no tool result nags the model into using the list.
 */

export const TODO_TOOL_DESCRIPTION =
  "Track multi-step work as a shared todo list. `write` replaces the whole list, so always send every item — " +
  "including unchanged and completed ones; `read` returns the current list. Items keep their id across writes.";

export const TODO_PROMPT_SNIPPET = "Track multi-step work in a shared todo list";

export const TODO_PROMPT_GUIDELINES = [
  "Use todo for work with several distinct steps; skip it for single-step, exploratory, or conversational requests.",
  "Mark an item in-progress when you start it and completed when it is done, in the same write as your next change.",
];

export const TODO_PARAMETER_DESCRIPTIONS = {
  operation: "write replaces the entire list; read returns it unchanged.",
  todoList: "Every item in the list, in order. Required for write, ignored for read.",
  id: "Stable number identifying this item. Reuse it in later writes to update the same item.",
  title: "Action-oriented label, roughly 3-7 words.",
  status: "not-started, in-progress, or completed.",
};
