/**
 * ImageCacheRuntime — Effect v4-owned manifest, cache files, cleanup, and subprocess I/O.
 *
 * Sync entry rendering and display memo stay in `index.ts`; this service owns
 * session cache lifecycle, concurrent-safe state, and deterministic shutdown.
 *
 * Error semantics: `ImageCacheRuntimeClosedError` is lifecycle closure only.
 * Filesystem/subprocess failures use `ImageCacheIoError` with an operation label.
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import {
  convertToPng,
  formatDimensionNote,
  getAgentDir,
  resizeImage,
} from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";
import {
  Cause,
  Context,
  Data,
  Effect,
  Exit,
  Fiber,
  FiberSet,
  Layer,
  ManagedRuntime,
  MutableRef,
  Result,
  SynchronizedRef,
} from "effect";
import {
  CACHE_TTL_MS,
  detectMimeType,
  displayPathFor,
  fileStem,
  findByHash,
  formatPlaceholder,
  hashBytes,
  imageExtension,
  isInsideTmpDir,
  MAX_INLINE_BYTES,
  MAX_SOURCE_BYTES,
  MODEL_SUPPORTED_MIMES,
  normalizeMimeType,
  previewEntryData,
} from "../lib/helpers.ts";
import type {
  CachedImage,
  ClipboardImages,
  ClipboardScriptResult,
  Manifest,
  PreviewEntryData,
} from "../lib/types.ts";

const execFileAsync = promisify(execFile);
const CACHE_ROOT = join(getAgentDir(), "cache", "image-cache");

function parseManifest(raw: string): Manifest {
  try {
    return JSON.parse(raw) as Manifest;
  } catch {
    return { version: 1, images: [] };
  }
}

export class ImageCacheRuntimeClosedError extends Data.TaggedError("ImageCacheRuntimeClosedError")<{
  readonly message: string;
}> {}

export class ImageCacheIoError extends Data.TaggedError("ImageCacheIoError")<{
  readonly operation: string;
  readonly path?: string;
  readonly message: string;
  readonly cause: unknown;
}> {}

export type ImageCacheRuntimeError = ImageCacheRuntimeClosedError | ImageCacheIoError;

function ioError(operation: string, cause: unknown, path?: string): ImageCacheIoError {
  return new ImageCacheIoError({
    operation,
    ...(path ? { path } : {}),
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });
}

function tryIo<A>(
  operation: string,
  tryFn: () => Promise<A>,
  path?: string,
): Effect.Effect<A, ImageCacheIoError> {
  return Effect.tryPromise({
    try: tryFn,
    catch: (cause) => ioError(operation, cause, path),
  });
}

/** Best-effort IO: failures are absorbed (cleanup, touch, missing manifest, clipboard). */
function tryIoBestEffort<A>(
  operation: string,
  tryFn: () => Promise<A>,
  path?: string,
): Effect.Effect<A | undefined, never> {
  return tryIo(operation, tryFn, path).pipe(Effect.orElseSucceed(() => undefined));
}

/** Per-runtime test controls injected at construction time. */
export interface ImageCachePostWriteTestGate {
  readonly onImageFileWritten: () => void;
  readonly waitUntilReleased: () => Promise<void>;
}

export interface ImageCacheRuntimeTestControls {
  readonly mutationDelayMs?: number;
  readonly postImageWriteDelayMs?: number;
  readonly postWriteGate?: ImageCachePostWriteTestGate;
}

export interface ImageCacheRuntimeOptions {
  readonly testControls?: ImageCacheRuntimeTestControls;
}

interface ResolvedImageCacheRuntimeConfig {
  readonly mutationDelayMs: number;
  readonly postImageWriteDelayMs: number;
  readonly postWriteGate?: ImageCachePostWriteTestGate;
}

const defaultRuntimeConfig: ResolvedImageCacheRuntimeConfig = {
  mutationDelayMs: 0,
  postImageWriteDelayMs: 0,
};

function resolveRuntimeConfig(options?: ImageCacheRuntimeOptions): ResolvedImageCacheRuntimeConfig {
  return {
    mutationDelayMs: options?.testControls?.mutationDelayMs ?? 0,
    postImageWriteDelayMs: options?.testControls?.postImageWriteDelayMs ?? 0,
    postWriteGate: options?.testControls?.postWriteGate,
  };
}

/** Synchronous post-write barrier for deterministic orphan-window tests. */
export function createImageFileWrittenGate(): {
  readonly testControls: ImageCacheRuntimeTestControls;
  readonly waitForImageFileWritten: () => Promise<void>;
  readonly release: () => void;
} {
  let notifyWritten!: () => void;
  let releaseBarrier!: () => void;
  const writtenPromise = new Promise<void>((resolve) => {
    notifyWritten = resolve;
  });
  const releasePromise = new Promise<void>((resolve) => {
    releaseBarrier = resolve;
  });
  return {
    testControls: {
      postWriteGate: {
        onImageFileWritten: () => notifyWritten(),
        waitUntilReleased: () => releasePromise,
      },
    },
    waitForImageFileWritten: () => writtenPromise,
    release: () => releaseBarrier(),
  };
}

interface ImageCacheState {
  cacheDir: string;
  manifestPath: string;
  nextImageId: number;
  imagesByPlaceholder: Map<string, CachedImage>;
}

function sessionState(sessionId: string): ImageCacheState {
  const safeSessionId = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const cacheDir = join(CACHE_ROOT, safeSessionId);
  return {
    cacheDir,
    manifestPath: join(cacheDir, "manifest.json"),
    nextImageId: 1,
    imagesByPlaceholder: new Map(),
  };
}

export interface ImageCacheRuntimeShape {
  readonly init: (sessionId: string) => Effect.Effect<void, ImageCacheRuntimeError>;
  readonly imageCount: Effect.Effect<number, ImageCacheRuntimeClosedError>;
  readonly getImage: (
    placeholder: string,
  ) => Effect.Effect<CachedImage | undefined, ImageCacheRuntimeClosedError>;
  readonly listImages: Effect.Effect<CachedImage[], ImageCacheRuntimeClosedError>;
  readonly previewData: (cached: CachedImage) => PreviewEntryData;
  readonly cacheBytes: (
    bytes: Buffer,
    detectedMime: string,
    sourcePath?: string,
  ) => Effect.Effect<CachedImage | null, ImageCacheRuntimeError>;
  readonly cacheImageFile: (
    filePath: string,
    sourcePath?: string,
  ) => Effect.Effect<CachedImage | null, ImageCacheRuntimeError>;
  readonly cacheExistingImage: (
    sourcePath: string,
  ) => Effect.Effect<CachedImage | null, ImageCacheRuntimeError>;
  readonly readMacClipboardImages: Effect.Effect<ClipboardImages, ImageCacheRuntimeClosedError>;
  readonly readMacClipboardText: Effect.Effect<string | null, ImageCacheRuntimeClosedError>;
  readonly toImageContent: (
    cached: CachedImage,
  ) => Effect.Effect<
    { content: ImageContent; note?: string } | { error: string },
    ImageCacheRuntimeError
  >;
  readonly touchCacheDir: Effect.Effect<void, ImageCacheRuntimeClosedError>;
  readonly clear: Effect.Effect<void, ImageCacheRuntimeError>;
  readonly close: Effect.Effect<void, ImageCacheRuntimeClosedError>;
}

export class ImageCacheRuntime extends Context.Service<ImageCacheRuntime, ImageCacheRuntimeShape>()(
  "pi-image-cache/ImageCacheRuntime",
) {}

const makeImageCacheRuntime = (config: ResolvedImageCacheRuntimeConfig) =>
  Effect.gen(function* () {
    const ref = yield* SynchronizedRef.make<ImageCacheState>(
      sessionState(`process-${process.pid}`),
    );
    const workers = yield* FiberSet.make();
    const inFlight = MutableRef.make(0);
    const closed = MutableRef.make(false);

    const closedError = () =>
      new ImageCacheRuntimeClosedError({
        message: "Image cache runtime is shut down; no further cache operations are accepted.",
      });

    const ensureOpen: Effect.Effect<void, ImageCacheRuntimeClosedError> = Effect.suspend(() =>
      MutableRef.get(closed) ? Effect.fail(closedError()) : Effect.void,
    );

    const rejectIfClosed: Effect.Effect<void, ImageCacheRuntimeClosedError> = Effect.suspend(() =>
      MutableRef.get(closed) ? Effect.fail(closedError()) : Effect.void,
    );

    const decrementInFlight = Effect.sync(() => {
      MutableRef.set(inFlight, Math.max(0, MutableRef.get(inFlight) - 1));
    });

    /** Open-check and increment happen in one synchronous step (no yield between them). */
    const acquireInFlight: Effect.Effect<void, ImageCacheRuntimeClosedError> = Effect.suspend(
      () => {
        if (MutableRef.get(closed)) return Effect.fail(closedError());
        MutableRef.set(inFlight, MutableRef.get(inFlight) + 1);
        return Effect.void;
      },
    );

    const waitForDrain = (): Effect.Effect<void> =>
      Effect.gen(function* () {
        while (MutableRef.get(inFlight) > 0) {
          yield* Effect.sleep(5);
        }
      });

    const runTracked = <A, E>(
      effect: Effect.Effect<A, E>,
    ): Effect.Effect<A, E | ImageCacheRuntimeClosedError> =>
      acquireInFlight.pipe(
        Effect.flatMap(() =>
          Effect.gen(function* () {
            const fiber = yield* FiberSet.run(workers, effect);
            return yield* Fiber.join(fiber);
          }),
        ),
        Effect.ensuring(decrementInFlight),
      );

    const writeManifest = (state: ImageCacheState) =>
      tryIo(
        "writeManifest",
        async () => {
          const { mkdir, rename, writeFile } = await import("node:fs/promises");
          await mkdir(state.cacheDir, { recursive: true });
          const manifest: Manifest = {
            version: 1,
            images: [...state.imagesByPlaceholder.values()],
          };
          const tmpPath = `${state.manifestPath}.${process.pid}.tmp`;
          await writeFile(tmpPath, JSON.stringify(manifest, null, 2), "utf8");
          await rename(tmpPath, state.manifestPath);
        },
        state.manifestPath,
      );

    const toPngBytes = (bytes: Buffer, mimeType: string, stagePath: string) =>
      tryIo(
        "convertToPng",
        async () => {
          const converted = await convertToPng(bytes.toString("base64"), mimeType).catch(
            () => null,
          );
          if (converted) return Buffer.from(converted.data, "base64");
          if (process.platform !== "darwin") return null;

          const outPath = `${stagePath}.png`;
          const { readFile, unlink, writeFile } = await import("node:fs/promises");
          try {
            await writeFile(stagePath, bytes);
            await execFileAsync(
              "/usr/bin/sips",
              ["-s", "format", "png", stagePath, "--out", outPath],
              {
                timeout: 10_000,
                maxBuffer: 2 * 1024 * 1024,
              },
            );
            return await readFile(outPath);
          } catch {
            return null;
          } finally {
            await unlink(stagePath).catch(() => undefined);
            await unlink(outPath).catch(() => undefined);
          }
        },
        stagePath,
      );

    const cacheBytesLocked = (
      state: ImageCacheState,
      bytes: Buffer,
      detectedMime: string,
      sourcePath?: string,
    ): Effect.Effect<
      readonly [ImageCacheState, CachedImage | null],
      ImageCacheIoError | ImageCacheRuntimeClosedError
    > => {
      const orphanPaths: string[] = [];
      let committed = false;

      const rollbackOrphans = Effect.gen(function* () {
        if (committed) return;
        const { unlink } = yield* Effect.promise(() => import("node:fs/promises"));
        for (const orphanPath of orphanPaths) {
          yield* tryIoBestEffort("unlink", () => unlink(orphanPath), orphanPath);
        }
      });

      return Effect.gen(function* () {
        if (config.mutationDelayMs > 0) yield* Effect.sleep(config.mutationDelayMs);
        yield* rejectIfClosed;

        const sourceHash = hashBytes(bytes);
        const existing = findByHash(state.imagesByPlaceholder.values(), sourceHash);
        if (existing) return [state, existing] as const;

        const { mkdir, writeFile } = yield* Effect.promise(() => import("node:fs/promises"));
        yield* tryIo("mkdir", () => mkdir(state.cacheDir, { recursive: true }), state.cacheDir);

        const id = state.nextImageId;
        const placeholder = formatPlaceholder(id);
        let mimeType = normalizeMimeType(detectedMime);
        let storedBytes = bytes;

        if (!MODEL_SUPPORTED_MIMES.has(mimeType)) {
          const stagePath = join(state.cacheDir, `${fileStem(placeholder)}.source`);
          const png = yield* toPngBytes(bytes, mimeType, stagePath);
          if (!png) return [state, null] as const;
          storedBytes = png;
          mimeType = "image/png";
        }

        const filePath = join(
          state.cacheDir,
          `${fileStem(placeholder)}.${imageExtension(mimeType)}`,
        );
        yield* rejectIfClosed;
        yield* tryIo("writeFile", () => writeFile(filePath, storedBytes), filePath);
        orphanPaths.push(filePath);

        if (mimeType !== "image/png") {
          const converted = yield* tryIo("convertDisplayPng", () =>
            convertToPng(storedBytes.toString("base64"), mimeType).catch(() => null),
          ).pipe(Effect.orElseSucceed(() => null));
          if (converted) {
            const displayPath = displayPathFor(filePath);
            yield* tryIoBestEffort(
              "writeDisplayPng",
              () => writeFile(displayPath, Buffer.from(converted.data, "base64")),
              displayPath,
            );
            orphanPaths.push(displayPath);
          }
        }

        if (config.postWriteGate) {
          config.postWriteGate.onImageFileWritten();
          yield* Effect.tryPromise({
            try: () => config.postWriteGate!.waitUntilReleased(),
            catch: (cause) =>
              new ImageCacheRuntimeClosedError({
                message: cause instanceof Error ? cause.message : String(cause),
              }),
          });
        }

        if (config.postImageWriteDelayMs > 0) yield* Effect.sleep(config.postImageWriteDelayMs);
        yield* rejectIfClosed;

        const cached: CachedImage = {
          id,
          placeholder,
          filePath,
          mimeType,
          createdAt: Date.now(),
          sourceHash,
          ...(sourcePath ? { sourcePath } : {}),
        };
        const nextState: ImageCacheState = {
          ...state,
          nextImageId: id + 1,
          imagesByPlaceholder: new Map(state.imagesByPlaceholder).set(placeholder, cached),
        };
        yield* writeManifest(nextState);
        committed = true;
        return [nextState, cached] as const;
      }).pipe(Effect.ensuring(rollbackOrphans));
    };

    const cacheBytesEffect = (
      bytes: Buffer,
      detectedMime: string,
      sourcePath?: string,
    ): Effect.Effect<CachedImage | null, ImageCacheRuntimeError> =>
      SynchronizedRef.modifyEffect(ref, (state) =>
        cacheBytesLocked(state, bytes, detectedMime, sourcePath).pipe(
          Effect.map(([nextState, cached]) => [Effect.succeed(cached), nextState] as const),
        ),
      ).pipe(Effect.flatten);

    const cacheBytes = (
      bytes: Buffer,
      detectedMime: string,
      sourcePath?: string,
    ): Effect.Effect<CachedImage | null, ImageCacheRuntimeError> =>
      runTracked(cacheBytesEffect(bytes, detectedMime, sourcePath));

    const cacheImageFileEffect = (filePath: string, sourcePath?: string) =>
      tryIo(
        "readImageFile",
        async () => {
          const { readFile, stat } = await import("node:fs/promises");
          const info = await stat(filePath);
          if (!info.isFile() || info.size === 0 || info.size > MAX_SOURCE_BYTES) return null;
          const bytes = await readFile(filePath);
          const detectedMime = detectMimeType(filePath, bytes);
          if (!detectedMime) return null;
          return { bytes, detectedMime };
        },
        filePath,
      ).pipe(
        Effect.flatMap((parsed) =>
          parsed
            ? cacheBytesEffect(parsed.bytes, parsed.detectedMime, sourcePath)
            : Effect.succeed(null),
        ),
      );

    const cacheImageFile = (filePath: string, sourcePath?: string) =>
      runTracked(cacheImageFileEffect(filePath, sourcePath));

    const cacheExistingImage = (sourcePath: string) =>
      cacheImageFile(sourcePath, sourcePath).pipe(
        Effect.flatMap((cached) =>
          cached && basename(sourcePath).startsWith("pi-clipboard-") && isInsideTmpDir(sourcePath)
            ? tryIoBestEffort(
                "unlink",
                async () => {
                  const { unlink } = await import("node:fs/promises");
                  await unlink(sourcePath);
                },
                sourcePath,
              ).pipe(Effect.as(cached))
            : Effect.succeed(cached),
        ),
      );

    const loadManifestEffect = SynchronizedRef.modifyEffect(ref, (state) =>
      Effect.gen(function* () {
        const { readFile } = yield* Effect.promise(() => import("node:fs/promises"));
        const { existsSync } = yield* Effect.promise(() => import("node:fs"));
        const next: ImageCacheState = {
          ...state,
          imagesByPlaceholder: new Map(),
          nextImageId: 1,
        };
        let dropped = false;
        const readResult = yield* tryIo(
          "readManifest",
          () => readFile(state.manifestPath, "utf8"),
          state.manifestPath,
        ).pipe(Effect.orElseSucceed(() => null));
        if (readResult) {
          const manifest = parseManifest(readResult);
          for (const image of manifest.images ?? []) {
            next.nextImageId = Math.max(next.nextImageId, image.id + 1);
            if (!existsSync(image.filePath)) {
              dropped = true;
              continue;
            }
            next.imagesByPlaceholder.set(image.placeholder, image);
          }
        }
        const persist = dropped ? writeManifest(next) : Effect.void;
        return [persist, next] as const;
      }),
    ).pipe(Effect.flatten);

    const cleanupOldCachesEffect = SynchronizedRef.get(ref).pipe(
      Effect.flatMap((state) =>
        tryIoBestEffort("cleanupOldCaches", async () => {
          const { mkdir, readdir, rm, stat } = await import("node:fs/promises");
          await mkdir(CACHE_ROOT, { recursive: true });
          const entries = await readdir(CACHE_ROOT, { withFileTypes: true });
          const now = Date.now();
          await Promise.all(
            entries
              .filter((entry) => entry.isDirectory())
              .map(async (entry) => {
                const fullPath = join(CACHE_ROOT, entry.name);
                if (fullPath === state.cacheDir) return;
                try {
                  const [info, contents] = await Promise.all([stat(fullPath), readdir(fullPath)]);
                  const expired = now - info.mtimeMs > CACHE_TTL_MS;
                  const isEmpty = contents.length === 0;
                  const onlyManifest = contents.length === 1 && contents[0] === "manifest.json";
                  if (expired || isEmpty || onlyManifest) {
                    await rm(fullPath, { recursive: true, force: true });
                  }
                } catch {
                  // Per-entry cleanup failures are ignored.
                }
              }),
          );
        }),
      ),
    );

    const touchCacheDirEffect = SynchronizedRef.get(ref).pipe(
      Effect.flatMap((state) =>
        tryIoBestEffort(
          "utimes",
          async () => {
            const { utimes } = await import("node:fs/promises");
            const now = new Date();
            await utimes(state.cacheDir, now, now);
          },
          state.cacheDir,
        ),
      ),
    );

    /** Clipboard caching is best-effort: per-file IO failures become unreadable paths. */
    const cacheClipboardFile = (path: string) =>
      cacheImageFileEffect(path, path).pipe(
        Effect.catchIf(
          (error): error is ImageCacheIoError => error instanceof ImageCacheIoError,
          () => Effect.succeed(null),
        ),
      );

    const readMacClipboardImagesEffect =
      process.platform === "darwin"
        ? SynchronizedRef.get(ref).pipe(
            Effect.flatMap((state) =>
              tryIoBestEffort("readMacClipboard", async () => {
                const { mkdir } = await import("node:fs/promises");
                await mkdir(state.cacheDir, { recursive: true });
                const rawPath = join(state.cacheDir, `clipboard-${randomUUID()}.raw`);
                const quotedPath = JSON.stringify(rawPath);
                const script = `
ObjC.import('AppKit');
ObjC.import('Foundation');
const out = ${quotedPath};
const pb = $.NSPasteboard.generalPasteboard;
let result = { kind: 'none' };
const options = $({
  NSPasteboardURLReadingFileURLsOnlyKey: 1,
  NSPasteboardURLReadingContentsConformToTypesKey: ['public.image'],
});
const urls = pb.readObjectsForClassesOptions($([$.NSURL]), options);
const paths = [];
if (urls) {
  for (let i = 0; i < urls.count; i++) {
    const path = ObjC.unwrap(urls.objectAtIndex(i).path);
    if (path) paths.push(path);
  }
}
if (paths.length > 0) result = { kind: 'files', paths: paths };
if (result.kind === 'none') {
  const candidates = [
    'public.png', 'public.jpeg', 'com.compuserve.gif', 'org.webmproject.webp',
    'public.webp', 'public.heic', 'public.heif', 'public.tiff',
  ];
  for (const uti of candidates) {
    const data = pb.dataForType(uti);
    if (data && data.length > 0) {
      if (!data.writeToFileAtomically(out, true)) throw new Error('failed to write clipboard image');
      result = { kind: 'data' };
      break;
    }
  }
}
JSON.stringify(result);
`;
                try {
                  const { stdout } = await execFileAsync(
                    "osascript",
                    ["-l", "JavaScript", "-e", script],
                    {
                      timeout: 5_000,
                      maxBuffer: 256 * 1024,
                    },
                  );
                  const result = JSON.parse(stdout.trim()) as ClipboardScriptResult;
                  return { result, rawPath };
                } catch {
                  return { result: { kind: "none" } as ClipboardScriptResult, rawPath };
                }
              }).pipe(
                Effect.flatMap((payload) => {
                  if (!payload) return Effect.succeed({ images: [], unreadable: [] });
                  const { result, rawPath } = payload;
                  if (result.kind === "files") {
                    return Effect.all(
                      result.paths.map((path) =>
                        cacheClipboardFile(path).pipe(Effect.map((image) => ({ path, image }))),
                      ),
                      { concurrency: "unbounded" },
                    ).pipe(
                      Effect.map((entries) => {
                        const images: CachedImage[] = [];
                        const unreadable: string[] = [];
                        for (const entry of entries) {
                          if (entry.image) images.push(entry.image);
                          else unreadable.push(entry.path);
                        }
                        return { images, unreadable };
                      }),
                    );
                  }
                  if (result.kind === "data") {
                    return cacheClipboardFile(rawPath).pipe(
                      Effect.map((cached) => ({
                        images: cached ? [cached] : [],
                        unreadable: [] as string[],
                      })),
                      Effect.ensuring(
                        tryIoBestEffort(
                          "unlink",
                          async () => {
                            const { unlink } = await import("node:fs/promises");
                            await unlink(rawPath);
                          },
                          rawPath,
                        ),
                      ),
                    );
                  }
                  return Effect.succeed({ images: [], unreadable: [] }).pipe(
                    Effect.ensuring(
                      tryIoBestEffort(
                        "unlink",
                        async () => {
                          const { unlink } = await import("node:fs/promises");
                          await unlink(rawPath);
                        },
                        rawPath,
                      ),
                    ),
                  );
                }),
              ),
            ),
          )
        : Effect.succeed({ images: [], unreadable: [] });

    const readMacClipboardTextEffect =
      process.platform === "darwin"
        ? tryIoBestEffort("readMacClipboardText", async () => {
            const { stdout } = await execFileAsync("pbpaste", [], {
              timeout: 5_000,
              maxBuffer: 8 * 1024 * 1024,
            });
            return stdout.length > 0 ? stdout : null;
          }).pipe(Effect.map((text) => text ?? null))
        : Effect.succeed(null);

    const toImageContentEffect = (cached: CachedImage) =>
      tryIo(
        "readFile",
        async () => {
          const { readFile } = await import("node:fs/promises");
          const bytes = await readFile(cached.filePath);
          const resized =
            cached.mimeType === "image/gif"
              ? null
              : await resizeImage(bytes, cached.mimeType, { maxWidth: 2000, maxHeight: 2000 });

          if (resized) {
            return {
              content: { type: "image" as const, mimeType: resized.mimeType, data: resized.data },
              ...(formatDimensionNote(resized) ? { note: formatDimensionNote(resized) } : {}),
            };
          }

          if (bytes.length > MAX_INLINE_BYTES) {
            return {
              error: `${cached.placeholder} is too large to send inline (${Math.round(bytes.length / 1024)} KB)`,
            };
          }

          return {
            content: {
              type: "image" as const,
              mimeType: cached.mimeType,
              data: bytes.toString("base64"),
            },
          };
        },
        cached.filePath,
      );

    const toImageContent = (cached: CachedImage) => runTracked(toImageContentEffect(cached));

    const clearEffect = SynchronizedRef.modifyEffect(ref, (state) =>
      tryIo(
        "rm",
        async () => {
          const { rm } = await import("node:fs/promises");
          await rm(state.cacheDir, { recursive: true, force: true });
        },
        state.cacheDir,
      ).pipe(
        Effect.as([
          Effect.void,
          {
            ...state,
            imagesByPlaceholder: new Map(),
          },
        ] as const),
      ),
    ).pipe(Effect.flatten);

    const removeEmptyCacheDirEffect = SynchronizedRef.modifyEffect(ref, (state) => {
      const effect =
        state.imagesByPlaceholder.size === 0
          ? tryIoBestEffort(
              "rm",
              async () => {
                const { rm } = await import("node:fs/promises");
                await rm(state.cacheDir, { recursive: true, force: true });
              },
              state.cacheDir,
            )
          : Effect.void;
      return effect.pipe(Effect.as([Effect.void, state] as const));
    }).pipe(Effect.flatten);

    return ImageCacheRuntime.of({
      init: (sessionId) =>
        runTracked(
          SynchronizedRef.set(ref, sessionState(sessionId)).pipe(
            Effect.flatMap(() => cleanupOldCachesEffect),
            Effect.flatMap(() => loadManifestEffect),
            Effect.flatMap(() => touchCacheDirEffect),
          ),
        ),

      imageCount: ensureOpen.pipe(
        Effect.flatMap(() => SynchronizedRef.get(ref)),
        Effect.map((state) => state.imagesByPlaceholder.size),
      ),

      getImage: (placeholder) =>
        ensureOpen.pipe(
          Effect.flatMap(() => SynchronizedRef.get(ref)),
          Effect.map((state) => state.imagesByPlaceholder.get(placeholder)),
        ),

      listImages: ensureOpen.pipe(
        Effect.flatMap(() => SynchronizedRef.get(ref)),
        Effect.map((state) => [...state.imagesByPlaceholder.values()]),
      ),

      previewData: previewEntryData,

      cacheBytes,
      cacheImageFile,
      cacheExistingImage,
      readMacClipboardImages: runTracked(readMacClipboardImagesEffect),
      readMacClipboardText: runTracked(readMacClipboardTextEffect),
      toImageContent,
      touchCacheDir: runTracked(touchCacheDirEffect),

      clear: runTracked(clearEffect),

      close: ensureOpen.pipe(
        Effect.andThen(
          Effect.sync(() => {
            MutableRef.set(closed, true);
          }),
        ),
        Effect.andThen(Effect.yieldNow),
        Effect.andThen(waitForDrain()),
        Effect.andThen(removeEmptyCacheDirEffect),
      ),
    });
  });

export const ImageCacheRuntimeLive: Layer.Layer<ImageCacheRuntime> = Layer.effect(
  ImageCacheRuntime,
  makeImageCacheRuntime(defaultRuntimeConfig),
);

export function createImageCacheRuntime(options?: ImageCacheRuntimeOptions) {
  return ManagedRuntime.make(
    Layer.effect(ImageCacheRuntime, makeImageCacheRuntime(resolveRuntimeConfig(options))),
  );
}

export type ImageCacheRuntimeInstance = ReturnType<typeof createImageCacheRuntime>;

export async function runImageCache<A, E>(
  runtime: ImageCacheRuntimeInstance,
  effect: Effect.Effect<A, E>,
  options: { signal?: AbortSignal } = {},
): Promise<A> {
  const exit = await runtime.runPromiseExit(
    effect,
    options.signal ? { signal: options.signal } : undefined,
  );
  if (Exit.isSuccess(exit)) return exit.value;
  if (Cause.hasInterruptsOnly(exit.cause)) {
    throw abortError();
  }
  const failure = Cause.findFail(exit.cause);
  if (Result.isSuccess(failure)) throw failure.success.error;
  const [first] = Cause.prettyErrors(exit.cause);
  throw new Error(first?.message ?? Cause.pretty(exit.cause));
}

function abortError(): Error {
  const error = new Error("Image cache operation was aborted");
  error.name = "AbortError";
  return error;
}
