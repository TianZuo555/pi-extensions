/**
 * pi-image-cache — temporary pasted-image cache with compact placeholders.
 *
 * Architecture: manifest, cache files, TTL cleanup, and subprocess clipboard I/O
 * live in an Effect v4 `ImageCacheRuntime` service (see `src/runtime.ts`).
 * Sync entry rendering and display memo stay in this imperative boundary.
 */

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";
import { Container, getCapabilities, Image, Text } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import { existsSync } from "node:fs";
import {
  displayPathFor,
  ENTRY_TYPE,
  EXTENSION_ID,
  isInsideTmpDir,
  PI_CLIPBOARD_PATH_RE,
} from "./lib/helpers.ts";
import { findPlaceholders, formatAttachmentNote, formatImageNotesBlock } from "./lib/prompt.ts";
import type { CachedImage, PreviewEntryData } from "./lib/types.ts";
import {
  createImageCacheRuntime,
  ImageCacheRuntime,
  runImageCache,
  type ImageCacheRuntimeInstance,
  type ImageCacheRuntimeShape,
} from "./src/runtime.ts";

/** Terminal-displayable bytes keyed by the file they were read from (LRU, capped at 50 entries). */
const MAX_DISPLAY_CACHE_ENTRIES = 50;
const displayDataByPath = new Map<string, { data: string; mimeType: string }>();

function setDisplayData(path: string, display: { data: string; mimeType: string }): void {
  // Re-insert so repeated hits refresh recency; eviction below is true LRU.
  displayDataByPath.delete(path);
  if (displayDataByPath.size >= MAX_DISPLAY_CACHE_ENTRIES) {
    const oldest = displayDataByPath.keys().next().value;
    if (oldest !== undefined) displayDataByPath.delete(oldest);
  }
  displayDataByPath.set(path, display);
}

function loadDisplayData(entry: PreviewEntryData): { data: string; mimeType: string } | undefined {
  const protocol = getCapabilities().images;
  if (!protocol) return undefined;

  const needsPng = protocol === "kitty" && entry.mimeType !== "image/png";
  const path = needsPng ? displayPathFor(entry.filePath) : entry.filePath;

  const memo = displayDataByPath.get(path);
  if (memo) return memo;

  try {
    const display = {
      data: readFileSync(path).toString("base64"),
      mimeType: needsPng ? "image/png" : entry.mimeType,
    };
    setDisplayData(path, display);
    return display;
  } catch {
    return undefined;
  }
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

export default function (pi: ExtensionAPI) {
  let cacheRuntime: ImageCacheRuntimeInstance | undefined;
  let cacheService: ImageCacheRuntimeShape | undefined;
  let closing: Promise<void> | undefined;

  const service = (): ImageCacheRuntimeShape => {
    if (!cacheService) throw new Error("Image cache runtime is not initialized.");
    return cacheService;
  };

  const run = <A, E>(effect: import("effect").Effect.Effect<A, E>, signal?: AbortSignal) => {
    if (!cacheRuntime) throw new Error("Image cache runtime is not initialized.");
    return runImageCache(cacheRuntime, effect, signal ? { signal } : {});
  };

  const showPreview = (cached: CachedImage): void => {
    const data = service().previewData(cached);
    if (!loadDisplayData(data)) return;
    pi.appendEntry<PreviewEntryData>(ENTRY_TYPE, data);
  };

  pi.registerEntryRenderer<PreviewEntryData>(ENTRY_TYPE, (entry, _options, theme: Theme) => {
    const data = entry.data;
    if (!data) return undefined;

    const label = theme.fg("muted", `${data.placeholder} ${basename(data.filePath)}`);
    const display = loadDisplayData(data);

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
    displayDataByPath.clear();
    if (cacheRuntime) {
      try {
        if (cacheService) await run(cacheService.close);
      } catch {
        // Ignore errors during previous runtime close
      } finally {
        await cacheRuntime.dispose().catch(() => {});
        cacheRuntime = undefined;
        cacheService = undefined;
      }
    }

    cacheRuntime = createImageCacheRuntime();
    cacheService = cacheRuntime.runSync(ImageCacheRuntime);
    const sessionId = ctx.sessionManager.getSessionId?.() ?? `process-${process.pid}`;
    await run(service().init(sessionId));
    const count = await run(service().imageCount);
    if (count > 0) {
      ctx.ui.setStatus(EXTENSION_ID, `images: ${count}`);
    }
  });

  pi.on("session_shutdown", async () => {
    displayDataByPath.clear();
    if (!cacheRuntime || !cacheService) return;
    if (closing) {
      await closing.catch(() => {});
      return;
    }
    closing = (async () => {
      try {
        await run(cacheService.close);
      } finally {
        await cacheRuntime?.dispose();
        cacheRuntime = undefined;
        cacheService = undefined;
        closing = undefined;
      }
    })();
    await closing;
  });

  if (process.platform === "darwin") {
    pi.registerShortcut("ctrl+v", {
      description: "Paste clipboard image as [Image#xxx]",
      handler: async (ctx) => {
        const { images, unreadable } = await run(service().readMacClipboardImages);
        if (images.length === 0) {
          if (unreadable.length > 0) {
            ctx.ui.notify(
              `Could not read copied file${unreadable.length > 1 ? "s" : ""}: ${unreadable
                .map((path) => basename(path))
                .join(", ")} (check the terminal's Files and Folders permission)`,
              "warning",
            );
            return;
          }
          const text = await run(service().readMacClipboardText);
          if (text) {
            ctx.ui.pasteToEditor(text);
            return;
          }
          ctx.ui.notify("Clipboard has no image or text to paste", "warning");
          return;
        }

        ctx.ui.pasteToEditor(images.map((image) => image.placeholder).join(" "));
        const count = await run(service().imageCount);
        ctx.ui.setStatus(EXTENSION_ID, `images: ${count}`);
        await run(service().touchCacheDir);
        for (const image of images) {
          if (ctx.mode === "tui") showPreview(image);
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
        const cached = await run(service().cacheExistingImage(resolved));
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
      const cached = await run(service().getImage(placeholder));
      if (!cached) {
        ctx.ui.notify(`${placeholder} is not in the temporary image cache`, "warning");
        continue;
      }

      try {
        const result = await run(service().toImageContent(cached));
        if ("error" in result) {
          ctx.ui.notify(result.error, "warning");
          continue;
        }
        attached.push(result.content);
        notes.push(formatAttachmentNote(placeholder, attached.length, result.note));
      } catch {
        ctx.ui.notify(`Could not attach ${placeholder} from cache`, "warning");
      }
    }

    await run(service().touchCacheDir);

    if (attached.length === preexisting) {
      return { action: "transform", text };
    }

    if (notes.length > 0) {
      text += formatImageNotesBlock(notes);
    }

    const count = await run(service().imageCount);
    ctx.ui.setStatus(EXTENSION_ID, `images: ${count}`);
    if (ctx.mode === "tui") {
      for (const cached of newlyCached) showPreview(cached);
    }
    return { action: "transform", text, images: attached };
  });

  pi.registerCommand("images", {
    description: "List temporarily cached pasted images",
    handler: async (_args, ctx) => {
      const images = await run(service().listImages);
      if (images.length === 0) {
        ctx.ui.notify("No cached images in this Pi session", "info");
        return;
      }

      if (ctx.mode === "tui" && getCapabilities().images) {
        for (const image of images) showPreview(image);
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
      displayDataByPath.clear();
      await run(service().clear);
      ctx.ui.setStatus(EXTENSION_ID, undefined);
      ctx.ui.notify("Image cache cleared", "info");
    },
  });
}
