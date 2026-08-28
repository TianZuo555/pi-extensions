import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { extname, isAbsolute, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import type { CachedImage } from "./types.ts";

export const EXTENSION_ID = "image-cache";
export const ENTRY_TYPE = "image-cache-preview";
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const PLACEHOLDER_RE = /\[Image#(\d{3,})\]/g;

/** Inline images larger than this are dropped rather than sent to the provider. */
export const MAX_INLINE_BYTES = 4.5 * 1024 * 1024;

/** Upper bound for a source file we are willing to read into memory. */
export const MAX_SOURCE_BYTES = 64 * 1024 * 1024;

export const MIME_BY_EXT: Record<string, string> = {
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

export const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/tiff": "tiff",
  "image/heic": "heic",
  "image/heif": "heif",
};

export const MODEL_SUPPORTED_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/**
 * Matches any absolute-looking path to a `pi-clipboard-*` temp file that pi
 * inserts into the editor on its own Ctrl+V.
 */
export const PI_CLIPBOARD_PATH_RE =
  /(?:^|[\s"'`(<])((?:[A-Za-z]:)?[\\/][^\s"'`<>)]*pi-clipboard-[A-Za-z0-9-]+\.(?:png|jpe?g|gif|webp|tiff?|heic|heif))(?=$|[\s"'`)>.,;:!?])/gi;

export function formatPlaceholder(id: number): string {
  return `[Image#${String(id).padStart(3, "0")}]`;
}

/** `[Image#001]` -> `Image-001`, safe for use as a filename on every platform. */
export function fileStem(placeholder: string): string {
  return placeholder.slice(1, -1).replace("#", "-");
}

export function normalizeMimeType(mimeType: string): string {
  return mimeType.split(";")[0]?.trim().toLowerCase() || mimeType.toLowerCase();
}

export function detectMimeType(filePath: string, bytes: Buffer): string | undefined {
  if (bytes.length >= 12) {
    if (
      bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    ) {
      return "image/png";
    }
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
      return "image/jpeg";
    }
    const head6 = bytes.subarray(0, 6).toString("ascii");
    if (head6 === "GIF87a" || head6 === "GIF89a") {
      return "image/gif";
    }
    if (
      bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
      bytes.subarray(8, 12).toString("ascii") === "WEBP"
    ) {
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

export function imageExtension(mimeType: string): string {
  return EXT_BY_MIME[normalizeMimeType(mimeType)] ?? "png";
}

/** PNG rendition used for terminal preview, derived from the cache file. */
export function displayPathFor(filePath: string): string {
  return `${filePath.slice(0, -extname(filePath).length)}.display.png`;
}

export function hashBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function findByHash(images: Iterable<CachedImage>, hash: string): CachedImage | undefined {
  for (const image of images) {
    if (image.sourceHash === hash) return image;
  }
  return undefined;
}

export function isInsideTmpDir(candidate: string): boolean {
  try {
    const root = realpathSync(tmpdir());
    const resolved = realpathSync(candidate);
    return isPathWithin(root, resolved);
  } catch {
    return false;
  }
}

export function isPathWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export function findPlaceholders(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(PLACEHOLDER_RE)) {
    const placeholder = match[0];
    if (!found.includes(placeholder)) found.push(placeholder);
  }
  return found;
}

export function previewEntryData(cached: CachedImage) {
  return {
    placeholder: cached.placeholder,
    filePath: cached.filePath,
    mimeType: cached.mimeType,
  };
}

export function fileExists(path: string): boolean {
  return existsSync(path);
}
