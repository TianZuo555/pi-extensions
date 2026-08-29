/**
 * Delta-only replay of an AssistantMessageEvent stream.
 *
 * pi's in-process TUI reads `event.partial`, so a provider that mutates the
 * partial message can look correct while emitting an illegal event stream.
 * Delta-only consumers — `pi --mode json` (docs/json.md: "message_update
 * records are delta-only … use contentIndex and delta to assemble live text,
 * thinking, or tool-call arguments"), `streamProxy`'s processProxyEvent, and
 * extensions that read `assistantMessageEvent` — rebuild content from
 * `contentIndex` + `delta` alone.
 *
 * This harness enforces the same invariants processProxyEvent does:
 *   - `*_start` assigns content[contentIndex]; indices are append-only and a
 *     slot may never be reassigned to a different block;
 *   - `*_delta` / `*_end` must find a block of the matching type at that index.
 *
 * Splicing a block into an already-announced index breaks all three, so any
 * provider change that reorders content is caught here rather than in
 * production.
 */

type Block =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "toolCall"; id?: string; name?: string; arguments?: unknown };

/**
 * Rebuild message content from deltas only. Throws on any protocol violation.
 */
export function replayDeltas(events: readonly any[]): Block[] {
  const content: Block[] = [];

  const claim = (index: number, block: Block, kind: string): void => {
    if (index > content.length) {
      throw new Error(
        `${kind} claimed index ${index} but only ${content.length} block(s) were announced — indices must be append-only.`,
      );
    }
    const existing = content[index];
    if (existing !== undefined) {
      throw new Error(
        `${kind} reassigned index ${index}, which already holds a "${existing.type}" block — announced indices are immutable.`,
      );
    }
    content[index] = block;
  };

  const expect = <T extends Block["type"]>(index: number, type: T, kind: string): Block => {
    const block = content[index];
    if (block?.type !== type) {
      throw new Error(
        `Received ${kind} for ${block === undefined ? "unannounced" : `non-${type}`} content at index ${index}.`,
      );
    }
    return block;
  };

  for (const event of events) {
    switch (event.type) {
      case "start":
      case "done":
      case "error":
        break;
      case "text_start":
        claim(event.contentIndex, { type: "text", text: "" }, "text_start");
        break;
      case "text_delta": {
        const block = expect(event.contentIndex, "text", "text_delta");
        if (block.type === "text") block.text += event.delta;
        break;
      }
      case "text_end":
        expect(event.contentIndex, "text", "text_end");
        break;
      case "thinking_start":
        claim(event.contentIndex, { type: "thinking", thinking: "" }, "thinking_start");
        break;
      case "thinking_delta": {
        const block = expect(event.contentIndex, "thinking", "thinking_delta");
        if (block.type === "thinking") block.thinking += event.delta;
        break;
      }
      case "thinking_end":
        expect(event.contentIndex, "thinking", "thinking_end");
        break;
      case "toolcall_start":
        claim(
          event.contentIndex,
          { type: "toolCall", id: event.id, name: event.toolName },
          "toolcall_start",
        );
        break;
      case "toolcall_delta":
        expect(event.contentIndex, "toolCall", "toolcall_delta");
        break;
      case "toolcall_end": {
        const block = expect(event.contentIndex, "toolCall", "toolcall_end");
        if (block.type === "toolCall") Object.assign(block, event.toolCall);
        break;
      }
      default:
        throw new Error(`Unknown assistant message event type "${event.type}".`);
    }
  }

  // A hole means an index was skipped: `indexOf` is undefined-blind on sparse
  // arrays, so compare lengths against the densely-filled entries instead.
  for (let index = 0; index < content.length; index++) {
    if (content[index] === undefined) {
      throw new Error(`Content index ${index} was never announced by a *_start event.`);
    }
  }
  return content;
}

/**
 * Assert that the delta-only reconstruction matches the provider's own
 * `partial` content — the invariant every pi consumer relies on.
 */
export function assertDeltasMatchPartial(events: readonly any[]): Block[] {
  const replayed = replayDeltas(events);
  const terminal = [...events]
    .reverse()
    .find((event: any) => event.type === "done" || event.type === "error");
  const authoritative = terminal?.message?.content ?? terminal?.error?.content;
  if (!authoritative) return replayed;

  if (replayed.length !== authoritative.length) {
    throw new Error(
      `Delta replay produced ${replayed.length} block(s) but the final message has ${authoritative.length}.`,
    );
  }
  for (const [index, block] of replayed.entries()) {
    const expected = authoritative[index];
    if (block.type !== expected.type) {
      throw new Error(
        `Block ${index}: delta replay yielded "${block.type}" but the final message has "${expected.type}".`,
      );
    }
    if (block.type === "text" && block.text !== expected.text) {
      throw new Error(
        `Block ${index} text mismatch: replayed ${JSON.stringify(block.text)} vs final ${JSON.stringify(expected.text)}.`,
      );
    }
    if (block.type === "thinking" && block.thinking !== expected.thinking) {
      throw new Error(
        `Block ${index} thinking mismatch: replayed ${JSON.stringify(block.thinking)} vs final ${JSON.stringify(expected.thinking)}.`,
      );
    }
  }
  return replayed;
}
