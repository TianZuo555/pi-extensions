import type { AskUserAnswer } from "./form";

// Model-facing prompt strings for the ask_user tool. Kept separate from the
// implementation so the wording can be tuned without touching UI logic.

/** Schema descriptions shown to the model for questions and options. */
export const ASK_USER_PARAMETER_DESCRIPTIONS = {
  optionLabel: "Concise display label.",
  optionDescription:
    "Context, constraints, or trade-offs; may use multiple sentences.",
  question: "Question shown to the user.",
  options: "Answer options. Other is added automatically; do not include it.",
  questions: "Questions shown together.",
};

/** Tool description shown to the model in the system prompt. */
export const ASK_USER_TOOL_DESCRIPTION =
  "Ask the user one or more multiple-choice questions. They may write a custom answer or dismiss.";

/** One-line entry added to the model's `Available tools` section. */
export const ASK_USER_PROMPT_SNIPPET =
  "Ask the user multiple-choice questions";

/** Guideline bullets appended to the system prompt while ask_user is active. */
export const ASK_USER_PROMPT_GUIDELINES = [
  "Use ask_user instead of plain text when likely answers can be listed.",
  "Batch questions that can be answered together; ask dependent follow-ups later.",
];

/** Outcome of an ask_user interaction. */
export type AskUserOutcome =
  | { kind: "no-ui" }
  | { kind: "cancelled" }
  | { kind: "dismissed" }
  | { kind: "answered"; answers: AskUserAnswer[] };

function formatChoice(choice: AskUserAnswer["choice"]): string {
  if (choice.wasCustom) return `wrote: ${choice.label}`;
  return `selected option ${choice.optionIndex}: ${choice.label}`;
}

/** Builds the tool-result text reported back to the model for an outcome. */
export function buildAskUserResultMessage(outcome: AskUserOutcome): string {
  switch (outcome.kind) {
    case "no-ui":
      return "No interactive UI is available, so the questions could not be shown. Ask the user in plain text instead.";
    case "cancelled":
      return "Cancelled.";
    case "dismissed":
      return "User dismissed the questions without answering. Do not assume answers; proceed accordingly or ask differently.";
    case "answered":
      return outcome.answers
        .map(
          (answer) =>
            `Question ${answer.questionIndex}: ${formatChoice(answer.choice)}`,
        )
        .join("\n");
  }
}
