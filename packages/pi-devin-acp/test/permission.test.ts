import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AGENT_INPUT_REQUIRED_EVENT,
  createDevinPermissionHandler,
  LEGACY_HERDR_BLOCKED_EVENT,
  pickAllowOption,
  type PermissionPromptEvent,
  type PermissionUi,
} from "../lib/permission.ts";
import type { DevinRequestPermissionParams } from "../lib/acp-client.ts";

const OPTIONS = [
  { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
  { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
  { optionId: "deny", name: "Deny", kind: "reject_once" },
];

function params(
  options: DevinRequestPermissionParams["options"] = OPTIONS,
): DevinRequestPermissionParams {
  return {
    sessionId: "sess-1",
    toolCall: { toolCallId: "call-1", title: "Run npm test" },
    options,
  };
}

interface Emitted {
  event: string;
  payload: PermissionPromptEvent;
}

function bridge(overrides: {
  ui?: PermissionUi | undefined;
  yolo?: boolean;
  headlessAllow?: boolean;
}) {
  const emitted: Emitted[] = [];
  const handler = createDevinPermissionHandler({
    ui: () => overrides.ui,
    yolo: () => overrides.yolo === true,
    headlessAllow: () => overrides.headlessAllow === true,
    emit: (event, payload) => emitted.push({ event, payload }),
  });
  return { handler, emitted };
}

test("pickAllowOption prefers allow_always, then allow_once, then any allow", () => {
  assert.equal(pickAllowOption(OPTIONS)?.optionId, "allow-always");
  assert.equal(pickAllowOption(OPTIONS.slice(0, 1).concat(OPTIONS[2]))?.optionId, "allow-once");
  assert.equal(pickAllowOption([{ optionId: "yes-allow", name: "Yes" }])?.optionId, "yes-allow");
  assert.equal(pickAllowOption([{ optionId: "deny", name: "Deny" }]), undefined);
});

test("yolo auto-approves the allow option without prompting", async () => {
  let selected = 0;
  const { handler, emitted } = bridge({
    yolo: true,
    ui: {
      select: async () => {
        selected += 1;
        return "Deny";
      },
    },
  });
  const result = await handler(params());
  assert.deepEqual(result, { outcome: { outcome: "selected", optionId: "allow-always" } });
  assert.equal(selected, 0);
  assert.equal(emitted.length, 0);
});

test("yolo with no allow option cancels", async () => {
  const { handler } = bridge({ yolo: true });
  const result = await handler(params([{ optionId: "deny", name: "Deny" }]));
  assert.deepEqual(result, { outcome: { outcome: "cancelled" } });
});

test("headless without opt-in cancels", async () => {
  const { handler } = bridge({});
  assert.deepEqual(await handler(params()), { outcome: { outcome: "cancelled" } });
});

test("headless opt-in picks an allow option", async () => {
  const { handler } = bridge({ headlessAllow: true });
  const result = await handler(params());
  assert.deepEqual(result, { outcome: { outcome: "selected", optionId: "allow-always" } });
});

test("interactive select maps the picked label back to its optionId", async () => {
  const { handler } = bridge({
    ui: { select: async (_title, labels) => labels[2] },
  });
  const result = await handler(params());
  assert.deepEqual(result, { outcome: { outcome: "selected", optionId: "deny" } });
});

test("interactive select emits balanced input-required events", async () => {
  const { handler, emitted } = bridge({
    ui: { select: async () => undefined },
  });
  const result = await handler(params());
  assert.deepEqual(result, { outcome: { outcome: "cancelled" } });
  assert.deepEqual(
    emitted.map((e) => [e.event, e.payload.active]),
    [
      [AGENT_INPUT_REQUIRED_EVENT, true],
      [LEGACY_HERDR_BLOCKED_EVENT, true],
      [AGENT_INPUT_REQUIRED_EVENT, false],
      [LEGACY_HERDR_BLOCKED_EVENT, false],
    ],
  );
  assert.equal(emitted[0].payload.source, "devin-acp");
  assert.equal(emitted[0].payload.id, "call-1");
  assert.match(emitted[0].payload.label, /Run npm test/);
});

test("a throwing select still emits the closing event", async () => {
  const { handler, emitted } = bridge({
    ui: {
      select: async () => {
        throw new Error("ui gone");
      },
    },
  });
  await assert.rejects(handler(params()), /ui gone/);
  assert.equal(emitted.at(-1)?.payload.active, false);
});

test("duplicate option names are disambiguated by kind", async () => {
  const seen: string[] = [];
  const { handler } = bridge({
    ui: {
      select: async (_title, labels) => {
        seen.push(...labels);
        return labels[1];
      },
    },
  });
  const result = await handler(
    params([
      { optionId: "a", name: "Allow", kind: "allow_once" },
      { optionId: "b", name: "Allow", kind: "allow_always" },
    ]),
  );
  assert.deepEqual(seen, ["Allow (allow_once)", "Allow (allow_always)"]);
  assert.deepEqual(result, { outcome: { outcome: "selected", optionId: "b" } });
});
