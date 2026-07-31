// ask-user — lets the model ask one or more multiple-choice questions.
//
// Interactive controls:
//   ←/→ switch question · ↑/↓ move option · Space select/toggle
//   Enter next/submit · Esc dismiss
//
// Questions, labels, and descriptions are word-wrapped instead of truncated.
// Each question always includes a free-form Other choice. RPC mode falls back
// to built-in dialogs; print/json modes report that no UI was available.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import {
  AskUserForm,
  type AskUserAnswer,
  type AskUserChoice,
  type AskUserQuestion,
  type AskUserSubmission,
} from "./lib/form.ts";
import {
  ASK_USER_PARAMETER_DESCRIPTIONS,
  ASK_USER_PROMPT_GUIDELINES,
  ASK_USER_PROMPT_SNIPPET,
  ASK_USER_TOOL_DESCRIPTION,
  type AskUserOutcome,
  buildAskUserResultMessage,
} from "./lib/prompt.ts";

const MIN_QUESTIONS = 1;
const MAX_QUESTIONS = 5;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 5;
const OTHER_LABEL = "Other — type your own answer";
const DONE_LABEL = "Done selecting";

const OptionSchema = Type.Object({
  label: Type.String({ description: ASK_USER_PARAMETER_DESCRIPTIONS.optionLabel }),
  description: Type.Optional(
    Type.String({ description: ASK_USER_PARAMETER_DESCRIPTIONS.optionDescription }),
  ),
});

const QuestionSchema = Type.Object({
  question: Type.String({ description: ASK_USER_PARAMETER_DESCRIPTIONS.question }),
  options: Type.Array(OptionSchema, {
    minItems: MIN_OPTIONS,
    maxItems: MAX_OPTIONS,
    description: ASK_USER_PARAMETER_DESCRIPTIONS.options,
  }),
  allow_multiple: Type.Optional(
    Type.Boolean({ description: ASK_USER_PARAMETER_DESCRIPTIONS.allowMultiple }),
  ),
});

const AskUserParams = Type.Object({
  questions: Type.Array(QuestionSchema, {
    minItems: MIN_QUESTIONS,
    maxItems: MAX_QUESTIONS,
    description: ASK_USER_PARAMETER_DESCRIPTIONS.questions,
  }),
});

export type AskUserInput = Static<typeof AskUserParams>;

export const AGENT_INPUT_REQUIRED_EVENT = "agent:input_required";
const LEGACY_HERDR_BLOCKED_EVENT = "herdr:blocked";

/** Lifecycle event emitted while this tool is waiting for human input. */
export interface AgentInputRequiredEvent {
  version: 1;
  id: string;
  source: string;
  active: boolean;
  label: string;
}

interface AskUserDetails {
  questions: Array<{
    question: string;
    options: string[];
    allowMultiple: boolean;
  }>;
  answers: AskUserAnswer[];
  cancelled: boolean;
}

type AskUserContext = Parameters<
  Parameters<ExtensionAPI["registerTool"]>[0]["execute"]
>[4];

function normalizeQuestions(params: AskUserInput): AskUserQuestion[] {
  return params.questions.map((question) => ({
    question: question.question,
    options: question.options,
    allowMultiple: question.allow_multiple === true,
  }));
}

/**
 * Labels that mean "none of these, let me type my own". The form always appends
 * its own free-form Other row, so a model-supplied one renders twice — and
 * nothing in the flow would ever report that back, which is why this is a hard
 * error rather than prose in the schema.
 */
const SELF_SUPPLIED_OTHER_LABELS = new Set([
  "other",
  "others",
  "other answer",
  "other option",
  "something else",
  "custom",
  "custom answer",
  "none of the above",
]);

function isSelfSuppliedOther(label: string): boolean {
  const bare = label
    // Drop an explanatory tail: `Other — type your own`, `Other - explain`.
    .split(/[—–]|\s-\s/)[0]
    // Drop a qualifier and trailing punctuation: `Other (specify)`, `Other...`.
    .replace(/\([^)]*\)/g, " ")
    .replace(/[.…:;,!?*]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return SELF_SUPPLIED_OTHER_LABELS.has(bare);
}

function validateQuestions(questions: AskUserQuestion[]): void {
  if (questions.length < MIN_QUESTIONS || questions.length > MAX_QUESTIONS) {
    throw new Error(
      `ask_user requires between ${MIN_QUESTIONS} and ${MAX_QUESTIONS} questions (got ${questions.length}). Retry with a valid number of questions.`,
    );
  }

  for (let index = 0; index < questions.length; index++) {
    const options = questions[index].options;
    if (options.length < MIN_OPTIONS || options.length > MAX_OPTIONS) {
      throw new Error(
        `ask_user question ${index + 1} requires between ${MIN_OPTIONS} and ${MAX_OPTIONS} options (got ${options.length}). Retry with a valid number of options.`,
      );
    }

    const selfOther = options.findIndex((option) =>
      isSelfSuppliedOther(option.label),
    );
    if (selfOther >= 0) {
      throw new Error(
        `ask_user question ${index + 1} option ${selfOther + 1} ("${options[selfOther].label}") duplicates the free-form Other choice this tool always appends, so the user would see it twice. These questions were not shown. Remove that option and keep only the substantive choices.`,
      );
    }
  }
}

function showQuestions(
  ctx: AskUserContext,
  questions: AskUserQuestion[],
  signal: AbortSignal | undefined,
): Promise<AskUserSubmission | null> {
  return ctx.ui.custom<AskUserSubmission | null>((tui, theme, keybindings, done) =>
    new AskUserForm(tui, theme, keybindings, questions, done, signal),
  );
}

function optionDialogLabel(
  option: AskUserQuestion["options"][number],
  index: number,
  selected = false,
): string {
  const checkbox = selected ? "[x]" : "[ ]";
  const description = option.description ? ` — ${option.description}` : "";
  return `${checkbox} ${index + 1}. ${option.label}${description}`;
}

async function askQuestionWithDialogs(
  ctx: AskUserContext,
  question: AskUserQuestion,
  questionIndex: number,
  signal: AbortSignal | undefined,
): Promise<AskUserAnswer | null> {
  const title = `${questionIndex + 1}. ${question.question}`;

  if (!question.allowMultiple) {
    const labels = question.options.map((option, index) =>
      optionDialogLabel(option, index),
    );
    labels.push(`[ ] ${question.options.length + 1}. ${OTHER_LABEL}`);

    const selected = await ctx.ui.select(title, labels);
    if (selected === undefined || signal?.aborted) return null;
    const selectedIndex = labels.indexOf(selected);
    let choice: AskUserChoice;

    if (selectedIndex === question.options.length) {
      const custom = (await ctx.ui.editor("Write your answer", ""))?.trim();
      if (!custom || signal?.aborted) return null;
      choice = { label: custom, wasCustom: true };
    } else {
      choice = {
        label: question.options[selectedIndex].label,
        optionIndex: selectedIndex + 1,
        wasCustom: false,
      };
    }

    return {
      questionIndex: questionIndex + 1,
      question: question.question,
      choices: [choice],
    };
  }

  const selectedIndices = new Set<number>();
  let customAnswer: string | undefined;

  for (;;) {
    if (signal?.aborted) return null;
    const labels = question.options.map((option, index) =>
      optionDialogLabel(option, index, selectedIndices.has(index)),
    );
    labels.push(`${customAnswer ? "[x]" : "[ ]"} ${question.options.length + 1}. ${OTHER_LABEL}`);
    labels.push(DONE_LABEL);

    const selected = await ctx.ui.select(`${title} (select one or more)`, labels);
    if (selected === undefined || signal?.aborted) return null;
    const selectedIndex = labels.indexOf(selected);

    if (selectedIndex === labels.length - 1) {
      if (selectedIndices.size === 0 && !customAnswer) {
        ctx.ui.notify("Select one or more options before continuing", "warning");
        continue;
      }
      break;
    }

    if (selectedIndex === question.options.length) {
      if (customAnswer) {
        customAnswer = undefined;
        continue;
      }
      const custom = (await ctx.ui.editor("Write your answer", ""))?.trim();
      if (signal?.aborted) return null;
      if (custom) customAnswer = custom;
      continue;
    }

    if (selectedIndices.has(selectedIndex)) selectedIndices.delete(selectedIndex);
    else selectedIndices.add(selectedIndex);
  }

  const choices: AskUserChoice[] = [...selectedIndices]
    .sort((left, right) => left - right)
    .map((optionIndex) => ({
      label: question.options[optionIndex].label,
      optionIndex: optionIndex + 1,
      wasCustom: false,
    }));
  if (customAnswer) choices.push({ label: customAnswer, wasCustom: true });

  return {
    questionIndex: questionIndex + 1,
    question: question.question,
    choices,
  };
}

async function showQuestionsWithDialogs(
  ctx: AskUserContext,
  questions: AskUserQuestion[],
  signal: AbortSignal | undefined,
): Promise<AskUserSubmission | null> {
  const answers: AskUserAnswer[] = [];
  for (let index = 0; index < questions.length; index++) {
    const answer = await askQuestionWithDialogs(ctx, questions[index], index, signal);
    if (!answer) return null;
    answers.push(answer);
  }
  return { answers };
}

function formatChoiceForResult(choice: AskUserChoice): string {
  return choice.wasCustom
    ? `(wrote) ${choice.label}`
    : `${choice.optionIndex}. ${choice.label}`;
}

export default function askUser(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "ask_user",
    label: "Ask User",
    description: ASK_USER_TOOL_DESCRIPTION,
    promptSnippet: ASK_USER_PROMPT_SNIPPET,
    promptGuidelines: ASK_USER_PROMPT_GUIDELINES,
    parameters: AskUserParams,
    executionMode: "sequential",

    prepareArguments(args): AskUserInput {
      if (!args || typeof args !== "object") return args as AskUserInput;
      const input = args as {
        questions?: unknown;
        question?: unknown;
        options?: unknown;
        allow_multiple?: unknown;
      };
      if (Array.isArray(input.questions)) return args as AskUserInput;
      if (typeof input.question !== "string" || !Array.isArray(input.options)) {
        return args as AskUserInput;
      }

      // Compatibility for tool calls stored by versions <= 0.1.2.
      return {
        questions: [
          {
            question: input.question,
            options: input.options,
            ...(typeof input.allow_multiple === "boolean"
              ? { allow_multiple: input.allow_multiple }
              : {}),
          },
        ],
      };
    },

    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const questions = normalizeQuestions(params);
      validateQuestions(questions);

      const detailsFor = (submission: AskUserSubmission | null): AskUserDetails => ({
        questions: questions.map((question) => ({
          question: question.question,
          options: question.options.map((option) => option.label),
          allowMultiple: question.allowMultiple,
        })),
        answers: submission?.answers ?? [],
        cancelled: submission === null,
      });

      const reply = (outcome: AskUserOutcome, submission: AskUserSubmission | null = null) => ({
        content: [{ type: "text" as const, text: buildAskUserResultMessage(outcome) }],
        details: detailsFor(submission),
      });

      const dismissedOrCancelled = (): AskUserOutcome =>
        signal?.aborted ? { kind: "cancelled" } : { kind: "dismissed" };

      // Report the cause (waiting for input), not a client-specific final agent
      // state. Consumers own state aggregation and transport. `herdr:blocked`
      // remains temporarily for compatibility with Herdr's version 6 bridge.
      const firstQuestion = questions[0].question.replace(/\s+/g, " ").trim();
      const blockedLabel = (
        questions.length === 1
          ? firstQuestion
          : `${questions.length} questions: ${firstQuestion}`
      ).slice(0, 120) || "Waiting for user input";
      const emitInputRequired = (active: boolean) => {
        const payload: AgentInputRequiredEvent = {
          version: 1,
          id: toolCallId,
          source: "ask_user",
          active,
          label: blockedLabel,
        };

        for (const eventName of [AGENT_INPUT_REQUIRED_EVENT, LEGACY_HERDR_BLOCKED_EVENT]) {
          try {
            pi.events.emit(eventName, { ...payload });
          } catch {
            // Never let best-effort signalling break the prompt or its cleanup.
          }
        }
      };

      if (ctx.mode === "tui") {
        emitInputRequired(true);
        try {
          if (signal?.aborted) return reply({ kind: "cancelled" });
          const submission = await showQuestions(ctx, questions, signal);
          if (!submission) return reply(dismissedOrCancelled());
          return reply({ kind: "answered", answers: submission.answers }, submission);
        } finally {
          emitInputRequired(false);
        }
      }

      if (ctx.hasUI) {
        emitInputRequired(true);
        try {
          const submission = await showQuestionsWithDialogs(ctx, questions, signal);
          if (!submission) return reply(dismissedOrCancelled());
          return reply({ kind: "answered", answers: submission.answers }, submission);
        } finally {
          emitInputRequired(false);
        }
      }

      return reply({ kind: "no-ui" });
    },

    renderCall(args, theme, _context) {
      const renderArgs = args as AskUserInput & {
        question?: string;
        options?: Array<{ label?: string }>;
      };
      const rawQuestions = Array.isArray(renderArgs.questions)
        ? (renderArgs.questions as Array<{
            question?: string;
            options?: Array<{ label?: string }>;
          }>)
        : typeof renderArgs.question === "string"
          ? [{ question: renderArgs.question, options: renderArgs.options }]
          : [];
      const count = rawQuestions.length;
      let text = theme.fg("toolTitle", theme.bold("ask_user "));
      text += theme.fg("muted", `${count} question${count === 1 ? "" : "s"}`);

      for (let index = 0; index < rawQuestions.length; index++) {
        const question = rawQuestions[index];
        text += `\n${theme.fg("dim", `  ${index + 1}. ${question.question ?? ""}`)}`;
        if (count === 1 && Array.isArray(question.options)) {
          const options = question.options.map(
            (option, optionIndex) => `${optionIndex + 1}. ${option.label ?? ""}`,
          );
          if (options.length > 0) text += `\n${theme.fg("dim", `     ${options.join("  ")}`)}`;
        }
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme, _context) {
      const details = result.details as AskUserDetails | undefined;
      if (!details) {
        const first = result.content[0];
        return new Text(first?.type === "text" ? first.text : "", 0, 0);
      }
      if (details.cancelled) {
        return new Text(theme.fg("warning", "✗ dismissed"), 0, 0);
      }

      const lines = details.answers.map((answer) => {
        const choices = answer.choices.map(formatChoiceForResult).join(", ");
        return (
          theme.fg("success", "✓ ") +
          theme.fg("accent", `Q${answer.questionIndex}: `) +
          theme.fg("text", choices)
        );
      });
      return new Text(lines.join("\n"), 0, 0);
    },
  });
}
