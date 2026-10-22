// Model-facing text for the `@subagent:[name]` reference feature. Kept apart
// from the event wiring in `extensions/feature/reference/subagent.ts` so the
// wording can be reviewed and tuned without touching runtime code.

/**
 * Instruction injected as a custom request message when a prompt mentions one
 * or more `@subagent:[name]` references. A request message (not systemPrompt)
 * keeps the cached prompt prefix stable.
 */
export function subagentDelegationMessage(agentList: string): string {
  return [
    `The user's prompt references these subagent types: ${agentList}.`,
    "You MUST use the Agent tool for EACH mentioned subagent to delegate the relevant parts of the request.",
    "Handle different subagents separately — do NOT merge their tasks into a single Agent call.",
    'For example, if the user mentions @subagent:[coder] and @subagent:[explore], make two separate Agent tool calls, one with subagent_type="coder" and another with subagent_type="explore".',
  ].join(" ");
}
