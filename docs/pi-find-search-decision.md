# pi-find grep/find — search tooling decision

**Status:** implemented on `feat/pi-find-search-modes` (six `tsc --noEmit` errors pending — see [Follow-ups](#follow-ups))
**Package:** `@tian.zuo/pi-find` (`packages/pi-find`)

## Context

pi registers `grep` and `find` under the built-in tool names, replacing the built-ins. Execution delegates to `rg` and `fd` child processes; the extension layer only owns the schema, stream decoding, bounding, and rendering. The design goal is not a smaller shell — it is output a model can act on directly: bounded in process cost and bytes, and honest about incompleteness.

## Core choices (locked)

| Topic | Decision | Rationale |
|---|---|---|
| Surface | `grep(pattern, path?, glob?, output?, literal?, context?)`, `find(pattern, path?)` | A small schema cannot be misused; several roots, counts, sorting, and pipelines go to the shell |
| Overflow detection | Check the cap *before* adding; the (N+1)th record's arrival is the overflow signal | Distinguishes an exact fit (complete) from a truncated set with certainty, for one record's cost |
| Context | Enrichment only; never crowds out matches | Two-level defense: runtime judges trustworthiness, render judges fit |
| Auto context | `context` omitted → ±5 lines kept only when the search is complete and sparse (1–3 matches) | A lone hit is usually the answer; a 100-hit list is not improved by context |
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

- **Runtime — is this context worth keeping?** Auto mode speculatively buffers context in the same rg pass (`--context 5` is always on in content mode), clears the buffer the moment a 4th match arrives, and stops collecting once any record was dropped. `finalizeGrep` retains context only for complete sparse searches and filters orphan windows — context belonging to a match that fell past the cap.
- **Render — does it fit?** `boundedBody` renders rows with context; if the byte budget overflows and context was present, it re-renders match rows only. Auto context drops silently (a freebie the model never asked for); explicit context drops with `CONTEXT_OMITTED` and marks the result partial — the model asked for something it did not get.

The runtime cannot know rendered size (clipping, grouping headings, separators all affect bytes); the renderer cannot know a context window is orphaned. Merging the checks would misjudge both.

### 3. Match-aware, surrogate-safe clipping

Lines longer than 400 UTF-16 units are clipped around the **first match**, not from the start: rg's `submatches` byte offsets are converted to UTF-16 offsets by decoding the raw line prefix (handling `lines.bytes` invalid-UTF-8 payloads and stripped `\r`s), and the excerpt window is centered on the match. Edges that would split a surrogate pair are nudged inward so output is always well-formed. Context lines clip from the start. A late match on a minified 10 KB line now stays visible instead of being clipped away.

### 4. Single-base slash globs (breaking change)

Slash-containing globs resolve **only** against the search root — the `path` directory, or the parent of an explicit grep file. Previously they were tried against both the root and the cwd, so `{ path: "src", glob: "src/*.ts" }` matched `src/main.ts` via cwd while `{ path: "src", glob: "deep/*.ts" }` matched `src/deep/x.ts` via root — one parameter, two trees, silently mixed. A single base makes results predictable and descriptions truthful ("relative to the search root").

The cost: the common model habit of redundantly prefixing the path (`path: "src"` + `glob: "src/*.ts"`) now returns empty instead of working. See open questions for mitigating the empty-result UX.

## Follow-ups

- **Typecheck (blocking):** six `tsc --noEmit` errors — `StringEnum`'s `TUnsafe<string>` does not satisfy `GrepOutput` at `tools.ts:77`, tests read `.enum`/`.minimum`/`.maximum` off `TOptional` wrappers, and `String.prototype.isWellFormed` is ES2024 under an ES2022 lib. Candidate fix: `Type.Unsafe<GrepOutput>({ type: "string", enum: [...] })` keeps the flat Google-compatible schema and restores the literal union.
- **Clipped context counts as skipped:** a >8 MiB context record flips `skippedRecords`, suppressing auto context and marking an otherwise-complete search partial. Conservative and safe, but a clipped *context* record is not a missing *match* — the two could be distinguished.
- **Empty-result hints don't cover the glob-base change:** an empty result shows file-size and hidden-path notices, but nothing points at a `/`-glob written against the wrong base. A targeted notice when the result is empty and the glob contains `/` would let the model self-correct.
- **`50` has three sources of truth:** `MAX_CONTEXT_LINES`, the schema `maximum`, and the `(0–50)` description text.
