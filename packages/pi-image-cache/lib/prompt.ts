/**
 * Model-facing prompt strings, tags, and placeholder patterns for pi-image-cache.
 */

export const PLACEHOLDER_RE = /\[Image#(\d{3,})\]/g;

export function formatPlaceholder(id: number): string {
  return `[Image#${String(id).padStart(3, "0")}]`;
}

export function findPlaceholders(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(PLACEHOLDER_RE)) {
    const placeholder = match[0];
    if (!found.includes(placeholder)) found.push(placeholder);
  }
  return found;
}

export function formatAttachmentNote(
  placeholder: string,
  attachmentIndex: number,
  dimensionNote?: string,
): string {
  return `${placeholder} = attachment ${attachmentIndex}${dimensionNote ? ` (${dimensionNote})` : ""}`;
}

export function formatImageNotesBlock(notes: string[]): string {
  if (notes.length === 0) return "";
  return `\n\n<image-cache-notes>\n${notes.join("\n")}\n</image-cache-notes>`;
}
