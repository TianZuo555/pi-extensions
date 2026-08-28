// Input-shape normalizer: maps the call shapes models actually emit onto the
// canonical {path, edits[]} form BEFORE schema validation. Weaker models
// pattern-match field names and shapes from other tools they saw in training
// (Claude Code's old_string/new_string + file_path, opencode's
// oldString/newString), send `edits` as a JSON string, send a single object
// instead of an array, or skip the array entirely and pass top-level
// oldText/newText. All of those are unambiguous — accept them.
//
// This function never throws: anything unrecognized passes through so schema
// validation / applyEdits can report a precise error.

import type { EditRequest } from "./edit-replace.ts";

const PATH_KEYS = ["path", "file_path", "filePath", "filename"];
const OLD_KEYS = ["oldText", "old_text", "oldString", "old_string", "old_str"];
const NEW_KEYS = ["newText", "new_text", "newString", "new_string", "new_str"];

function firstString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

/** Map one edit-like object to {oldText, newText}, or undefined if it has no
 * recognizable old/new pair. */
function toEditEntry(value: unknown): EditRequest | undefined {
  if (!value || typeof value !== "object") return undefined;
  const obj = value as Record<string, unknown>;
  const oldText = firstString(obj, OLD_KEYS);
  const newText = firstString(obj, NEW_KEYS);
  if (oldText === undefined || newText === undefined) return undefined;
  return { oldText, newText };
}

export interface PreparedEditArguments {
  path?: string;
  edits: EditRequest[];
}

/** Normalize raw tool-call arguments to {path, edits[]}. Idempotent: canonical
 * input maps to itself, so it is safe to run both as the prepareArguments hook
 * and again defensively inside execute(). */
export function prepareEditArguments(raw: unknown): PreparedEditArguments {
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const path = firstString(obj, PATH_KEYS);

  // Some models send edits as a JSON string instead of an array (pi's own
  // built-in works around the same behavior).
  let rawEdits = obj.edits;
  if (typeof rawEdits === "string") {
    try {
      rawEdits = JSON.parse(rawEdits);
    } catch {
      rawEdits = undefined;
    }
  }
  // A single {oldText, newText} object instead of a one-element array.
  if (rawEdits && typeof rawEdits === "object" && !Array.isArray(rawEdits)) {
    rawEdits = [rawEdits];
  }

  const edits: EditRequest[] = [];
  if (Array.isArray(rawEdits)) {
    for (const entry of rawEdits) {
      // Keep unmappable entries as-is so applyEdits rejects them with a
      // precise "edit N needs string oldText/newText" error.
      edits.push(toEditEntry(entry) ?? (entry as EditRequest));
    }
  }

  // Top-level oldText/newText shorthand (with or without an edits array).
  const top = toEditEntry(obj);
  if (top) edits.push(top);

  return { path, edits };
}
