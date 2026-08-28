/**
 * Model-facing todo text. Keep tool and schema wording short, precise, and
 * non-overlapping; detailed recovery belongs in on-demand result messages.
 */

export const TODO_TOOL_DESCRIPTION = "Track multi-step work in a shared todo list.";
export const TODO_PROMPT_SNIPPET = "Track multi-step work";

export const TODO_PROMPT_GUIDELINES = [
  "Use todo for multi-step work; skip single-step, exploratory, or conversational requests.",
  "Mark items in-progress when started and completed when done.",
];

export const TODO_PARAMETER_DESCRIPTIONS = {
  operation: "read returns the list; write replaces it.",
  todoList: "Full ordered list; required for write, ignored for read.",
  id: "Stable id; reuse across writes.",
  title: "Action label; about 3-7 words.",
  status: "Item state.",
};
