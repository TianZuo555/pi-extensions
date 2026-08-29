import assert from "node:assert/strict";
import { access, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join, parse } from "node:path";
import test from "node:test";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { hashBytes, isPathWithin } from "../lib/helpers.ts";
import {
  findPlaceholders,
  formatAttachmentNote,
  formatImageNotesBlock,
  formatPlaceholder,
} from "../lib/prompt.ts";
import {
  createImageCacheRuntime,
  createImageFileWrittenGate,
  ImageCacheIoError,
  ImageCacheRuntime,
  ImageCacheRuntimeClosedError,
  runImageCache,
} from "../src/runtime.ts";

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const CACHE_ROOT = join(getAgentDir(), "cache", "image-cache");

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test("temporary path checks reject sibling directories with the same prefix", () => {
  const root = join(parse(process.cwd()).root, "tmp");
  assert.equal(isPathWithin(root, join(root, "pi-clipboard-image.png")), true);
  assert.equal(isPathWithin(root, join(`${root}-outside`, "pi-clipboard-image.png")), false);
});

function isClosedError(error: unknown): boolean {
  return (
    error instanceof ImageCacheRuntimeClosedError ||
    (typeof error === "object" &&
      error !== null &&
      "_tag" in error &&
      (error as { _tag: string })._tag === "ImageCacheRuntimeClosedError")
  );
}

test("ImageCacheRuntime init and cacheBytes deduplicates by hash", async () => {
  const runtime = createImageCacheRuntime();
  const cache = runtime.runSync(ImageCacheRuntime);
  const sessionId = `test-${Date.now()}`;

  await runImageCache(runtime, cache.init(sessionId));
  const first = await runImageCache(runtime, cache.cacheBytes(PNG_BYTES, "image/png"));
  const second = await runImageCache(runtime, cache.cacheBytes(PNG_BYTES, "image/png"));
  assert.ok(first);
  assert.equal(second?.placeholder, first?.placeholder);
  assert.equal(await runImageCache(runtime, cache.imageCount), 1);

  await runImageCache(runtime, cache.close);
  await runtime.dispose();
});

test("ImageCacheRuntime persists manifest across init", async () => {
  const runtime = createImageCacheRuntime();
  const cache = runtime.runSync(ImageCacheRuntime);
  const sessionId = `persist-${Date.now()}`;

  await runImageCache(runtime, cache.init(sessionId));
  const cached = await runImageCache(runtime, cache.cacheBytes(PNG_BYTES, "image/png"));
  assert.ok(cached);

  await runImageCache(runtime, cache.close);
  await runtime.dispose();

  const runtime2 = createImageCacheRuntime();
  const cache2 = runtime2.runSync(ImageCacheRuntime);
  await runImageCache(runtime2, cache2.init(sessionId));
  const restored = await runImageCache(runtime2, cache2.getImage(cached!.placeholder));
  assert.ok(restored);
  assert.equal(restored!.sourceHash, hashBytes(PNG_BYTES));

  await runImageCache(runtime2, cache2.close);
  await runtime2.dispose();
});

test("ImageCacheRuntime clear removes images but preserves id sequence", async () => {
  const runtime = createImageCacheRuntime();
  const cache = runtime.runSync(ImageCacheRuntime);
  const sessionId = `clear-${Date.now()}`;

  await runImageCache(runtime, cache.init(sessionId));
  const first = await runImageCache(runtime, cache.cacheBytes(PNG_BYTES, "image/png"));
  assert.ok(first);
  await runImageCache(runtime, cache.clear);
  assert.equal(await runImageCache(runtime, cache.imageCount), 0);

  const second = await runImageCache(runtime, cache.cacheBytes(PNG_BYTES, "image/png"));
  assert.ok(second);
  assert.notEqual(second!.id, first!.id);

  await runImageCache(runtime, cache.close);
  await runtime.dispose();
});

test("ImageCacheRuntime close rejects further operations with ClosedError", async () => {
  const runtime = createImageCacheRuntime();
  const cache = runtime.runSync(ImageCacheRuntime);
  await runImageCache(runtime, cache.init(`closed-${Date.now()}`));
  await runImageCache(runtime, cache.close);

  await assert.rejects(
    () => runImageCache(runtime, cache.cacheBytes(PNG_BYTES, "image/png")),
    (error: unknown) => {
      assert.ok(error instanceof ImageCacheRuntimeClosedError);
      assert.equal(error instanceof ImageCacheIoError, false);
      return true;
    },
  );

  await runtime.dispose();
});

test("ImageCacheRuntime cacheBytes surfaces ImageCacheIoError when cache dir is not writable", async () => {
  const runtime = createImageCacheRuntime();
  const cache = runtime.runSync(ImageCacheRuntime);
  const sessionId = `io-fail-${Date.now()}`;
  const cacheDir = join(CACHE_ROOT, sessionId);

  await runImageCache(runtime, cache.init(sessionId));
  await runImageCache(runtime, cache.close);
  await runtime.dispose();

  await writeFile(cacheDir, "not-a-directory");

  const runtime2 = createImageCacheRuntime();
  const cache2 = runtime2.runSync(ImageCacheRuntime);
  await runImageCache(runtime2, cache2.init(sessionId));

  await assert.rejects(
    () => runImageCache(runtime2, cache2.cacheBytes(PNG_BYTES, "image/png")),
    (error: unknown) => {
      assert.ok(error instanceof ImageCacheIoError);
      assert.equal(error instanceof ImageCacheRuntimeClosedError, false);
      assert.equal(error.operation, "mkdir");
      return true;
    },
  );

  await runImageCache(runtime2, cache2.close);
  await runtime2.dispose();
});

test("ImageCacheRuntime close completes within bounded time after failed cacheBytes", async () => {
  const runtime = createImageCacheRuntime();
  const cache = runtime.runSync(ImageCacheRuntime);
  const sessionId = `close-bounded-${Date.now()}`;
  const cacheDir = join(CACHE_ROOT, sessionId);

  await runImageCache(runtime, cache.init(sessionId));
  await runImageCache(runtime, cache.close);
  await runtime.dispose();

  await writeFile(cacheDir, "not-a-directory");

  const runtime2 = createImageCacheRuntime();
  const cache2 = runtime2.runSync(ImageCacheRuntime);
  await runImageCache(runtime2, cache2.init(sessionId));

  await assert.rejects(
    () => runImageCache(runtime2, cache2.cacheBytes(PNG_BYTES, "image/png")),
    (error: unknown) => error instanceof ImageCacheIoError,
  );

  const closeDeadlineMs = 2000;
  await Promise.race([
    runImageCache(runtime2, cache2.close),
    new Promise((_resolve, reject) => {
      setTimeout(
        () => reject(new Error(`close did not finish within ${closeDeadlineMs}ms`)),
        closeDeadlineMs,
      );
    }),
  ]);

  await runtime2.dispose();
});

test("ImageCacheRuntime close removes empty session directory", async () => {
  const runtime = createImageCacheRuntime();
  const cache = runtime.runSync(ImageCacheRuntime);
  const sessionId = `empty-${Date.now()}`;
  const cacheDir = join(CACHE_ROOT, sessionId);

  await runImageCache(runtime, cache.init(sessionId));
  const count = await runImageCache(runtime, cache.imageCount);
  assert.equal(count, 0);

  await runImageCache(runtime, cache.close);
  assert.equal(await pathExists(cacheDir), false);
  await runtime.dispose();
});

test("ImageCacheRuntime close waits for in-flight mutations and rejects post-close writes", async () => {
  const runtime = createImageCacheRuntime({ testControls: { mutationDelayMs: 250 } });
  const cache = runtime.runSync(ImageCacheRuntime);
  const sessionId = `race-${Date.now()}`;

  await runImageCache(runtime, cache.init(sessionId));

  const mutationOutcomePromise = runImageCache(
    runtime,
    cache.cacheBytes(PNG_BYTES, "image/png"),
  ).then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  await runImageCache(runtime, cache.close);
  const mutationOutcome = await mutationOutcomePromise;

  assert.equal(mutationOutcome.ok, false);
  assert.ok(isClosedError(mutationOutcome.error));

  await assert.rejects(
    () => runImageCache(runtime, cache.cacheBytes(PNG_BYTES, "image/png")),
    (error: unknown) => {
      assert.ok(isClosedError(error));
      return true;
    },
  );

  await runtime.dispose();
});

test("ImageCacheRuntime rolls back orphan files when close interrupts post-write commit", async () => {
  const gate = createImageFileWrittenGate();
  const runtime = createImageCacheRuntime({ testControls: gate.testControls });
  const cache = runtime.runSync(ImageCacheRuntime);
  const sessionId = `orphan-${Date.now()}`;
  const cacheDir = join(CACHE_ROOT, sessionId);

  await runImageCache(runtime, cache.init(sessionId));

  const mutationOutcomePromise = runImageCache(
    runtime,
    cache.cacheBytes(PNG_BYTES, "image/png"),
  ).then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  await gate.waitForImageFileWritten();
  const closePromise = runImageCache(runtime, cache.close);
  gate.release();
  const [mutationOutcome] = await Promise.all([mutationOutcomePromise, closePromise]);

  assert.equal(mutationOutcome.ok, false);
  assert.ok(isClosedError(mutationOutcome.error));

  if (!(await pathExists(cacheDir))) {
    await runtime.dispose();
    return;
  }

  const entries = await readdir(cacheDir);
  const imageFiles = entries.filter((entry) => entry.endsWith(".png") && entry !== "manifest.json");
  assert.equal(imageFiles.length, 0);

  await runtime.dispose();
});

test("ImageCacheRuntime close rejects mutations started after admission stops", async () => {
  const runtime = createImageCacheRuntime({ testControls: { mutationDelayMs: 300 } });
  const cache = runtime.runSync(ImageCacheRuntime);
  const sessionId = `finalize-race-${Date.now()}`;
  const cacheDir = join(CACHE_ROOT, sessionId);

  await runImageCache(runtime, cache.init(sessionId));

  const inFlightOutcomePromise = runImageCache(
    runtime,
    cache.cacheBytes(PNG_BYTES, "image/png"),
  ).then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  const closePromise = runImageCache(runtime, cache.close);

  await assert.rejects(
    () => runImageCache(runtime, cache.cacheBytes(PNG_BYTES, "image/png")),
    (error: unknown) => {
      assert.ok(isClosedError(error));
      return true;
    },
  );

  await closePromise;
  const inFlightOutcome = await inFlightOutcomePromise;
  assert.equal(inFlightOutcome.ok, false);
  assert.ok(isClosedError(inFlightOutcome.error));

  assert.equal(await pathExists(cacheDir), false);
  await runtime.dispose();
});

test("ImageCacheRuntime cleanup preserves recent concurrent session cache directories", async () => {
  const concurrentSessionId = `concurrent-${Date.now()}`;
  const concurrentDir = join(CACHE_ROOT, concurrentSessionId);
  await mkdir(concurrentDir, { recursive: true });
  await writeFile(join(concurrentDir, "manifest.json"), JSON.stringify({ version: 1, images: [] }));

  const runtime = createImageCacheRuntime();
  const cache = runtime.runSync(ImageCacheRuntime);
  const mySessionId = `session-${Date.now()}`;

  try {
    await runImageCache(runtime, cache.init(mySessionId));
    // The concurrent session dir was created recently with only manifest.json;
    // it must not be prematurely deleted by my session's init cleanup.
    assert.equal(await pathExists(concurrentDir), true);
  } finally {
    await runImageCache(runtime, cache.close);
    await runtime.dispose();
    await rm(concurrentDir, { recursive: true, force: true });
  }
});

test("prompt helpers format and parse placeholders correctly", () => {
  assert.equal(formatPlaceholder(1), "[Image#001]");
  assert.equal(formatPlaceholder(42), "[Image#042]");
  assert.equal(formatPlaceholder(1000), "[Image#1000]");

  const text = "Check out [Image#001] and [Image#002] but not [Image#01]";
  const placeholders = findPlaceholders(text);
  assert.deepEqual(placeholders, ["[Image#001]", "[Image#002]"]);

  assert.equal(
    formatAttachmentNote("[Image#001]", 1, "image resized to 100x100"),
    "[Image#001] = attachment 1 (image resized to 100x100)",
  );
  assert.equal(formatAttachmentNote("[Image#002]", 2), "[Image#002] = attachment 2");

  assert.equal(
    formatImageNotesBlock(["[Image#001] = attachment 1"]),
    "\n\n<image-cache-notes>\n[Image#001] = attachment 1\n</image-cache-notes>",
  );
  assert.equal(formatImageNotesBlock([]), "");
});
