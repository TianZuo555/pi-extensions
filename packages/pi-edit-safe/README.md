# pi-edit-safe

A drop-in replacement for the **pi coding agent**'s built-in `edit` tool, with a
stricter matcher that refuses to silently edit the wrong place — and a call shape
that weaker models can actually use.

> Exposes **one** call shape — `{path, edits: [...]}`, always an array, even for a
> single replacement — so the model has nothing to choose per call. Multi-edit
> applies **in order** (sequential), the contract models assume from multi-edit
> tools elsewhere, instead of pi's all-against-the-original-file semantic.
>
> The looser shapes models emit anyway are still folded onto that form before
> validation, so a stray legacy call is normalized rather than rejected — they
> are just not advertised.

Install: `npm:pi-tian-edit-safe` · npm package `pi-tian-edit-safe` · workspace `packages/pi-edit-safe`

## Call shape

One shape, always an array:

```jsonc
// single change — still a one-element array:
{ "path": "src/a.ts", "edits": [
	{ "oldText": "const x = 1;", "newText": "const x = 2;" }
] }

// several changes, applied in order, top to bottom:
{ "path": "src/a.ts", "edits": [
	{ "oldText": "...", "newText": "..." },
	{ "oldText": "...", "newText": "..." }
] }
```

`path` and `edits` are both required and `edits` has `minItems: 1`. Nothing else
is advertised to the model.

### Tolerated but not advertised

`prepareArguments` runs **before** schema validation (per pi's extension
contract) and folds these onto the canonical form: `file_path`/`filePath`/`filename`
for `path`; `old_string`/`new_string`, `oldString`/`newString`, `old_str`/`new_str`
for the pair (per entry or top-level); top-level `oldText`/`newText` shorthand;
`edits` as a JSON **string**; and `edits` as a single object.

This keeps old resumed sessions and off-contract calls working without widening
the public schema. Exact duplicate entries are rejected loudly. When a later edit
fails because an earlier edit in the same call rewrote its target, the error says
exactly that.

## Design stance

| Decision | typical fuzzy edit tools | **pi-edit-safe** |
|---|---|---|
| Partial-signal strategies (first/last-line anchor) | yes | **none** |
| On ambiguity | fall through to next candidate | **throw immediately** |
| Fuzzy candidate validation | per-candidate similarity threshold | **full-span structural equality + exactly-one + occurs-once** |
| Overlapping exact matches | often missed | **caught** (overlap-aware counting) |
| Unicode punctuation drift (smart quotes, em dash, NBSP) | varies | **strict `unicode` strategy**, span-only |
| Untouched bytes | may be normalized whole-file | **never touched** (slice + verbatim splice) |
| Line endings | whole-file normalize/restore | **span-boundary only**; mixed-ending files never flattened |
| `newText` write | `String.replace` (`$&` hazard) | **slice-join** (literal) |
| Multi-edit semantics | all edits vs the original file | **sequential, in order** |
| Call shapes offered to the model | varies | **exactly one** (`edits[]`) |

Fuzzy matching only ever *locates a span*. The replacement is spliced in
verbatim — it is never re-indented or rewritten.

## Matching order

1. **Exact**, never gated, counted overlap-aware (`aa` in `aaa` is ambiguous, not unique).
2. If exact fails, hard gates: ≥5 non-space chars, no NUL byte, ≤1M chars, ≤50k lines.
3. Increasingly tolerant **full-span** strategies: line-trimmed → unicode
   punctuation → collapsed whitespace → escape-normalized.
4. More than one candidate for a strategy → **throw**. Never falls through from
   ambiguity to a looser matcher.
5. Splice verbatim. Uniform LF/CRLF files adapt the replacement's newlines;
   mixed-ending files take it as-is.
6. Apply all entries in memory, in order, then write once — a later failure
   leaves the file unchanged.

## Result details

Returns pi's built-in `EditToolDetails` shape (`diff`, `patch`,
`firstChangedLine`) alongside a `edits[]` array of per-edit provenance
(`matchedVia`, `startLine`, `endLine`).

Because pi resolves renderer inheritance **per slot**
(`toolDefinition.renderCall ?? builtInToolDefinition.renderCall`), this override
deliberately defines neither `renderCall` nor `renderResult`, and so inherits
pi's streaming diff preview and final diff rendering for free.

The diff is computed against the **real bytes** on both sides. pi's built-in
diffs its LF-normalized view instead, which is why the two disagree on
mixed-line-ending files (see bench case 11).

## Disable

```bash
PI_EDIT_SAFE_DISABLE=1 pi   # falls back to the built-in edit
```

## Tests and A/B bench

```bash
npm test -w pi-tian-edit-safe    # 45 unit tests (Node's built-in runner)
npm run bench -w pi-tian-edit-safe
```

The bench imports pi's **actual shipped** `edit-diff.js` functions and composes
them exactly as `dist/core/tools/edit.js` does, then runs the same 12
(file, edits) cases through both pipelines and reports every divergence,
including "canary" lines that must stay byte-identical.

These are deterministic corruption regressions. They are **not** a model-level
eval — no cross-model pass@1 / token / retry benchmark exists for this tool yet.

## Attribution

Fuzzy-strategy concepts adapted from opencode (MIT, via cline MIT and
gemini-cli Apache-2.0); the unicode normalization table mirrors pi's own
normalizer (MIT), applied span-only. Design philosophy reproduced
independently. See [NOTICES.md](./NOTICES.md).
