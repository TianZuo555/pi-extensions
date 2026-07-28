// edit-replace.ts — strict, fault-tolerant multi-edit string replacement.
//
// Algorithmic concepts (line-trimmed / whitespace-normalized / escape-normalized
// fuzzy strategies, isDisproportionate heuristic) adapted from opencode's MIT
// edit.ts, which traces to cline (MIT) and gemini-cli (Apache-2.0). The unicode
// punctuation mapping mirrors pi's own fuzzy normalizer (MIT), applied here
// span-only. Re-implemented from scratch. See NOTICES.md.
//
// DESIGN PHILOSOPHY (reproduced independently from the maka-agent project, which
// is unlicensed and was NOT used as a code source):
//   1. Exact match first, no gating. Large files edit fine with an exact snippet.
//   2. Fuzzy matching is gated (min length, binary, size) and ONLY locates a span;
//      the replacement is written VERBATIM. Fuzzy never re-indents or rewrites.
//   3. Every fuzzy candidate must be a FULL-span structural match, must be the
//      single candidate, and must occur exactly once. Any ambiguity THROWS rather
//      than falling through to a looser strategy. "Better to fail loudly than to
//      silently edit the wrong place."
//   4. No partial-signal strategies (no first/last-line anchoring, no similarity
//      thresholds). Those are the documented cause of wrong-location edits in
//      upstream projects.
//   5. Line endings are handled at the span boundary, never whole-file: a fuzzy
//      span never captures the trailing \r of a CRLF pair, newText is converted
//      only when the file's endings are uniform, and untouched terminators are
//      never rewritten (mixed files stay mixed).
//   6. Multi-edit calls apply SEQUENTIALLY, in order — each oldText is matched
//      against the result of the previous edits, the contract models assume
//      from multi-edit tools elsewhere (pi's built-in instead matches all edits
//      against the original file). Disjoint edits behave identically under both;
//      dependent edits work here, duplicates are rejected loudly, and failures
//      caused by an earlier edit in the same call say so.

export type MatchStrategy = "exact" | "line-trimmed" | "unicode" | "whitespace" | "escape";

export interface EditRequest {
	oldText: string;
	newText: string;
}

export interface EditOutcome {
	/** Which strategy located oldText. */
	matchedVia: MatchStrategy;
	/** 1-based first line of the matched span, in the content the edit was
	 * applied to (the original file for edit 1; for later edits, the text as
	 * already changed by the previous edits in the call). */
	startLine: number;
	/** 1-based last line (inclusive) of the matched span, same reference. */
	endLine: number;
}

/** Machine-readable failure codes for every error this module throws. */
export type EditErrorCode =
	| "no-edits"
	| "invalid-edit"
	| "duplicate-edit"
	| "empty-old-text"
	| "no-op-edit"
	| "too-short"
	| "binary"
	| "too-large"
	| "not-unique"
	| "ambiguous"
	| "disproportionate"
	| "not-found"
	| "no-changes";

/** Every failure this module throws, tagged with a machine-readable code.
 *
 * `code` is assigned in the constructor body rather than declared as a
 * TypeScript parameter property: parameter properties emit real code, so they
 * are rejected by Node's type-stripping loader (and every other strip-only
 * transform). This package ships uncompiled TypeScript, so it must stay within
 * erasable-syntax-only constructs. */
export class EditError extends Error {
	readonly code: EditErrorCode;

	constructor(message: string, code: EditErrorCode) {
		super(message);
		this.name = "EditError";
		this.code = code;
	}
}

export interface ApplyResult {
	content: string;
	edits: EditOutcome[];
}

// Fuzzy is O(n) per pass over the whole source; gate it to text-sized inputs.
const MIN_FUZZY_OLD_TEXT_LENGTH = 5;
const MAX_FUZZY_SOURCE_CHARS = 1_000_000;
const MAX_FUZZY_SOURCE_LINES = 50_000;

/**
 * Apply one or more edits to `source`, SEQUENTIALLY: each edit's `oldText` is
 * matched against the content as already changed by the previous edits in the
 * same call — the contract models assume from multi-edit tools elsewhere.
 * Disjoint edits produce exactly the same bytes as matching everything against
 * the original file; dependent edits (a later oldText targeting an earlier
 * newText's output) work instead of erroring.
 *
 * @throws when any oldText is missing, ambiguous (not unique), empty, identical
 *   to its newText, an exact duplicate of an earlier edit, too short for a safe
 *   fuzzy match, on a binary/too-large file, or when the result is identical to
 *   the source.
 */
export function applyEdits(source: string, edits: EditRequest[], where: string): ApplyResult {
	if (!Array.isArray(edits) || edits.length === 0) {
		throw new EditError(
			`edit: no edits provided for ${where} — pass oldText/newText for a single replacement, or edits: [{oldText, newText}, ...] for several`,
			"no-edits",
		);
	}

	// Validate shape and reject exact duplicates up front. Models sometimes emit
	// the same edit twice; under sequential application a duplicate could even
	// apply twice (when newText still contains oldText), so fail loudly instead.
	const seen = new Set<string>();
	for (let i = 0; i < edits.length; i++) {
		const e = edits[i];
		if (!e || typeof e.oldText !== "string" || typeof e.newText !== "string") {
			throw new EditError(
				`edit ${i + 1}: each edit needs string oldText and newText fields in ${where}`,
				"invalid-edit",
			);
		}
		const key = JSON.stringify([e.oldText, e.newText]);
		if (seen.has(key)) {
			throw new EditError(
				`edit ${i + 1} is an exact duplicate of an earlier edit in ${where}; remove it (each replacement is applied once)`,
				"duplicate-edit",
			);
		}
		seen.add(key);
	}

	let content = source;
	const outcomes: EditOutcome[] = new Array(edits.length);
	for (let i = 0; i < edits.length; i++) {
		const { oldText, newText } = edits[i];
		const editWhere = edits.length === 1 ? where : `${where} (edit ${i + 1} of ${edits.length})`;
		if (oldText === "") {
			throw new EditError(`edit ${i + 1}: oldText must not be empty in ${where}`, "empty-old-text");
		}
		if (oldText === newText) {
			throw new EditError(`edit ${i + 1}: no changes to apply in ${where} (oldText === newText)`, "no-op-edit");
		}

		let span: { start: number; end: number; via: MatchStrategy };
		try {
			span = resolveSpan(content, oldText, editWhere);
		} catch (err) {
			throw withSequentialHint(err, source, oldText, i);
		}

		outcomes[i] = {
			matchedVia: span.via,
			startLine: lineOf(content, span.start),
			endLine: lineOf(content, span.end - 1),
		};
		content = content.slice(0, span.start) + toFileLineEndings(newText, content) + content.slice(span.end);
	}

	// A fuzzy span can equal newText even when oldText !== newText (drifted
	// oldText, file already in the desired state). A silent no-op write would
	// hide the model's stale context — fail loudly instead.
	if (content === source) {
		throw new EditError(
			`edit: no changes were produced in ${where} — the file already matches the requested result; re-read it before retrying`,
			"no-changes",
		);
	}

	return { content, edits: outcomes };
}

/** When a later edit fails because an EARLIER edit in the same call rewrote its
 * target (or introduced new matches), say so — a bare "not found" would send the
 * model re-reading a file that never contained the problem. */
function withSequentialHint(err: unknown, source: string, oldText: string, index: number): unknown {
	if (index === 0 || !(err instanceof EditError)) return err;
	if (err.code === "not-found" && countOccurrences(source, oldText) > 0) {
		return new EditError(
			`${err.message}; note: edits apply in order, and an earlier edit in this call already changed this text — write oldText against the updated content, or merge the edits into one`,
			err.code,
		);
	}
	if ((err.code === "not-unique" || err.code === "ambiguous") && countOccurrences(source, oldText) <= 1) {
		return new EditError(
			`${err.message}; note: edits apply in order, and an earlier edit's newText introduced additional matches — merge or reorder the edits`,
			err.code,
		);
	}
	return err;
}

/** Resolve a single oldText to a unique [start, end) span, exact then guarded fuzzy. */
function resolveSpan(source: string, oldText: string, where: string): { start: number; end: number; via: MatchStrategy } {
	// Exact match first — never gated. Occurrences are counted overlap-aware:
	// "aa" in "aaa" is ambiguous (positions 0 and 1), not a unique match.
	const exactCount = countOccurrences(source, oldText);
	if (exactCount === 1) {
		const idx = source.indexOf(oldText);
		return { start: idx, end: idx + oldText.length, via: "exact" };
	}
	if (exactCount > 1) {
		throw new EditError(`oldText is not unique in ${where} (${exactCount} exact matches); provide more context`, "not-unique");
	}

	// Exact failed → fuzzy. Apply hard gates up front.
	if (oldText.trim().length < MIN_FUZZY_OLD_TEXT_LENGTH) {
		throw new EditError(
			`oldText is too short for a non-exact match in ${where}; provide a longer, exact snippet`,
			"too-short",
		);
	}
	if (source.indexOf("\0") !== -1) {
		throw new EditError(`refusing a non-exact match in ${where}: file looks binary (contains a NUL byte); re-read and pass exact text`, "binary");
	}
	if (source.length > MAX_FUZZY_SOURCE_CHARS || countOccurrences(source, "\n") + 1 > MAX_FUZZY_SOURCE_LINES) {
		throw new EditError(`refusing a non-exact match in ${where}: file is too large to fuzzy-match safely; re-read and pass exact text`, "too-large");
	}

	// Ordered by increasing tolerance. `effectiveFind` is what the strategy
	// semantically matched against, used for the disproportion guard (the escape
	// strategy legitimately expands a 1-line "a\nb\nc" oldText to 3 real lines).
	const strategies: Array<{ via: MatchStrategy; find: (c: string, f: string) => string[]; effectiveFind: string }> = [
		{ via: "line-trimmed", find: lineTrimmedSpans, effectiveFind: oldText },
		{ via: "unicode", find: unicodePunctuationSpans, effectiveFind: oldText },
		{ via: "whitespace", find: whitespaceNormalizedSpans, effectiveFind: oldText },
		{ via: "escape", find: escapeNormalizedSpans, effectiveFind: unescapeText(oldText) },
	];

	for (const { via, find, effectiveFind } of strategies) {
		const candidates = dedupe(find(source, oldText).filter((c) => c.length > 0 && source.includes(c)));
		if (candidates.length === 0) continue; // this strategy found nothing → try the next
		if (candidates.length > 1) {
			throw new EditError(`oldText matched ${candidates.length} different ${via} candidates in ${where}; provide more context to disambiguate`, "ambiguous");
		}
		const span = candidates[0];
		// Must occur exactly once as a string too.
		if (source.indexOf(span) !== source.lastIndexOf(span)) {
			throw new EditError(`oldText matched a ${via} span that occurs more than once in ${where}; provide more context to disambiguate`, "ambiguous");
		}
		if (isDisproportionate(span, effectiveFind)) {
			throw new EditError(`refusing ${via} match in ${where}: the matched span is much larger than oldText; re-read and pass exact text`, "disproportionate");
		}
		const start = source.indexOf(span);
		let end = start + span.length;
		// Strategies split on \n, so in a CRLF file the last matched line carries
		// its \r into the span. That \r belongs to the file's line terminator:
		// leave it in place, or the splice would turn \r\n into a bare \n.
		if (source[end - 1] === "\r" && source[end] === "\n") end -= 1;
		return { start, end, via };
	}

	throw new EditError(`oldText not found in ${where}; it must match the file's text including whitespace and indentation`, "not-found");
}

// --- fuzzy strategies: each returns ORIGINAL substrings (never normalized) ---

/**
 * Shared line-block walker: match `find` against consecutive whole lines of
 * `content` using `sameLine`, returning the ORIGINAL substring for each match.
 * If `find` ends with a newline, the span must include the file's newline after
 * the last matched line (EOF without one is not a faithful match → skip).
 */
function lineBlockSpans(
	content: string,
	find: string,
	sameLine: (fileLine: string, findLine: string) => boolean,
): string[] {
	const out: string[] = [];
	const lines = content.split("\n");
	const findEndsWithNewline = find.endsWith("\n");
	const search = find.split("\n");
	if (search.length > 0 && search[search.length - 1] === "") search.pop();
	if (search.length === 0) return out;

	for (let i = 0; i <= lines.length - search.length; i++) {
		let ok = true;
		for (let j = 0; j < search.length; j++) {
			if (!sameLine(lines[i + j], search[j])) {
				ok = false;
				break;
			}
		}
		if (!ok) continue;

		let start = 0;
		for (let k = 0; k < i; k++) start += lines[k].length + 1;
		let end = start;
		for (let k = 0; k < search.length; k++) {
			end += lines[i + k].length;
			if (k < search.length - 1) end += 1;
		}
		if (findEndsWithNewline) {
			const lastLine = i + search.length - 1;
			if (lastLine >= lines.length - 1) continue;
			end += 1;
		}
		out.push(content.slice(start, end));
	}
	return out;
}

/** Match line-by-line after trimming each line. Handles indentation/trailing-ws drift. */
function lineTrimmedSpans(content: string, find: string): string[] {
	return lineBlockSpans(content, find, (a, b) => a.trim() === b.trim());
}

/**
 * Unicode punctuation mapping (mirrors pi's fuzzy normalizer): smart quotes,
 * unicode dashes, and special spaces collapse to their ASCII equivalents, plus
 * NFKC. Used for COMPARISON only — matched spans keep their original bytes.
 */
function normalizeUnicodePunctuation(text: string): string {
	return text
		.normalize("NFKC")
		// Smart single quotes → '
		.replace(/[\u2018\u2019\u201A\u201B]/g, "'")
		// Smart double quotes → "
		.replace(/[\u201C\u201D\u201E\u201F]/g, '"')
		// Hyphen/dash variants and minus → -
		.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
		// NBSP and other special spaces → regular space
		.replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

/** Match after mapping unicode punctuation to ASCII (per line, trimmed). The
 * drift the model most often gets wrong in prose/markdown: “ ” vs ", — vs -, NBSP. */
function unicodePunctuationSpans(content: string, find: string): string[] {
	return lineBlockSpans(
		content,
		find,
		(a, b) => normalizeUnicodePunctuation(a).trim() === normalizeUnicodePunctuation(b).trim(),
	);
}

/** Match after collapsing all runs of whitespace to a single space. */
function whitespaceNormalizedSpans(content: string, find: string): string[] {
	const out: string[] = [];
	const norm = (t: string) => t.replace(/\s+/g, " ").trim();
	const findEndsWithNewline = find.endsWith("\n");
	const findLines = find.split("\n");
	if (findEndsWithNewline) findLines.pop();
	if (findLines.length === 0) return out;
	const want = norm(findLines.join("\n"));
	if (want === "") return out;
	const lines = content.split("\n");

	// When oldText ends with a newline, the span must include the file's newline
	// after the last matched line — and must NOT absorb a following
	// whitespace-only line (norm() would treat its bytes as invisible).
	const push = (i: number, count: number) => {
		const block = lines.slice(i, i + count).join("\n");
		if (findEndsWithNewline) {
			if (i + count - 1 >= lines.length - 1) return; // EOF: no newline to include
			out.push(block + "\n");
		} else {
			out.push(block);
		}
	};

	if (findLines.length === 1) {
		// Single-line oldText matches whole lines only. A multi-line oldText must
		// never collapse onto one physical line (would be a wrong-location edit).
		for (let i = 0; i < lines.length; i++) {
			if (norm(lines[i]) === want) push(i, 1);
		}
	} else {
		for (let i = 0; i <= lines.length - findLines.length; i++) {
			const block = lines.slice(i, i + findLines.length).join("\n");
			if (norm(block) === want) push(i, findLines.length);
		}
	}
	return out;
}

/** Unescape common escape sequences (\n \t \\ etc.) written literally. */
function unescapeText(str: string): string {
	return str.replace(/\\(n|t|r|'|"|`|\\|\n|\$)/g, (m, ch: string) => {
		switch (ch) {
			case "n": return "\n";
			case "t": return "\t";
			case "r": return "\r";
			case "'": return "'";
			case '"': return '"';
			case "`": return "`";
			case "\\": return "\\";
			case "\n": return "\n";
			case "$": return "$";
			default: return m;
		}
	});
}

/** Match after unescaping common escape sequences in oldText. */
function escapeNormalizedSpans(content: string, find: string): string[] {
	const out: string[] = [];
	const want = unescapeText(find);
	if (content.includes(want)) out.push(want);
	// CRLF variant of the direct match: the unescaped \n may correspond to \r\n
	// in the file. The returned span keeps the file's original bytes.
	if (want.includes("\n") && content.includes("\r\n")) {
		const wantCRLF = want.replace(/\n/g, "\r\n");
		if (wantCRLF !== want && content.includes(wantCRLF)) out.push(wantCRLF);
	}
	const lines = content.split("\n");
	const findLines = want.split("\n");
	for (let i = 0; i <= lines.length - findLines.length; i++) {
		const block = lines.slice(i, i + findLines.length).join("\n");
		// Compare with the block's CRLF pairs normalized (they are file line
		// terminators, not content); the pushed span keeps the original bytes.
		if (unescapeText(block.replace(/\r\n/g, "\n")) === want) out.push(block);
	}
	return out;
}

// --- helpers ---

/** Defense-in-depth guard. The curated strategies above all match a span whose
 * line count equals the effective find's, so this rarely fires today — it exists
 * to reject any future partial-signal strategy (first/last-line anchoring) that
 * could balloon a span, which is the documented cause of wrong-location edits
 * upstream. */
export function isDisproportionate(span: string, find: string): boolean {
	const oldLines = find.split("\n").length;
	const spanLines = span.split("\n").length;
	if (spanLines >= Math.max(oldLines + 3, oldLines * 2)) return true;
	if (oldLines === 1) return false;
	return span.trim().length > Math.max(find.trim().length + 500, find.trim().length * 4);
}

/** Overlap-aware occurrence count: advances one char at a time, so "aa" occurs
 * twice in "aaa". Anything else would silently pick one of two valid positions. */
function countOccurrences(haystack: string, needle: string): number {
	if (needle === "") return 0;
	let count = 0;
	let idx = haystack.indexOf(needle);
	while (idx !== -1) {
		count++;
		idx = haystack.indexOf(needle, idx + 1);
	}
	return count;
}

function dedupe(arr: string[]): string[] {
	return [...new Set(arr)];
}

function lineOf(source: string, index: number): number {
	let line = 1;
	for (let i = 0; i < index && i < source.length; i++) {
		if (source[i] === "\n") line++;
	}
	return line;
}

/**
 * Convert the replacement's line endings to the file's style, but only when the
 * file is uniform: CRLF-only files get newText's LF → CRLF, LF-only files get
 * newText's stray CRLF → LF. Mixed-ending files (and files with no newlines)
 * take newText verbatim — guessing would rewrite bytes the model never asked for.
 */
function toFileLineEndings(text: string, source: string): string {
	const hasCRLF = source.includes("\r\n");
	const hasBareLF = /(?<!\r)\n/.test(source);
	if (hasCRLF && !hasBareLF) {
		return text.replace(/\r?\n/g, "\r\n");
	}
	if (hasBareLF && !hasCRLF) {
		return text.replace(/\r\n/g, "\n");
	}
	return text;
}
