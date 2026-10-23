/**
 * Public entry surface for the diff renderer.
 *
 * Implementation is split across focused modules by concern:
 *   - diff-parse.ts        : diff string → line/meta/hunk/file entries + stats
 *   - diff-inline.ts       : inline token diff (LCS spans) + split-row pairing
 *   - diff-palette.ts      : theme/color/SGR (row backgrounds, inline emphasis)
 *   - diff-highlight.ts    : syntax highlighting (sync + shiki)
 *   - diff-layout.ts       : unified / split / compact layout
 *   - diff-header.ts       : file/hunk headers + stat/summary/frame lines
 *   - diff-limits.ts       : collapse/expand limits + width clamping
 *   - diff-component.ts    : shared component cache / live-config plumbing
 *   - diff-edit-render.ts  : edit diff result rendering + stats
 *   - diff-write-render.ts : write diff result rendering + stats
 *
 * This file re-exports the stable public symbols so external importers
 * (diff/index.ts, compact-mode.ts, tests) keep working unchanged.
 */
export { shouldHighlightCodeBlock } from "./diff-highlight.ts";
export type { DisplayConfigInput } from "./diff-component.ts";
export { isRichDiffComponent } from "./diff-component.ts";
export { countEditDiffStats, renderEditDiffResult } from "./diff-edit-render.ts";
export {
	countWriteDiffStats,
	renderWriteDiffResult,
	writeStatsInCollapsedBody,
} from "./diff-write-render.ts";
