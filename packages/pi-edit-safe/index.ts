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

const parameters = Type.Object({
	path: Type.String({
		description: "Path to the file to edit (relative or absolute).",
	}),
	edits: Type.Array(
		Type.Object({
			oldText: Type.String({
				description:
					"Exact text to find. Must be unique in the file at the time this edit applies.",
			}),
			newText: Type.String({
				description: "Replacement text, written verbatim.",
			}),
		}),
		{
			minItems: 1,
			description:
				"One or more replacements, applied in order, first to last. Use a single-element array for a single change. Each oldText is matched against the file as already changed by the previous edits in this call.",
		},
	),
});

export default function editSafeExtension(pi: ExtensionAPI): void {
	// Kill switch: if set, do not register and let the built-in edit remain active.
	if (process.env.PI_EDIT_SAFE_DISABLE === "1") return;

	pi.registerTool({
		name: "edit", // same name as the built-in → overrides it
		label: "edit (strict)",
		description:
			"Replace text in a file using only the array schema: { path, edits: [{ oldText, newText }, ...] }. The edits field is required and must be a non-empty array, including for a single replacement; top-level oldText/newText fields are not part of the public schema. Edits apply in order, one after another, each matched against the already-updated text. Each oldText must match the file and be unique; small whitespace/indentation, unicode-punctuation, or escape drift is tolerated only when the match is unambiguous. newText is written verbatim. On failure, re-read the file before retrying.",
		promptSnippet:
			"Make precise file edits with exact text replacement, including multiple ordered edits in one call",
		parameters,
		// Fold the looser shapes models emit (alias keys, stringified arrays, a bare
		// edit object, top-level oldText/newText) onto the canonical {path, edits[]}
		// form BEFORE schema validation. The public schema stays strict: `edits` is
		// the only advertised way to call this tool, so the model has one shape to
		// learn and no choice to make. Normalization exists only so a stray legacy
		// shape — including tool calls stored in older resumed sessions — still
		// works instead of hard-failing validation.
		prepareArguments: (args: unknown) => prepareEditArguments(args) as Static<typeof parameters>,
		promptGuidelines: [
			"Prefer `edit` for targeted changes and `write` only for new files or full rewrites.",
			"The edit tool supports only the `edits` array schema; use a one-element array for a single change. Edits apply in order, top to bottom.",
			"Each oldText must be unique in the file; include surrounding lines to disambiguate when needed.",
			"On an edit failure, re-read the file before retrying — the error usually means your context was stale or the match was ambiguous.",
		],
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
