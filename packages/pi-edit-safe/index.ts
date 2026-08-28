// pi extension: override the built-in `edit` tool with a stricter, full-span
// matcher. The model-facing contract is ONE call shape — {path, edits: [...]},
// always an array, even for a single replacement — so there is no per-call
// choice to get wrong. Multi-edit applies IN ORDER (sequential), the contract
// models assume from multi-edit tools elsewhere.
//
// Looser shapes models emit anyway (top-level oldText/newText, alias field
// names, stringified arrays, a bare edit object) are folded onto the canonical
// form by prepareArguments BEFORE validation. They are accepted for robustness
// and older resumed sessions, but deliberately NOT advertised in the schema.
//
// Quick try:   pi -e ./packages/pi-edit-safe
// Disable:     PI_EDIT_SAFE_DISABLE=1 pi   (falls back to the built-in edit)
//
// Result shape note: pi resolves built-in renderer inheritance per slot
// (`toolDefinition.renderCall ?? builtInToolDefinition.renderCall`), so this
// override deliberately defines NEITHER renderCall nor renderResult and instead
// returns the built-in `EditToolDetails` shape ({ diff, patch, firstChangedLine }).
// That inherits pi's streaming diff preview and final diff rendering for free.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  generateDiffString,
  generateUnifiedPatch,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { applyEdits } from "./lib/edit-replace.ts";
import { prepareEditArguments } from "./lib/prepare-arguments.ts";
import {
  EDIT_PARAMETER_DESCRIPTIONS,
  EDIT_PROMPT_GUIDELINES,
  EDIT_PROMPT_SNIPPET,
  EDIT_TOOL_DESCRIPTION,
} from "./lib/prompt.ts";

const parameters = Type.Object({
  path: Type.String({
    description: EDIT_PARAMETER_DESCRIPTIONS.path,
  }),
  edits: Type.Array(
    Type.Object({
      oldText: Type.String({
        description: EDIT_PARAMETER_DESCRIPTIONS.oldText,
      }),
      newText: Type.String({
        description: EDIT_PARAMETER_DESCRIPTIONS.newText,
      }),
    }),
    {
      minItems: 1,
      description: EDIT_PARAMETER_DESCRIPTIONS.edits,
    },
  ),
});

export default function editSafeExtension(pi: ExtensionAPI): void {
  // Kill switch: if set, do not register and let the built-in edit remain active.
  if (process.env.PI_EDIT_SAFE_DISABLE === "1") return;

  pi.registerTool({
    name: "edit", // same name as the built-in → overrides it
    label: "edit (strict)",
    description: EDIT_TOOL_DESCRIPTION,
    promptSnippet: EDIT_PROMPT_SNIPPET,
    parameters,
    prepareArguments: (args: unknown) => prepareEditArguments(args) as Static<typeof parameters>,
    promptGuidelines: EDIT_PROMPT_GUIDELINES,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      // Re-normalize defensively: the prepareArguments hook already ran on
      // current pi versions, and normalization is idempotent.
      const { path, edits } = prepareEditArguments(params);
      if (!path) {
        throw new Error(`edit: missing "path" — pass the file to edit`);
      }
      const abs = resolve(ctx.cwd, path);

      // Read, match, and write all inside the mutation queue so no other
      // pi-side mutation can interleave between our read and our write.
      return withFileMutationQueue(abs, async () => {
        const throwIfAborted = () => {
          if (signal?.aborted) throw new Error("Operation aborted");
        };
        throwIfAborted();

        let source: string;
        try {
          source = await readFile(abs, "utf-8");
        } catch (err) {
          throw new Error(
            `edit: cannot read "${path}" (${(err as NodeJS.ErrnoException).message}). Use the write tool to create a new file.`,
          );
        }
        throwIfAborted();

        const { content, edits: outcomes } = applyEdits(source, edits, path);
        await writeFile(abs, content, "utf-8");

        const summary = outcomes
          .map((o, i) => `  ${i + 1}. ${o.matchedVia} match → lines ${o.startLine}-${o.endLine}`)
          .join("\n");

        // Diff against the real bytes on both sides. This matcher never
        // normalizes the file, so `source` IS the base content — unlike
        // pi's built-in, which diffs its LF-normalized view.
        const { diff, firstChangedLine } = generateDiffString(source, content);
        const patch = generateUnifiedPatch(path, source, content);

        return {
          content: [
            {
              type: "text",
              text: `Edited ${path} (${outcomes.length} replacement${outcomes.length > 1 ? "s, applied in order" : ""}):\n${summary}`,
            },
          ],
          // Built-in EditToolDetails shape (diff/patch/firstChangedLine) so
          // pi's inherited renderer and SDK/ACP consumers keep working;
          // `edits` carries the extra strict-matcher provenance.
          details: { path: abs, diff, patch, firstChangedLine, edits: outcomes },
        };
      });
    },
  });
}
