import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { Effect } from "effect";
import { fetchProviderJsonEffect } from "../src/fetch.ts";

const SAMPLE = { ok: true };

test("fetchProviderJsonEffect removes abort listeners and timeout after success", async () => {
  const originalFetch = globalThis.fetch;
  const signal = AbortSignal.timeout(50);
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify(SAMPLE), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const result = await Effect.runPromise(
      fetchProviderJsonEffect(
        "https://example.test/usage",
        "secret-token",
        {},
        signal,
        50,
        0,
        "secret-token",
      ),
    );
    assert.deepEqual(result, SAMPLE);
    assert.equal(fetchCalls, 1);
    assert.equal(getEventListeners(signal, "abort").length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchProviderJsonEffect removes abort listeners after failure", async () => {
  const originalFetch = globalThis.fetch;
  const signal = AbortSignal.timeout(50);
  globalThis.fetch = async () =>
    new Response("nope", { status: 500, statusText: "Server Error" });

  try {
    await assert.rejects(
      Effect.runPromise(
        fetchProviderJsonEffect(
          "https://example.test/usage",
          "secret-token",
          {},
          signal,
          50,
          0,
          "secret-token",
        ),
      ),
    );
    assert.equal(getEventListeners(signal, "abort").length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchProviderJsonEffect cleanup runs when the caller aborts in flight", async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  globalThis.fetch = (_url, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
    });

  try {
    const pending = Effect.runPromise(
      fetchProviderJsonEffect(
        "https://example.test/usage",
        "secret-token",
        {},
        controller.signal,
        50,
        0,
        "secret-token",
      ),
    );
    controller.abort();
    await assert.rejects(pending);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
