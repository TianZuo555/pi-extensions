// Reading the model's reply.
//
// The puzzle asks for its answer on the last line as "答案：N颗". Reading that
// line first keeps a correct answer from being lost to a correct aside: a reply
// that says 21 and also mentions "若不分辨形状，至少需要 29 颗" must not be
// scored 29. Only when no line answers does the looser pattern run, and it
// takes the last number it finds.

export const GOOD_ANSWER = 21;
export const BLIND_ANSWER = 29;

export type Verdict = "ok" | "blind" | "wrong" | "no-answer";

const ANSWERS_ON_A_LINE = /^[\s>*#-]*答案\s*[:：]\s*(\d{1,3})/gmu;
const ANYWHERE = /(?:答案|最少(?:需要)?|至少(?:需要)?)[^0-9\n]{0,18}(\d{1,3})\s*(?:颗|个)?/gu;

function lastMatch(pattern: RegExp, text: string): number | undefined {
  const found = [...text.matchAll(pattern)];
  const last = found.at(-1);
  return last ? Number(last[1]) : undefined;
}

/** The answer a reply reports, or undefined when it reports none. */
export function parseAnswer(text: string): number | undefined {
  if (!text) return undefined;
  return lastMatch(ANSWERS_ON_A_LINE, text) ?? lastMatch(ANYWHERE, text);
}

/** What an answer means for a probe. */
export function verdictOf(answer: number | undefined): Verdict {
  if (answer === GOOD_ANSWER) return "ok";
  if (answer === BLIND_ANSWER) return "blind";
  return answer === undefined ? "no-answer" : "wrong";
}
