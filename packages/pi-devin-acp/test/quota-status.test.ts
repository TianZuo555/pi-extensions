import assert from "node:assert/strict";
import { test } from "node:test";
import { createDevinQuotaStatus } from "../lib/quota-status.ts";
import type { DevinQuotaResult } from "../lib/quota.ts";

type StatusContext = Parameters<ReturnType<typeof createDevinQuotaStatus>["refresh"]>[0];
const QUOTA: DevinQuotaResult = { ok: true, quota: { dailyUsedPercent: 10 } };

function pendingQuota() {
  let resolve!: (result: DevinQuotaResult) => void;
  const promise = new Promise<DevinQuotaResult>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function context() {
  const writes: (string | undefined)[] = [];
  let provider = "devin";
  const ctx: StatusContext = {
    get model() {
      return { provider } as NonNullable<StatusContext["model"]>;
    },
    ui: {
      setStatus: (key, text) => {
        assert.equal(key, "devin-usage");
        writes.push(text);
      },
    },
  };
  return {
    ctx,
    writes,
    select: (value: string) => {
      provider = value;
    },
  };
}

test("a late quota response cannot restore the footer after model_select clears it", async () => {
  const pending = pendingQuota();
  const status = createDevinQuotaStatus(() => pending.promise);
  const c = context();
  const refresh = status.refresh(c.ctx);
  c.select("anthropic");
  status.clear(c.ctx);
  await status.refresh(c.ctx);
  pending.resolve(QUOTA);
  await refresh;
  assert.deepEqual(c.writes, [undefined, undefined]);
});

test("refresh rechecks the live provider even without another refresh", async () => {
  const pending = pendingQuota();
  const status = createDevinQuotaStatus(() => pending.promise);
  const c = context();
  const refresh = status.refresh(c.ctx);
  c.select("anthropic");
  pending.resolve(QUOTA);
  await refresh;
  assert.deepEqual(c.writes, [undefined]);
});

test("shutdown invalidates pending publication even when the model remains devin", async () => {
  const pending = pendingQuota();
  const status = createDevinQuotaStatus(() => pending.promise);
  const c = context();
  const refresh = status.refresh(c.ctx);
  status.clear(c.ctx);
  pending.resolve(QUOTA);
  await refresh;
  assert.deepEqual(c.writes, [undefined]);
});

test("a replacement session shares the request but only the newest context is updated", async () => {
  const pending = pendingQuota();
  let calls = 0;
  const status = createDevinQuotaStatus(() => {
    calls++;
    return pending.promise;
  });
  const old = context();
  const next = context();
  const first = status.refresh(old.ctx);
  status.clear(old.ctx);
  const second = status.refresh(next.ctx);
  const third = status.refresh(next.ctx);
  pending.resolve(QUOTA);
  await Promise.all([first, second, third]);
  assert.equal(calls, 1);
  assert.deepEqual(old.writes, [undefined]);
  assert.equal(next.writes.length, 1);
  assert.match(next.writes[0]!, /devin 90% day/);
});

test("quota cache survives clearing, expires after 60 seconds, and failures clear the footer", async () => {
  let now = 0;
  let calls = 0;
  let result: DevinQuotaResult = QUOTA;
  const status = createDevinQuotaStatus(
    async () => {
      calls++;
      return result;
    },
    () => now,
  );
  const c = context();
  await status.refresh(c.ctx);
  status.clear(c.ctx);
  now = 59999;
  await status.refresh(c.ctx);
  assert.equal(calls, 1);
  assert.match(c.writes.at(-1)!, /devin 90% day/);
  result = { ok: false, reason: "offline" };
  now = 60000;
  await status.refresh(c.ctx);
  assert.equal(calls, 2);
  assert.equal(c.writes.at(-1), undefined);
});

test("a disposed UI cannot make footer upkeep throw", async () => {
  const status = createDevinQuotaStatus(async () => QUOTA);
  const c = context();
  c.ctx.ui.setStatus = () => {
    throw new Error("disposed");
  };
  status.clear(c.ctx);
  await status.refresh(c.ctx);
});
