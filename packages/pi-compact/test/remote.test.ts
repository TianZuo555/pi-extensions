import assert from "node:assert/strict";
import test from "node:test";
import { requestRemoteCompaction } from "../src/remote.ts";
import { fakeApiKey, opaque, provider, sol, completedResponse } from "./fixtures.ts";

const request = () => ({
  provider,
  model: sol,
  apiKey: fakeApiKey,
  context: { messages: [] },
  protocol: "remote-v2" as const,
  signal: new AbortController().signal,
  maxRetries: 0,
});

test("total request deadline also aborts an SSE body stalled after HTTP 200", {
  timeout: 5000,
}, async () => {
  let cancelled = false;
  // A bounded real timer keeps the synthetic stream alive; cancel must clear it.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await assert.rejects(
      requestRemoteCompaction({
        ...request(),
        requestTimeoutMs: 50,
        fetch: async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                timer = setTimeout(() => controller.close(), 4000);
              },
              cancel() {
                cancelled = true;
                clearTimeout(timer);
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
      }),
      /Remote compaction timed out after 50ms/,
    );
    assert.equal(cancelled, true);
  } finally {
    clearTimeout(timer);
  }
});

test("successful completion cleans up its deadline without aborting the caller signal", async () => {
  const input = request();
  const result = await requestRemoteCompaction({
    ...input,
    fetch: async () => completedResponse(),
  });
  assert.deepEqual(result.item, opaque);
  assert.equal(input.signal.aborted, false);
});

test("caller cancellation is not reported as a timeout", async () => {
  await assert.rejects(
    requestRemoteCompaction({
      ...request(),
      signal: AbortSignal.abort(),
      fetch: async () => {
        throw new Error("must not fetch");
      },
    }),
    { name: "AbortError" },
  );
});
