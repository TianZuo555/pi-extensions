/**
 * Compaction forwarding: devin owns context server-side and compacts itself
 * internally (`compaction_update`), so every pi compaction pass is vetoed.
 * Only a manual `/compact` is routed to devin's own `/compact` through a
 * normal turn — auto triggers (threshold, overflow) die with the veto: pi's
 * context gauge merely mirrors devin's reported usage, and a misread must
 * never push devin into an extra compaction.
 *
 * The forward is deferred one tick so the cancelled pi pass finishes first,
 * and sent as a follow-up so an in-flight run queues it instead of
 * rejecting the send: `sendUserMessage` without a delivery mode throws
 * "Agent is already processing" while a turn is active, and pi swallows the
 * rejection inside its own runtime — the forward would be dropped while the
 * notice claimed it was running.
 */

/** The slice of pi's UI surface the forwarder needs. */
export interface CompactForwardUi {
  notify(message: string, type?: "info" | "warning" | "error"): void;
}

export interface CompactForwarderOptions {
  /** Send the forwarded command as a user turn. */
  send: (text: string) => void;
  /** Deferral used to let the cancelled pass finish first (test seam). */
  schedule?: (run: () => void) => void;
}

/**
 * Build the forwarder for `session_before_compact`. Only invoked for
 * `reason === "manual"` — the caller vetoes every pi pass, so auto triggers
 * never reach this.
 */
export function createCompactForwarder(
  options: CompactForwarderOptions,
): (customInstructions: string | undefined, ui: CompactForwardUi | undefined) => void {
  const schedule = options.schedule ?? ((run: () => void) => setTimeout(run, 0));
  return (customInstructions, ui) => {
    ui?.notify("devin owns context — running devin's /compact instead.", "info");
    const instructions = customInstructions?.trim();
    schedule(() => {
      options.send(instructions ? `/compact ${instructions}` : "/compact");
    });
  };
}

/** A pi `sendUserMessage` bound to the extension. */
export type SendUserTurn = (
  text: string,
  options?: { expandPromptTemplates?: boolean; deliverAs?: "steer" | "followUp" },
) => void;

/**
 * Wrap pi's `sendUserMessage` for forwarded commands: no prompt-template
 * expansion (devin receives the command as prompt text), delivered as a
 * follow-up so an in-flight run queues it instead of rejecting the send.
 */
export function createCompactSend(sendUserMessage: SendUserTurn): (text: string) => void {
  return (text) => sendUserMessage(text, { expandPromptTemplates: false, deliverAs: "followUp" });
}
