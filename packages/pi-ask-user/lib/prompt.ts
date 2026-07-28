import type { AskUserAnswer } from "./form";

// Model-facing prompt strings for the ask_user tool. Kept separate from the
// implementation so the wording can be tuned without touching UI logic.

/** Schema descriptions shown to the model for questions and options. */
export const ASK_USER_PARAMETER_DESCRIPTIONS = {
  optionLabel: "Short display label for this option",
  optionDescription:
    "Explanation, context, or trade-offs for the option. It may be multiple sentences and is fully wrapped in the UI.",
  question: "The full question to show the user. Long text and explicit newlines are supported.",
  options:
    "Between 2 and 5 answer options. A free-form Other option is appended automatically; never include one yourself.",
  allowMultiple:
    "Allow the user to select more than one option for this question. Defaults to false.",
  questions: "One to five questions to answer in the same interaction.",
};

/** Tool description shown to the model in the system prompt. */
export const ASK_USER_TOOL_DESCRIPTION =
  "Ask the user one or more multiple-choice questions (1-5 questions, 2-5 options each). Questions and option descriptions may be long. Each question can allow one or multiple selections. A free-form Other option is added automatically, and the user may dismiss without answering.";

/** One-line entry added to the model's `Available tools` section. */
export const ASK_USER_PROMPT_SNIPPET =
  "Ask one or more multiple-choice questions with full option descriptions";

/** Guideline bullets appended to the system prompt while ask_user is active. */
export const ASK_USER_PROMPT_GUIDELINES = [
  "When asking the user questions whose likely answers can be enumerated, use ask_user instead of asking in plain text.",
  "Use one ask_user call with multiple questions when those questions can be answered together; keep dependent follow-up questions in later calls.",
  "Give ask_user options concise labels and put meaningful context, constraints, and trade-offs in their descriptions.",
];

/** Outcome of an ask_user interaction. */
export type AskUserOutcome =
  | { kind: "no-ui" }
  | { kind: "cancelled" }
  | { kind: "dismissed" }
  | { kind: "answered"; answers: AskUserAnswer[] };

function formatChoice(choice: AskUserAnswer["choices"][number]): string {
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
        .map((answer) => {
          const choices = answer.choices.map(formatChoice).join("; ");
          return `Question ${answer.questionIndex}: ${choices}`;
        })
        .join("\n");
  }
}
