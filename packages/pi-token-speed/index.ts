// token-speed — live tokens-per-second meter for the pi coding agent.
//
// Shows a live generation-speed readout in the footer while the assistant
// streams, plus a summary (average tok/s, total tokens, time-to-first-token)
// when the message finishes. The summary stays on screen after a stream stops
// (and through the model's between-stream thinking/tool gaps) so the readout is
// always visible rather than blanking out the moment generation pauses.
//
// Commands:
//   /tps            cycle the display mode: live -> final -> off
//   /tps live       always show the live meter + summary
//   /tps final      show only the end-of-message summary
//   /tps off        show nothing

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  createTokenSpeedRuntime,
  type DisplayMode,
  MODES,
  runTokenSpeed,
  STATUS_KEY,
  TokenSpeedRuntime,
  type TokenSpeedRuntimeInstance,
} from "./src/runtime.ts";

function isAssistant(
  message: unknown,
): message is { role: "assistant"; usage?: { output?: number } } {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as { role?: string }).role === "assistant"
  );
}

export default function tokenSpeedExtension(pi: ExtensionAPI): void {
  const runtime: TokenSpeedRuntimeInstance = createTokenSpeedRuntime();
  const service = runtime.runSync(TokenSpeedRuntime);

  const clearStatus = (ctx: ExtensionContext) => {
    ctx.ui.setStatus(STATUS_KEY, "");
  };

  const showLastSummary = async (ctx: ExtensionContext) => {
    const mode = await runTokenSpeed(runtime, service.getMode);
    if (mode === "off") return;
    const summary = await runTokenSpeed(runtime, service.getLastSummary);
    if (summary) {
      ctx.ui.setStatus(STATUS_KEY, summary);
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    await runTokenSpeed(runtime, service.clear);
    clearStatus(ctx);
  });

  pi.on("message_start", async (event, ctx) => {
    if (!isAssistant(event.message)) return;
    await runTokenSpeed(runtime, service.beginStream(Date.now()));
    const mode = await runTokenSpeed(runtime, service.getMode);
    if (mode === "live") {
      await showLastSummary(ctx);
    }
  });

  pi.on("message_update", async (event, ctx) => {
    const ev = event.assistantMessageEvent;
    if (ev.type !== "text_delta" && ev.type !== "thinking_delta" && ev.type !== "toolcall_delta") {
      return;
    }

    const res = await runTokenSpeed(runtime, service.recordDelta(ev.delta ?? "", Date.now()));
    if (res.shouldRender && res.statusText) {
      ctx.ui.setStatus(STATUS_KEY, res.statusText);
    }
  });

  pi.on("message_end", async (event, ctx) => {
    if (!isAssistant(event.message)) return;
    const total = event.message.usage?.output;
    const res = await runTokenSpeed(runtime, service.endStream(total, Date.now()));
    if (res.shouldRender && res.summary) {
      ctx.ui.setStatus(STATUS_KEY, res.summary);
    }
  });

  pi.on("turn_end", async (_event, ctx) => {
    await showLastSummary(ctx);
  });

  pi.on("session_shutdown", async () => {
    try {
      await runtime.dispose();
    } catch {
      // Disposed gracefully
    }
  });

  pi.registerCommand("tps", {
    description: "Cycle or set the tokens-per-second display: /tps [live|final|off]",
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      if (arg && (MODES as string[]).includes(arg)) {
        const mode = await runTokenSpeed(runtime, service.setMode(arg as DisplayMode));
        if (mode === "off") clearStatus(ctx);
        ctx.ui.notify(`token-speed: ${mode}`, "info");
      } else if (arg) {
        ctx.ui.notify(`token-speed: unknown mode "${arg}". Use live | final | off.`, "error");
      } else {
        const mode = await runTokenSpeed(runtime, service.cycleMode);
        if (mode === "off") clearStatus(ctx);
        ctx.ui.notify(`token-speed: ${mode}`, "info");
      }
    },
  });
}
