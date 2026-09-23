# pi-find grep/find — search tooling decision

**Status:** implemented on `feat/pi-find-search-modes`; tests and `tsc --noEmit` green. Two open questions (A, B under "Under observation") wait on debug-log data.
**Package:** `@tian.zuo/pi-find` (`packages/pi-find`)

## Context

pi registers `grep` and `find` under the built-in tool names, replacing the built-ins. Execution delegates to `rg` and `fd` child processes; the extension layer only owns the schema, stream decoding, bounding, and rendering. The design goal is not a smaller shell — it is output a model can act on directly: bounded in process cost and bytes, and honest about incompleteness.

## Core choices (locked)

| Topic | Decision | Rationale |
|---|---|---|
| Surface | `grep(pattern, path?, glob?, output?, literal?)`, `find(pattern, path?)` | A small schema cannot be misused; several roots, counts, sorting, and pipelines go to the shell |
| Overflow detection | Check the cap *before* adding; the (N+1)th record's arrival is the overflow signal | Distinguishes an exact fit (complete) from a truncated set with certainty, for one record's cost |
| Context | Enrichment only; never crowds out matches | Two-level defense: runtime judges trustworthiness, render judges fit |
| Context control | **No parameter** — ±5 lines kept only when the search is complete and sparse (1–3 matches) | A lone hit is usually the answer; a 100-hit list is not improved by context. The model cannot know the match count before searching, so the decision belongs after the search, not in the schema. Wider windows belong to `read` |
| Partial labeling | `partial` covers truncation, timeout, skipped records, omitted context; counts are displayed-only | The true total is unknowable once rg is killed at the cap; only displayed counts are honest |
| Slash globs | Relative to the search root only | Dual-base (root or cwd) matching let one glob silently select from two directory trees |
| Sorting | Sort the collected batch, not the search space | A global sort would require enumerating past the cap |
| Filenames | NUL-delimited streams (`rg -l --null`, `fd --print0`); control characters JSON-quoted with a notice | Newlines and quotes in filenames are data, not delimiters |

## Decision details

### 1. Exact-limit vs overflow via one extra record

With cap N, "returned N rows" is ambiguous: the result set may be exactly N (complete) or larger (truncated). The collector checks `size >= LIMIT` **before** adding, so the (N+1)th record returns `false`, `streamLines` sets `stoppedEarly`, and the child is killed. If exactly N records exist, the (N+1)th never arrives, the stream ends naturally, and `truncated` stays `false`. The contract is "up to N results plus a definitive flag", never a total count — the remaining tail (1 or 1000 records) is irrelevant to the model's next action, which is always "narrow the search".

`stoppedEarly` doubles as the truncation signal, so no separate overflow flag exists on the grep path. Notices convert the flag into an instruction the model can act on (`[Result limit reached at 100 matches; narrow pattern, path, or glob.]`); `details` feeds the TUI only.

### 2. Context never crowds out matches

Context is bulk; matches are the point. Two levels defend that priority because neither layer alone has enough information:

- **Runtime — is this context worth keeping?** rg always runs with `--context 5` in content mode; the collector speculatively buffers context rows in the same pass, clears the buffer the moment a 4th match arrives, and stops collecting once any record was dropped. `finalizeGrep` retains context only for complete sparse searches and filters orphan windows — context belonging to a match that fell past the cap.
- **Render — does it fit?** `boundedBody` renders rows with context; if the byte budget overflows and context was present, it re-renders match rows only. Context is always the automatic enrichment, so dropping it is silent — a freebie the model never asked for. (In practice a ≤3-match window cannot exceed the budget; the retry is a cheap guard against future constant changes.)

The runtime cannot know rendered size (clipping, grouping headings, separators all affect bytes); the renderer cannot know a context window is orphaned. Merging the checks would misjudge both.

### 3. Match-aware, surrogate-safe clipping

**Problem.** The previous `clipLine` kept only the first 400 units of a long line (`text.slice(0, 400)` + `… (N chars)`). On minified bundles, generated files, or long CJK lines, a match at offset 5000 produced an excerpt that *does not contain the pattern* — worse than "the model can't tell where the cut happened", the hit's content was simply invisible, forcing a `read` round-trip that context lines exist to avoid.

**Offsets: UTF-8 bytes → UTF-16 indices.** rg's `submatches` report `{start, end}` as byte offsets into the raw line; JS strings index UTF-16 units. `decodeRgEvent` converts by decoding the raw byte prefix — `bytes.subarray(0, start).toString("utf8").length` is the UTF-16 index. Using the same lossy decoder that produced `text` means offsets can never diverge from the displayed text. Details that keep the conversion honest:

- For `lines.bytes` payloads (invalid UTF-8 in the line) the raw bytes come from base64; for `lines.text`, re-encoding is exact because rg only emits `text` for valid UTF-8.
- `\r` is stripped from the decoded prefix exactly as it is from `text` (Windows `CRLF` lines), so offsets do not drift.
- Only `submatches[0]` is used — one anchor suffices for window placement.
- Malformed offsets (`end > bytes.length`, non-integer) drop the anchor entirely → head clipping, the previous behavior. Every layer has a benign fallback.

**Window math.** `padding = (400 − min(matchLen, 400)) / 2` centers the match; `start` clamps to `0` near the head and to `len − 400` near the tail so the window is always full-width and in-bounds. A match longer than 400 units clamps the padding to 0 and shows the match head. Defaulted parameters (`matchStart = 0`) make context lines keep the old head-clip behavior — one function, two semantics.

**Surrogate safety.** Only a *low* surrogate (`DC00–DFFF`) at a boundary can split a pair: at `start` it means the high half was already excluded → `start += 1`; at `end` it means the high half at `end−1` would be included → `end −= 1`. A high surrogate at `start` needs no fix (its pair is inside the window). Lone surrogates in tool output break rendering and JSON serialization, so the tests assert `isWellFormed()`.

**Precision philosophy.** If a byte offset lands mid-sequence, lossy decoding reads it as U+FFFD and an astral char may shift the index by one. That is accepted: the offsets steer a display window, not a highlighter — a one-unit drift is a ±0.5-char centering error.

**Markers.** `… ` prefix signals content was cut before, `…` + ` (N chars)` suffix signals content cut after plus the true line length — the model sees it is looking at a middle window, not the whole line. What is no longer reported is the match's absolute offset in the line, which has no decision value for "should I `read` this file".

### 4. Single-base slash globs (breaking change)

Slash-containing globs resolve **only** against the search root — the `path` directory, or the parent of an explicit grep file. Previously they were tried against both the root and the cwd, so `{ path: "src", glob: "src/*.ts" }` matched `src/main.ts` via cwd while `{ path: "src", glob: "deep/*.ts" }` matched `src/deep/x.ts` via root — one parameter, two trees, silently mixed. A single base makes results predictable and descriptions truthful ("relative to the search root").

The cost: the common model habit of redundantly prefixing the path (`path: "src"` + `glob: "src/*.ts"`) now returns empty instead of working. Decision 6 mitigates this with a hint that names the corrected glob.

### 5. Unreadable paths make a result partial, never failed or complete

A walk that meets a directory it cannot read (permission denied, a file vanishing mid-walk) still searches every readable path. The two binaries misreport this in opposite directions: rg exits 2, which used to fail the whole grep and discard every gathered match, while fd hides the error by default and exits 0, so find looked complete. Both now report the same state: `partial`, plus `[Some paths could not be read (…); results may be incomplete.]` with the first message.

- fd runs with `--show-errors` so the skip is visible on stderr.
- A run counts as partial only when **every** stderr line is a per-path OS failure (ends in `(os error N)`); a line cut by the 4 KiB stderr cap is ignored. Anything else (regex or glob syntax) is still an error, so the rule cannot hide real failures.
- Automatic context stays available: an unreadable file does not make the matches that were read any less trustworthy.

### 6. Empty-result hints only where they apply

Every hint on an empty result costs tokens and, when irrelevant, points the model at the wrong cause.

- The slash-glob hint fires only when the glob actually rejected candidates (`rejectedByGlob > 0`) under an explicit path other than `.`. When the glob repeats that path (`path: "src"`, `glob: "src/**/*.ts"`) it names the fix: `[Glob "src/**/*.ts" is relative to path "src"; try "**/*.ts".]`. This keeps the single base (no silent dual matching) while making the most common mistake a one-step correction.
- The hidden-path hint is omitted when the path itself is hidden, and both traversal hints are omitted for an explicitly named file, where traversal rules never applied.
- Case sensitivity, the likeliest cause of a surprising miss, is taught in the schema instead of in every empty result: `pattern` says `prefix (?i) to ignore case`.

## Under observation

The opt-in debug log (`PI_FIND_DEBUG=1`, see the package README) records what is needed to decide the two open questions below; `pnpm --filter @tian.zuo/pi-find debug-stats` prints them as sections `[A]` and `[B]`. Neither change is made until the log shows the problem is real.

### A. Narrow the walk to a glob's fixed directory prefix

**Problem.** The rg/fd prefilter only uses the glob's basename, so `find("packages/web/**/*.tsx")` makes fd enumerate every `.tsx` in the repository before Minimatch keeps those under `packages/web`. Results are correct; the cost is time, and timeouts on large trees. A related UX gap: `.github/**/*.yml` returns empty because hidden directories are only walked when named as `path`.

**Candidate change.** When a non-negated glob has a fixed directory prefix that exists under the root, pass it to rg/fd as the search path and match the rest of the glob relative to it. Naming a hidden prefix in the glob would then count as naming the hidden path, which revises the current "a glob alone does not enable hidden traversal" rule.

**Signals** (per tool, ok outcomes, prefix detection by `staticGlobPrefix` in the stats script):

| Question | Measure |
|---|---|
| How common are such globs? | share of searches with a fixed prefix |
| Do they cost more? | their `durationMs` p50/p95/max vs every other search; timeouts among them |
| How much of the walk is wasted? | `rejectedByGlob` spread (fd: paths enumerated past the prefilter then discarded; grep: matching lines in files outside the prefix) |
| How many files did grep read? | `searchedFiles` from rg's summary, fixed-prefix vs other searches |
| Does the hidden-prefix gap bite? | empty results whose prefix is hidden and whose `path` is not; next action afterwards |

**Decide for the change** if fixed-prefix searches are a real share of calls and their p95 duration is well above the baseline (or they account for timeouts), or if hidden-prefix empties recur and are followed by a retry or shell search.

**Known blind spots.** rg's summary only exists for content searches that ran to completion, so truncated or files-mode greps carry no `searchedFiles`; for grep, `rejectedByGlob` counts matching lines, not files scanned, so duration is the primary signal there. fd reports no scan totals at all; `rejectedByGlob` is its proxy.

### B. Output budget vs saving context

**Problem.** One call may return up to ~42 KiB (100 lines of up to 400 units each), roughly 10k tokens. That conflicts with the package's "minimal context" goal unless large results are actually used.

**Candidate changes.** Lower the byte budget, or clip dense results (more than a few matches) to a shorter line width while keeping 400 for sparse ones.

**Signals:**

| Question | Measure |
|---|---|
| How big are results in practice? | `outputBytes` p50/p95/max (the full text returned, header and notices included) |
| How often is a call expensive? | calls at or above 16 KiB; `outputLimitHit` count |
| Is line width the driver? | grep calls with `clippedLines > 0` |
| Are large results used? | next action after a large result: `read` suggests it was useful; a narrowing retry or shell search suggests the bulk was wasted |

**Decide for the change** if large results are common and mostly followed by a narrowing retry rather than a `read`, or if clipped lines are frequent in dense results.

**Known blind spots.** `outputBytes` is bytes, not tokens (CJK text costs more tokens per byte than code). The next-action join needs `sessionFile`, which is absent for ephemeral sessions, and it reads the session tree in file order, so an abandoned branch can occasionally be counted.
