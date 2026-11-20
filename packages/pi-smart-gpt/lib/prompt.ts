// Model-facing text for smart_gpt. Kept apart from the runtime, per the
// repository's prompt-separation rule.

// The probe itself, verbatim from the community candy test. The table is the
// question; the last line's rule makes the answer machine-readable.
//
// Three flavours, two shapes each, and shapes can be told apart by touch. The
// least number of sweets that guarantees a mixed-shape apple and peach pair is
// 21 (9 circles and 12 stars). 29 is the answer when the shapes cannot be
// felt, so it is a specific, meaningful wrong answer.
export const PUZZLE_PROMPT = `在一个黑色的袋子里放有三种口味的糖果，每种糖果有两种不同的形状（圆形和五角星形，不同的形状靠手感可以分辨）。现已知不同口味的糖和不同形状的数量统计如下表。参赛者需要在活动前决定摸出的糖果数目，那么，最少取出多少个糖果才能保证手中同时拥有不同形状的苹果味和桃子味的糖？（同时手中有圆形苹果味匹配五角星桃子味糖果，或者有圆形桃子味匹配五角星苹果味糖果都满足要求）

              苹果味 桃子味 西瓜味
圆形            7      9      8
五角星形        7      6      4

不许联网，自己计算。请说明摸取策略和为什么不能更少，最后一行只写“答案：N颗”（N为你算出的最少数量）。`;

export const SMART_TOOL_DESCRIPTION = `Test one Codex account, or every one magpie has, with a fixed reasoning puzzle and report the answer, the reasoning tokens and the time.

The puzzle's answer is 21 when the shapes can be told apart by touch, and 29 when they cannot. An answer other than 21, or a reasoning-token count far below the account's own history, is the signal that an upstream model answers worse than it used to. One probe is not a verdict: read it against the account's earlier runs.

The request goes through the local magpie gateway, because only magpie can pin a request to one account. It spends that account's allowance, like any other model call.`;

export const SMART_PROMPT_SNIPPET = `smart_gpt tests Codex accounts for a model that got dumber`;

export const SMART_PROMPT_GUIDELINES = [
  "Call smart_gpt when the user asks whether a Codex account or model has got worse, and once after a provider, gateway or account change.",
  "Report the answer and the reasoning-token count together, and compare the count with the account's earlier runs from smart_gpt history. Neither number alone says the model is degraded.",
  "Never call smart_gpt in a loop to build a series: the user runs several probes over days, and each one spends allowance.",
  "When the answer is 21, say the probe passed; when it is 29, say the model answered as if the shapes could not be felt; any other number means the model got the puzzle wrong.",
];

export const SMART_PARAMETER_DESCRIPTIONS = {
  account:
    "The Codex account to probe, by email, as magpie lists it. Leave it out to probe every account magpie has switched on.",
};
