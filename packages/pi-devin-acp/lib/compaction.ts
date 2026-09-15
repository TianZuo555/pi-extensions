/**
 * Compaction forwarding: devin owns context server-side, so every pi
 * compaction trigger — manual `/compact`, the context threshold, and overflow
 * recovery — is vetoed and routed to devin's own `/compact` through a normal
 * turn.
 *
 * pi checks compaction from three places, and two of them run while the agent
 * is still working: before a submitted prompt starts its turn, and (pi 0.84.3+)
 * between assistant responses of a running turn. `sendUserMessage` without a
 * delivery mode throws "Agent is already processing" in that state, and pi
 * swallows the rejection inside its own runtime — the forward would be dropped
 * while the notice claimed it was running. Sending as a follow-up queues the
 * command whenever a run is active and sends it immediately when idle.
 */

export type CompactionReason = "manual" | "threshold" | "overflow";

/** The slice of pi's UI surface the forwarder needs. */
export interface CompactForwardUi {
  notify(message: string, type?: "info" | "warning" | "error"): void;
}

export interface CompactForwarderOptions {
  /** Minimum gap before another auto-triggered forward is scheduled. */
  cooldownMs: number;
  /** Send the forwarded command as a user turn. */
  send: (text: string) => void;
  /** Current time source (test seam). */
  now?: () => number;
  /** Deferral used to let the cancelled pass finish first (test seam). */
  schedule?: (run: () => void) => void;
}

/**
 * Build the forwarder for `session_before_compact`. Manual compaction always
 * forwards (and carries its custom instructions); auto triggers are
 * rate-limited because devin's compaction does not shrink pi's transcript, so
 * the threshold re-checks every turn.
 */
export function createCompactForwarder(
  options: CompactForwarderOptions,
): (
  reason: CompactionReason,
  customInstructions: string | undefined,
  ui: CompactForwardUi | undefined,
) => void {
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? ((run: () => void) => setTimeout(run, 0));
  let lastAutoForwardAt = 0;

  return (reason, customInstructions, ui) => {
    const isManual = reason === "manual";
    if (!isManual) {
      if (now() - lastAutoForwardAt < options.cooldownMs) return;
      lastAutoForwardAt = now();
    }
    if (ui) {
      ui.notify(
        isManual
          ? "devin owns context — running devin's /compact instead."
          : `devin owns context — forwarding ${reason} compaction to devin's /compact.`,
        "info",
      );
    }
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
