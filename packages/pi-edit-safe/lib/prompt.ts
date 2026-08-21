/**
 * Model-facing prompt strings and parameter descriptions for the strict `edit` tool.
 */

export const EDIT_TOOL_DESCRIPTION =
	"Replace exact text in a file with ordered, verbatim replacements.";

export const EDIT_PROMPT_SNIPPET =
	"Make precise file edits with exact text replacement, including multiple ordered edits in one call";

export const EDIT_PROMPT_GUIDELINES = [
	"edit takes only the `edits` array schema; use a one-element array for a single change.",
	"Change several locations in one file with one edit call, not several calls.",
	"Keep each oldText minimal but unique; add surrounding lines only to disambiguate.",
	"On an edit failure, re-read the file before retrying — the error usually means your context was stale or the match was ambiguous.",
];

export const EDIT_PARAMETER_DESCRIPTIONS = {
	path: "Path to the file to edit (relative or absolute).",
	edits:
		"One or more replacements, applied in order, first to last; use a single-element array for a single change. Each oldText is matched against the file as already changed by the previous edits in this call and must occur exactly once at that point.",
	oldText: "Exact text to find — the smallest snippet that is still unique; do not pad with large unchanged regions.",
	newText: "Replacement text, spliced in verbatim.",
};
