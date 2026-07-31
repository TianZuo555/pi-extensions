import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import {
  convertToPng,
  formatDimensionNote,
  getAgentDir,
  resizeImage,
} from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";
import { Container, getCapabilities, Image, Text } from "@earendil-works/pi-tui";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const EXTENSION_ID = "image-cache";
const ENTRY_TYPE = "image-cache-preview";
const CACHE_ROOT = join(getAgentDir(), "cache", EXTENSION_ID);
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const PLACEHOLDER_RE = /\[Image#(\d{3,})\]/g;

/**
 * Matches any absolute-looking path to a `pi-clipboard-*` temp file that pi
 * inserts into the editor on its own Ctrl+V. The path is only accepted after
 * `isInsideTmpDir()` confirms it really lives in the OS temp directory, so this
 * pattern stays deliberately loose and platform-agnostic (macOS `/var/folders`,
 * Linux `/tmp`, Windows `C:\...\Temp`).
 */
const PI_CLIPBOARD_PATH_RE =
  /(?:^|[\s"'`(<])((?:[A-Za-z]:)?[\\/][^\s"'`<>)]*pi-clipboard-[A-Za-z0-9-]+\.(?:png|jpe?g|gif|webp|tiff?|heic|heif))(?=$|[\s"'`)>.,;:!?])/gi;

/** Inline images larger than this are dropped rather than sent to the provider. */
const MAX_INLINE_BYTES = 4.5 * 1024 * 1024;

/**
 * Upper bound for a source file we are willing to read into memory. Copying a
 * huge image out of Finder should be ignored, not blow up the agent process.
 */
const MAX_SOURCE_BYTES = 64 * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".heic": "image/heic",
  ".heif": "image/heif",
};

const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/tiff": "tiff",
  "image/heic": "heic",
  "image/heif": "heif",
};

const MODEL_SUPPORTED_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

type CachedImage = {
  id: number;
  placeholder: string;
  filePath: string;
  mimeType: string;
  createdAt: number;
  /** sha256 of the *original* pasted bytes, used to deduplicate repeated pastes. */
  sourceHash: string;
  sourcePath?: string;
};

type Manifest = {
  version: 1;
  images: CachedImage[];
};

type PreviewEntryData = {
  placeholder: string;
  filePath: string;
  mimeType: string;
};

let cacheDir = join(CACHE_ROOT, `process-${process.pid}`);
let manifestPath = join(cacheDir, "manifest.json");
let nextImageId = 1;
const imagesByPlaceholder = new Map<string, CachedImage>();
/** Pre-converted, terminal-displayable bytes keyed by cache file path. */
const displayDataByPath = new Map<string, { data: string; mimeType: string }>();

function formatPlaceholder(id: number): string {
  return `[Image#${String(id).padStart(3, "0")}]`;
}

/** `[Image#001]` -> `Image-001`, safe for use as a filename on every platform. */
function fileStem(placeholder: string): string {
  return placeholder.slice(1, -1).replace("#", "-");
}

function normalizeMimeType(mimeType: string): string {
  return mimeType.split(";")[0]?.trim().toLowerCase() || mimeType.toLowerCase();
}

function detectMimeType(filePath: string, bytes: Buffer): string | undefined {
  if (bytes.length >= 12) {
    if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      return "image/png";
    }
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
      return "image/jpeg";
    }
    const head6 = bytes.subarray(0, 6).toString("ascii");
    if (head6 === "GIF87a" || head6 === "GIF89a") {
      return "image/gif";
    }
    if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") {
      return "image/webp";
    }
    if (
      (bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00) ||
      (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a)
    ) {
      return "image/tiff";
    }
    if (bytes.subarray(4, 8).toString("ascii") === "ftyp") {
      const brand = bytes.subarray(8, 12).toString("ascii").toLowerCase();
      if (brand.startsWith("hei") || brand.startsWith("mif")) {
        return brand.startsWith("mif") ? "image/heif" : "image/heic";
      }
    }
  }

  return MIME_BY_EXT[extname(filePath).toLowerCase()];
}

function imageExtension(mimeType: string): string {
  return EXT_BY_MIME[normalizeMimeType(mimeType)] ?? "png";
}

function hashBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function ensureCacheDir(): Promise<void> {
  await mkdir(cacheDir, { recursive: true });
}

/**
 * Bump the cache directory mtime so the TTL sweep in other pi processes treats
 * this session as alive. Without it a long-lived session can have its own
 * images deleted underneath it.
 */
async function touchCacheDir(): Promise<void> {
  try {
    const now = new Date();
    await utimes(cacheDir, now, now);
  } catch {
    // Directory may not exist yet; nothing to keep alive.
  }
}

/**
 * Remove sibling session caches that are either expired or empty. Empty
 * directories are pruned regardless of age because older versions of this
 * extension created one per session even when nothing was ever pasted.
 */
async function cleanupOldCaches(): Promise<void> {
  try {
    await mkdir(CACHE_ROOT, { recursive: true });
    const entries = await readdir(CACHE_ROOT, { withFileTypes: true });
    const now = Date.now();
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const fullPath = join(CACHE_ROOT, entry.name);
          if (fullPath === cacheDir) return;
          try {
            const [info, contents] = await Promise.all([stat(fullPath), readdir(fullPath)]);
            const expired = now - info.mtimeMs > CACHE_TTL_MS;
            const isEmpty = contents.length === 0;
            const onlyManifest = contents.length === 1 && contents[0] === "manifest.json";
            if (expired || isEmpty || onlyManifest) {
              await rm(fullPath, { recursive: true, force: true });
            }
          } catch {
            // Ignore cleanup failures.
          }
        }),
    );
  } catch {
    // Ignore cleanup failures.
  }
}

async function loadManifest(): Promise<void> {
  imagesByPlaceholder.clear();
  displayDataByPath.clear();
  nextImageId = 1;

  try {
    const raw = await readFile(manifestPath, "utf8");
    const manifest = JSON.parse(raw) as Manifest;
    let dropped = false;
    for (const image of manifest.images ?? []) {
      // Always advance the counter so a resumed session never reissues a
      // placeholder that already appears earlier in the transcript.
      nextImageId = Math.max(nextImageId, image.id + 1);
      if (!existsSync(image.filePath)) {
        dropped = true;
        continue;
      }
      imagesByPlaceholder.set(image.placeholder, image);
    }
    if (dropped) await saveManifest();
  } catch {
    // No manifest yet, or it is stale/corrupt.
  }
}

async function saveManifest(): Promise<void> {
  await ensureCacheDir();
  const manifest: Manifest = {
    version: 1,
    images: [...imagesByPlaceholder.values()],
  };
  // Write via a temp file so a crash mid-write cannot truncate the manifest.
  const tmpPath = `${manifestPath}.${process.pid}.tmp`;
  await writeFile(tmpPath, JSON.stringify(manifest, null, 2), "utf8");
  await rename(tmpPath, manifestPath);
}

async function convertToPngWithSips(inputPath: string, outputPath: string): Promise<void> {
  await execFileAsync("/usr/bin/sips", ["-s", "format", "png", inputPath, "--out", outputPath], {
    timeout: 10_000,
    maxBuffer: 2 * 1024 * 1024,
  });
}

function findByHash(hash: string): CachedImage | undefined {
  for (const image of imagesByPlaceholder.values()) {
    if (image.sourceHash === hash) return image;
  }
  return undefined;
}

/**
 * Convert arbitrary image bytes to PNG. Prefers pi's bundled Photon/WASM
 * converter so this works on every platform, falling back to macOS `sips` for
 * formats Photon cannot decode (notably HEIC).
 */
async function toPngBytes(bytes: Buffer, mimeType: string, stagePath: string): Promise<Buffer | null> {
  const converted = await convertToPng(bytes.toString("base64"), mimeType).catch(() => null);
  if (converted) return Buffer.from(converted.data, "base64");

  if (process.platform !== "darwin") return null;

  const outPath = `${stagePath}.png`;
  try {
    await writeFile(stagePath, bytes);
    await convertToPngWithSips(stagePath, outPath);
    return await readFile(outPath);
  } catch {
    return null;
  } finally {
    await unlink(stagePath).catch(() => undefined);
    await unlink(outPath).catch(() => undefined);
  }
}

/**
 * Store already-decoded bytes under a fresh placeholder, converting to PNG when
 * the format is not one providers accept inline. Identical bytes reuse the
 * existing placeholder instead of writing a duplicate file.
 */
async function cacheBytes(bytes: Buffer, detectedMime: string, sourcePath?: string): Promise<CachedImage | null> {
  // Dedup is always keyed on the *source* bytes, so a repeated paste of the
  // same original matches even when it gets converted before storage.
  const sourceHash = hashBytes(bytes);
  const existing = findByHash(sourceHash);
  if (existing) return existing;

  await ensureCacheDir();
  const id = nextImageId++;
  const placeholder = formatPlaceholder(id);
  let mimeType = normalizeMimeType(detectedMime);
  let storedBytes = bytes;

  if (!MODEL_SUPPORTED_MIMES.has(mimeType)) {
    const stagePath = join(cacheDir, `${fileStem(placeholder)}.source`);
    const png = await toPngBytes(bytes, mimeType, stagePath);
    if (!png) {
      nextImageId--;
      return null;
    }
    storedBytes = png;
    mimeType = "image/png";
  }

  const filePath = join(cacheDir, `${fileStem(placeholder)}.${imageExtension(mimeType)}`);
  await writeFile(filePath, storedBytes);

  const cached: CachedImage = {
    id,
    placeholder,
    filePath,
    mimeType,
    createdAt: Date.now(),
    sourceHash,
    ...(sourcePath ? { sourcePath } : {}),
  };
  imagesByPlaceholder.set(placeholder, cached);
  await saveManifest();
  return cached;
}

function isInsideTmpDir(candidate: string): boolean {
  try {
    const root = realpathSync(tmpdir());
    const resolved = realpathSync(candidate);
    return resolved.startsWith(root);
  } catch {
    return false;
  }
}

/** Read an image file from disk into the cache, ignoring non-images and huge files. */
async function cacheImageFile(filePath: string, sourcePath?: string): Promise<CachedImage | null> {
  const info = await stat(filePath);
  if (!info.isFile() || info.size === 0 || info.size > MAX_SOURCE_BYTES) return null;

  const bytes = await readFile(filePath);
  const detectedMime = detectMimeType(filePath, bytes);
  if (!detectedMime) return null;

  return await cacheBytes(bytes, detectedMime, sourcePath);
}

/** Cache an image that already exists on disk (pi's own clipboard temp file). */
async function cacheExistingImage(sourcePath: string): Promise<CachedImage | null> {
  const cached = await cacheImageFile(sourcePath, sourcePath);
  if (!cached) return null;

  // pi never cleans up its own pi-clipboard-* temp files. Once the bytes are in
  // our cache the original is redundant, so remove it to stop temp bloat.
  if (basename(sourcePath).startsWith("pi-clipboard-") && isInsideTmpDir(sourcePath)) {
    await unlink(sourcePath).catch(() => undefined);
  }

  return cached;
}

type ClipboardScriptResult =
  | { kind: "data" }
  | { kind: "files"; paths: string[] }
  | { kind: "none" };

/**
 * Read every image the clipboard offers. Two shapes matter on macOS:
 *
 * - raw image data (screenshots, "Copy Image" in a browser) under an image UTI;
 * - file references (Cmd+C on files in Finder), which carry *no* image data at
 *   all - only `public.file-url` - so they must be resolved and read from disk.
 *
 * The JXA script returns JSON on stdout describing which shape was found; raw
 * data is written to `rawPath` because it cannot travel through stdout.
 */
async function readMacClipboardImagesToCache(): Promise<CachedImage[]> {
  if (process.platform !== "darwin") return [];

  await ensureCacheDir();
  const rawPath = join(cacheDir, `clipboard-${randomUUID()}.raw`);
  const quotedPath = JSON.stringify(rawPath);
  const script = `
ObjC.import('AppKit');
ObjC.import('Foundation');
const out = ${quotedPath};
const pb = $.NSPasteboard.generalPasteboard;
const candidates = [
  'public.png',
  'public.jpeg',
  'com.compuserve.gif',
  'org.webmproject.webp',
  'public.webp',
  'public.heic',
  'public.heif',
  'public.tiff',
];
let result = { kind: 'none' };
for (const uti of candidates) {
  const data = pb.dataForType(uti);
  if (data && data.length > 0) {
    if (!data.writeToFileAtomically(out, true)) {
      throw new Error('failed to write clipboard image');
    }
    result = { kind: 'data' };
    break;
  }
}
if (result.kind === 'none') {
  // Finder copies put file references on the pasteboard. The option keys are
  // the literal Cocoa constant names, including the trailing 'Key' - anything
  // else is silently ignored and would let non-image files through.
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
}
JSON.stringify(result);
`;

  try {
    const { stdout } = await execFileAsync("osascript", ["-l", "JavaScript", "-e", script], {
      timeout: 5_000,
      maxBuffer: 256 * 1024,
    });
    const result = JSON.parse(stdout.trim()) as ClipboardScriptResult;

    if (result.kind === "data") {
      const cached = await cacheImageFile(rawPath);
      return cached ? [cached] : [];
    }

    if (result.kind === "files") {
      const cached: CachedImage[] = [];
      for (const path of result.paths) {
        const image = await cacheImageFile(path, path).catch(() => null);
        if (image) cached.push(image);
      }
      return cached;
    }

    return [];
  } catch {
    return [];
  } finally {
    await unlink(rawPath).catch(() => undefined);
  }
}

async function readMacClipboardText(): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  try {
    const { stdout } = await execFileAsync("pbpaste", [], {
      timeout: 5_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout.length > 0 ? stdout : null;
  } catch {
    return null;
  }
}

async function toImageContent(
  cached: CachedImage,
): Promise<{ content: ImageContent; note?: string } | { error: string }> {
  const bytes = await readFile(cached.filePath);
  // Animated GIFs must not be re-encoded, so they bypass the resizer and are
  // only size-checked.
  const resized = cached.mimeType === "image/gif"
    ? null
    : await resizeImage(bytes, cached.mimeType, { maxWidth: 2000, maxHeight: 2000 });

  if (resized) {
    return {
      content: { type: "image", mimeType: resized.mimeType, data: resized.data },
      ...(formatDimensionNote(resized) ? { note: formatDimensionNote(resized) } : {}),
    };
  }

  if (bytes.length > MAX_INLINE_BYTES) {
    return { error: `${cached.placeholder} is too large to send inline (${Math.round(bytes.length / 1024)} KB)` };
  }

  return {
    content: { type: "image", mimeType: cached.mimeType, data: bytes.toString("base64") },
  };
}

/**
 * Pre-compute terminal-displayable bytes. The Kitty graphics protocol only
 * accepts PNG, so non-PNG caches are converted once and memoized.
 */
async function prepareDisplayData(cached: CachedImage): Promise<void> {
  const protocol = getCapabilities().images;
  if (!protocol || displayDataByPath.has(cached.filePath)) return;

  try {
    const bytes = await readFile(cached.filePath);
    const base64 = bytes.toString("base64");
    if (protocol === "kitty" && cached.mimeType !== "image/png") {
      const converted = await convertToPng(base64, cached.mimeType);
      if (!converted) return;
      displayDataByPath.set(cached.filePath, converted);
      return;
    }
    displayDataByPath.set(cached.filePath, { data: base64, mimeType: cached.mimeType });
  } catch {
    // Preview is best-effort only.
  }
}

function findPlaceholders(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(PLACEHOLDER_RE)) {
    const placeholder = match[0];
    if (!found.includes(placeholder)) found.push(placeholder);
  }
  return found;
}

export default function (pi: ExtensionAPI) {
  /** Render the cached image inline in the transcript, if the terminal can. */
  const showPreview = async (cached: CachedImage): Promise<void> => {
    if (!getCapabilities().images) return;
    await prepareDisplayData(cached);
    if (!displayDataByPath.has(cached.filePath)) return;
    pi.appendEntry<PreviewEntryData>(ENTRY_TYPE, {
      placeholder: cached.placeholder,
      filePath: cached.filePath,
      mimeType: cached.mimeType,
    });
  };

  pi.registerEntryRenderer<PreviewEntryData>(ENTRY_TYPE, (entry, _options, theme: Theme) => {
    const data = entry.data;
    if (!data) return undefined;

    const label = theme.fg("muted", `${data.placeholder} ${basename(data.filePath)}`);

    let display = displayDataByPath.get(data.filePath);
    if (!display) {
      // Session was resumed in a new process: re-read from disk if still cached.
      try {
        const bytes = readFileSync(data.filePath);
        display = { data: bytes.toString("base64"), mimeType: data.mimeType };
        if (getCapabilities().images === "kitty" && data.mimeType !== "image/png") {
          display = undefined;
        } else {
          displayDataByPath.set(data.filePath, display);
        }
      } catch {
        display = undefined;
      }
    }

    if (!display) {
      return new Text(theme.fg("dim", `${label} (preview unavailable)`), 0, 0);
    }

    const container = new Container();
    container.addChild(new Text(label, 0, 0));
    container.addChild(
      new Image(
        display.data,
        display.mimeType,
        { fallbackColor: (s: string) => theme.fg("muted", s) },
        { maxWidthCells: 60, filename: basename(data.filePath) },
      ),
    );
    return container;
  });

  pi.on("session_start", async (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId?.() ?? `process-${process.pid}`;
    const safeSessionId = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
    cacheDir = join(CACHE_ROOT, safeSessionId);
    manifestPath = join(cacheDir, "manifest.json");
    // The cache directory is created lazily on first paste so sessions that
    // never paste an image leave nothing behind.
    await cleanupOldCaches();
    await loadManifest();
    await touchCacheDir();
    if (imagesByPlaceholder.size > 0) {
      ctx.ui.setStatus(EXTENSION_ID, `images: ${imagesByPlaceholder.size}`);
    }
  });

  pi.on("session_shutdown", async () => {
    // Drop the directory when this session cached nothing, so we do not leave
    // an empty directory per pi run.
    if (imagesByPlaceholder.size === 0) {
      await rm(cacheDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  if (process.platform === "darwin") {
    pi.registerShortcut("ctrl+v", {
      description: "Paste clipboard image as [Image#xxx]",
      handler: async (ctx) => {
        const cached = await readMacClipboardImagesToCache();
        if (cached.length === 0) {
          // Extension shortcuts run before pi's built-in pasteImage handler, so
          // we must reproduce its text fallback ourselves or Ctrl+V would stop
          // pasting text entirely.
          const text = await readMacClipboardText();
          if (text) {
            ctx.ui.pasteToEditor(text);
            return;
          }
          ctx.ui.notify("Clipboard has no image or text to paste", "warning");
          return;
        }

        ctx.ui.pasteToEditor(cached.map((image) => image.placeholder).join(" "));
        ctx.ui.setStatus(EXTENSION_ID, `images: ${imagesByPlaceholder.size}`);
        await touchCacheDir();
        for (const image of cached) {
          if (ctx.mode === "tui") await showPreview(image);
          else ctx.ui.notify(`Cached ${image.placeholder} (${basename(image.filePath)})`, "info");
        }
      },
    });
  }

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") return { action: "continue" };

    let text = event.text;
    const newlyCached: CachedImage[] = [];

    text = await replaceAsync(text, PI_CLIPBOARD_PATH_RE, async (fullMatch, imagePath: string) => {
      const prefix = fullMatch.slice(0, fullMatch.indexOf(imagePath));
      const resolved = isAbsolute(imagePath) ? imagePath : resolve(ctx.cwd, imagePath);
      if (!existsSync(resolved) || !isInsideTmpDir(resolved)) return fullMatch;
      try {
        const cached = await cacheExistingImage(resolved);
        if (!cached) return fullMatch;
        newlyCached.push(cached);
        return `${prefix}${cached.placeholder}`;
      } catch {
        ctx.ui.notify(`Could not cache pasted image path: ${imagePath}`, "warning");
        return fullMatch;
      }
    });

    const placeholders = findPlaceholders(text);
    if (placeholders.length === 0 && newlyCached.length === 0) {
      return { action: "continue" };
    }

    const preexisting = event.images?.length ?? 0;
    const attached: ImageContent[] = [...(event.images ?? [])];
    const notes: string[] = [];

    for (const placeholder of placeholders) {
      const cached = imagesByPlaceholder.get(placeholder);
      if (!cached) {
        ctx.ui.notify(`${placeholder} is not in the temporary image cache`, "warning");
        continue;
      }

      try {
        const result = await toImageContent(cached);
        if ("error" in result) {
          ctx.ui.notify(result.error, "warning");
          continue;
        }
        attached.push(result.content);
        // Tell the model which attachment each placeholder refers to; without
        // this mapping it cannot tell [Image#001] from [Image#002].
        notes.push(
          `${placeholder} = attachment ${attached.length}${result.note ? ` (${result.note})` : ""}`,
        );
      } catch {
        ctx.ui.notify(`Could not attach ${placeholder} from cache`, "warning");
      }
    }

    await touchCacheDir();

    if (attached.length === preexisting) {
      return { action: "transform", text };
    }

    if (notes.length > 0) {
      text += `\n\n<image-cache-notes>\n${notes.join("\n")}\n</image-cache-notes>`;
    }

    ctx.ui.setStatus(EXTENSION_ID, `images: ${imagesByPlaceholder.size}`);
    if (ctx.mode === "tui") {
      for (const cached of newlyCached) await showPreview(cached);
    }
    return { action: "transform", text, images: attached };
  });

  pi.registerCommand("images", {
    description: "List temporarily cached pasted images",
    handler: async (_args, ctx) => {
      if (imagesByPlaceholder.size === 0) {
        ctx.ui.notify("No cached images in this Pi session", "info");
        return;
      }

      const images = [...imagesByPlaceholder.values()];
      if (ctx.mode === "tui" && getCapabilities().images) {
        for (const image of images) await showPreview(image);
        return;
      }

      const lines = images.map((image) => {
        const ageSeconds = Math.max(0, Math.round((Date.now() - image.createdAt) / 1000));
        return `${image.placeholder}  ${image.mimeType}  ${ageSeconds}s old  ${image.filePath}`;
      });
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("image-cache-clear", {
    description: "Clear temporarily cached pasted images",
    handler: async (_args, ctx) => {
      imagesByPlaceholder.clear();
      displayDataByPath.clear();
      // nextImageId is intentionally NOT reset: reusing [Image#001] would
      // collide with placeholders still visible earlier in the transcript.
      await rm(cacheDir, { recursive: true, force: true });
      ctx.ui.setStatus(EXTENSION_ID, undefined);
      ctx.ui.notify("Image cache cleared", "info");
    },
  });
}

async function replaceAsync(
  text: string,
  regex: RegExp,
  replacer: (fullMatch: string, ...groups: string[]) => Promise<string>,
): Promise<string> {
  const matches = [...text.matchAll(regex)];
  if (matches.length === 0) return text;

  let result = "";
  let lastIndex = 0;
  for (const match of matches) {
    const index = match.index ?? 0;
    result += text.slice(lastIndex, index);
    result += await replacer(match[0], ...(match.slice(1) as string[]));
    lastIndex = index + match[0].length;
  }
  result += text.slice(lastIndex);
  return result;
}
