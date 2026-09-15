/**
 * Permission bridge: devin's session/request_permission calls become pi's
 * `ui.select`, or an automatic allow when the yolo setting (or the headless
 * opt-in) says never to ask.
 *
 * While the select dialog waits for input we report that on pi's shared event
 * bus — `agent:input_required` is the canonical event, `herdr:blocked` the
 * legacy alias Herdr's shipped pi integration still listens for (same
 * convention as pi-ask-user).
 */

import type { DevinPermissionHandler, DevinRequestPermissionParams } from "./acp-client.ts";

export const AGENT_INPUT_REQUIRED_EVENT = "agent:input_required";
export const LEGACY_HERDR_BLOCKED_EVENT = "herdr:blocked";

export interface PermissionPromptEvent {
  version: 1;
  id: string;
  source: "devin-acp";
  active: boolean;
  label: string;
}

export interface PermissionUi {
  select(title: string, labels: string[]): Promise<string | undefined>;
}

export interface DevinPermissionBridgeOptions {
  /** pi ui when a UI is attached; undefined in headless modes. */
  ui: () => PermissionUi | undefined;
  /** YOLO setting: auto-approve without prompting. */
  yolo: () => boolean;
  /** Headless auto-allow (PI_DEVIN_HEADLESS_PERMISSION=allow). */
  headlessAllow: () => boolean;
  /** Best-effort emit onto pi's shared event bus. */
  emit: (event: string, payload: PermissionPromptEvent) => void;
}

type PermissionOption = DevinRequestPermissionParams["options"][number];

function oneLine(value: string, max = 80): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

/** The most permissive "allow" option, or undefined when only denials exist. */
export function pickAllowOption(options: PermissionOption[]): PermissionOption | undefined {
  return (
    options.find((o) => o.kind === "allow_always") ??
    options.find((o) => o.kind === "allow_once") ??
    options.find((o) => /allow/i.test(o.optionId) || /allow/i.test(o.name ?? ""))
  );
}

export function createDevinPermissionHandler(
  bridge: DevinPermissionBridgeOptions,
): DevinPermissionHandler {
  return async (params) => {
    const options = params.options ?? [];
    const ui = bridge.ui();
    const selected = (option: PermissionOption) => ({
      outcome: { outcome: "selected" as const, optionId: option.optionId },
    });
    const cancelled = () => ({ outcome: { outcome: "cancelled" as const } });

    // YOLO auto-approves whatever still arrives (e.g. org-enforced ask rules
    // under bypass mode); headless denies unless explicitly opted in.
    if (bridge.yolo() || (!ui && bridge.headlessAllow())) {
      const allow = pickAllowOption(options);
      return allow ? selected(allow) : cancelled();
    }
    if (!ui) return cancelled();

    const title = params.toolCall?.title ?? "tool call";
    const names = options.map((o) => o.name ?? o.optionId);
    const duplicated = new Set(names.filter((name, i) => names.indexOf(name) !== i));
    const labels = options.map((o, i) =>
      duplicated.has(names[i]) ? `${names[i]} (${o.kind ?? o.optionId})` : names[i],
    );
    const prompt = `devin requests permission: ${oneLine(title)}`;

    const emitPrompt = (active: boolean) => {
      const payload: PermissionPromptEvent = {
        version: 1,
        id: params.toolCall?.toolCallId ?? params.sessionId,
        source: "devin-acp",
        active,
        label: prompt,
      };
      for (const event of [AGENT_INPUT_REQUIRED_EVENT, LEGACY_HERDR_BLOCKED_EVENT]) {
        bridge.emit(event, payload);
      }
    };

    emitPrompt(true);
    try {
      const picked = await ui.select(prompt, labels);
      if (!picked) return cancelled();
      const index = labels.indexOf(picked);
      return index >= 0 ? selected(options[index]) : cancelled();
    } finally {
      emitPrompt(false);
    }
  };
}
