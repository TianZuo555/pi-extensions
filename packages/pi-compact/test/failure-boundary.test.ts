import assert from "node:assert/strict";
import test from "node:test";
import { latestCheckpoint } from "../src/checkpoint.ts";
import { checkpointMarker } from "../src/prompt.ts";
import { harness, userItem } from "./fixtures.ts";

type Harness = ReturnType<typeof harness>;
const fail = () => {
  throw new Error("unexpected service failure");
};
const cases: { name: string; setup: (h: Harness) => void; requests: number }[] = [
  {
    name: "settings read",
    setup: (h) => {
      h.runtime.get = fail;
    },
    requests: 0,
  },
  {
    name: "model selection",
    setup: (h) => {
      h.settings.compactionModel = "openai-codex/missing";
      h.ctx.modelRegistry.find = fail;
    },
    requests: 0,
  },
  {
    name: "model warning before the request try block",
    setup: (h) => {
      h.settings.compactionModel = "openai-codex/missing";
      h.ctx.ui.notify = fail;
    },
    requests: 0,
  },
  {
    name: "initial status update",
    setup: (h) => {
      h.ctx.ui.setStatus = fail;
    },
    requests: 0,
  },
  {
    name: "status cleanup after successful remote compaction",
    setup: (h) => {
      h.ctx.ui.setStatus = (_key, value) => {
        if (value === undefined) fail();
      };
    },
    requests: 1,
  },
  {
    name: "cancellation notification on the disabled path",
    setup: (h) => {
      h.settings.enabled = false;
      h.ctx.ui.notify = fail;
    },
    requests: 0,
  },
  {
    name: "failure notification inside the inner catch block",
    setup: (h) => {
      h.ctx.modelRegistry.getApiKeyAndHeaders = async () => fail();
      h.ctx.ui.notify = fail;
    },
    requests: 0,
  },
];

for (const { name, setup, requests } of cases) {
  test(`outer boundary cancels instead of throwing when ${name} fails`, async () => {
    const h = harness({ prior: true });
    const before = structuredClone(h.sm.getBranch());
    setup(h);
    // Do not emulate Pi's catch here: rejection must fail the test because the real runner
    // would swallow it and produce undefined, incorrectly permitting native compaction.
    assert.deepEqual(await h.compact(), { cancel: true });
    assert.deepEqual(h.sm.getBranch(), before);
    assert.equal(h.payloads.length, requests);
  });
}

test("a broken notification on the blacklisted route cannot bypass checkpoint protection", async () => {
  const h = harness({
    prior: true,
    fetch: async () => new Response("404 page not found", { status: 404 }),
  });
  assert.deepEqual(await h.compact(), { cancel: true });
  h.ctx.ui.notify = fail;
  assert.deepEqual(await h.compact(), { cancel: true });
  assert.equal(h.payloads.length, 1);
});

test("unexpected exceptions without an opaque checkpoint remain visible to Pi's runner", async () => {
  const h = harness();
  h.ctx.ui.setStatus = fail;
  await assert.rejects(h.compact(), /unexpected service failure/);
});

test("the provider hook quietly leaves an ambiguous marker payload unchanged", async () => {
  const h = harness({ prior: true });
  const checkpoint = latestCheckpoint(h.sm.getBranch());
  assert(checkpoint);
  const marker = checkpointMarker(checkpoint.details.checkpointId);
  const payload = { input: [userItem(marker), userItem(marker)] };
  const before = structuredClone(payload);
  assert.equal(await h.call("before_provider_request", { payload }), undefined);
  assert.deepEqual(payload, before);
  assert.deepEqual(h.notifications, []);
});

test("a blacklisted route gives one additional native-fallback reminder per session", async () => {
  const h = harness({ fetch: async () => new Response("404 page not found", { status: 404 }) });
  assert.equal(await h.compact(), undefined);
  assert.equal(h.notifications.length, 1);
  assert.match(h.notifications[0], /using Pi compaction/);
  for (let i = 0; i < 3; i++) assert.equal(await h.compact(), undefined);
  assert.equal(h.payloads.length, 1);
  assert.equal(h.notifications.length, 2);
  assert.match(h.notifications[1], /remains disabled for this route/);

  await h.call("session_start", {});
  assert.equal(await h.compact(), undefined);
  assert.equal(await h.compact(), undefined);
  assert.equal(h.payloads.length, 2);
  assert.equal(h.notifications.length, 4);
});

test("blacklist reminders respect notifyOnFallback", async () => {
  const h = harness({
    settings: { notifyOnFallback: false },
    fetch: async () => new Response("404 page not found", { status: 404 }),
  });
  assert.equal(await h.compact(), undefined);
  assert.equal(await h.compact(), undefined);
  assert.equal(h.payloads.length, 1);
  assert.deepEqual(h.notifications, []);
});

test("a broken blacklist reminder does not count as successfully delivered", async () => {
  const h = harness({ fetch: async () => new Response("404 page not found", { status: 404 }) });
  await h.compact();
  const notify = h.ctx.ui.notify;
  h.ctx.ui.notify = fail;
  await assert.rejects(h.compact(), /unexpected service failure/);
  h.ctx.ui.notify = notify;
  assert.equal(await h.compact(), undefined);
  assert.match(h.notifications.at(-1)!, /remains disabled for this route/);
  assert.equal(h.payloads.length, 1);
});
