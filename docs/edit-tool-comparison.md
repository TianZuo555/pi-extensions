# Edit tool review: active pi vs. oh-my-pi

- **Reviewed:** 2026-07-28 (verified against source 2026-07-28)
- **Active runtime:** pi `0.82.1` with `pi-edit-safe` overriding the built-in `edit` tool
- **Now vendored here:** [`packages/pi-edit-safe`](../packages/pi-edit-safe/) (npm `pi-tian-edit-safe`), moved in from [`TianZuo555/pi-edit-safe`](https://github.com/TianZuo555/pi-edit-safe/tree/7a0b4f75f393d753dbaee09d4dab63d5906921a8) `0.1.0` at `7a0b4f7`
- **Comparator:** [`can1357/oh-my-pi`](https://github.com/can1357/oh-my-pi/tree/d16c6168c86f40fc44f25118c2fd06fe160fcb93) `17.1.7` at `d16c616`
- **Scope:** the active `pi-edit-safe` tool versus oh-my-pi's default Hashline mode. Oh-my-pi's fallback `replace` mode is covered separately because it is the closest like-for-like comparator.

> **Status:** the claims below were re-verified against actual source (pi `0.82.1` dist, oh-my-pi at `d16c616`, and this package). Four corrections and the resolved P0 are recorded in [Verification notes](#verification-notes).

---

## Verdict

Keep `pi-edit-safe` as this pi agent's default for now.

Oh-my-pi has the better **complete editing subsystem**: Hashline saves model output, detects stale reads, supports multiple files and syntax-aware block operations, previews diffs while streaming, and integrates LSP formatting/diagnostics, ACP, notebooks, approvals, and generated-file guards.

`pi-edit-safe` has the better **strict replacement primitive**: the target text itself must identify one full span, ambiguity always fails, replacement text is not heuristically repaired, and bytes outside the span—including mixed line endings—remain untouched. It is also small enough to audit.

The main distinction is:

- **Stale-file protection:** Hashline wins.
- **Wrong-target resistance and byte fidelity:** `pi-edit-safe` wins.
- **Model/token efficiency and IDE integration:** Hashline wins.
- **Simplicity and drop-in compatibility with pi:** `pi-edit-safe` wins.

Hashline is worth learning from, but porting it alone would be the wrong move. It depends on coordinated changes to `read`, `search`, `write`, session snapshots, rendering, and model routing. If the desired experience is the entire oh-my-pi harness, use oh-my-pi; do not transplant only its `edit` class and expect the same result.

---

## What is active in this pi session

The active tool is not pi's built-in edit implementation. The installed `pi-edit-safe` extension registers another tool named `edit`, replacing it. It now lives in this repo at [`packages/pi-edit-safe`](../packages/pi-edit-safe/).

Its public form is a single shape — `edits` is always an array, even for one replacement:

```jsonc
// One replacement
{
  "path": "src/a.ts",
  "edits": [{ "oldText": "const x = 1;", "newText": "const x = 2;" }]
}

// Several replacements, applied sequentially
{
  "path": "src/a.ts",
  "edits": [
    { "oldText": "const x = 1;", "newText": "const x = 2;" },
    { "oldText": "const x = 2;", "newText": "export const x = 2;" }
  ]
}
```

Both `path` and `edits` are required, and `edits` carries `minItems: 1`. Offering exactly one call shape is deliberate: it removes a per-call decision the model would otherwise make, and it is what pi's own extension docs recommend ("keep the public schema strict").

It also normalizes common model mistakes before validation — `file_path`/`filePath`, `old_string`/`oldString`, `new_string`/`newString`, a stringified `edits` array, one edit object instead of an array, or top-level `oldText`/`newText` — via `prepareArguments`, which pi runs **before** schema validation. These shapes are tolerated for robustness and for tool calls stored in older resumed sessions, but are deliberately **not** advertised in the schema.

### Matching and write behavior

1. Try an exact match and count occurrences overlap-aware. For example, `aa` in `aaa` is ambiguous, not unique.
2. If exact matching fails, enforce fuzzy gates: at least five non-space characters, no NUL byte, at most one million characters and 50,000 lines.
3. Try increasingly tolerant **full-span** strategies:
   - line-trimmed;
   - Unicode punctuation/space normalization;
   - collapsed whitespace;
   - escaped-character normalization.
4. Reject immediately if a strategy has more than one candidate. It never falls through from ambiguity to a looser matcher.
5. Splice the selected original span with the requested `newText`. Uniform LF/CRLF files adapt replacement newlines to their existing style; mixed-ending files take the replacement verbatim.
6. Apply all entries in memory, in order, then write once. A later failure leaves the file unchanged.

This gives it several strong properties:

- fuzzy matching locates a span but never normalizes the rest of the file;
- exact and fuzzy targets must both be unique;
- no similarity threshold, partial first/last-line anchor, or “best candidate” selection exists;
- `$&`, `$1`, and similar replacement syntax remains literal;
- BOMs and bytes outside the selected span survive;
- dependent edits work because later entries see earlier output.

### Current gaps

The override still gives up useful behavior from pi's built-in tool:

- no LSP formatting or diagnostics;
- no stale-read/version check beyond whether `oldText` still resolves uniquely;
- one file per call; no create, remove, move, or syntax-aware block operation;
- sequential edits can intentionally—or accidentally—target text introduced by an earlier entry.

**Resolved (was the top P0).** The diff/patch regression is fixed in the vendored copy: it now returns pi's built-in `EditToolDetails` shape (`diff`, `patch`, `firstChangedLine`) and deliberately defines neither `renderCall` nor `renderResult`. pi resolves renderer inheritance per slot — `toolDefinition.renderCall ?? builtInToolDefinition.renderCall` in `dist/modes/interactive/components/tool-execution.js` — so omitting both inherits the streaming diff preview and final diff rendering for free. The diff is computed against real bytes on both sides, unlike the built-in's LF-normalized view.

The implementation tests are **45 passed, 0 failed** under Node's own runner (`npm test -w pi-tian-edit-safe`). The 12-case A/B harness against pi's real built-in edit pipeline runs via `npm run bench -w pi-tian-edit-safe` and currently reports 4 divergences and 8 agreements. There is still no cross-model edit benchmark.

---

## How oh-my-pi edits files

Oh-my-pi exposes four selectable modes: `hashline`, `replace`, `patch`, and `apply_patch`. `hashline` is the default. Kimi, MiMo, DeepSeek V4 Flash, and Step 3.7 Flash currently fall back to `replace` unless explicitly overridden, which is practical evidence that no one edit grammar works best for every model.

A typical Hashline interaction is:

```text
# read/search output
[src/a.ts#0A3B]
1:const x = 1;
2:console.log(x);

# edit input
[src/a.ts#0A3B]
SWAP 1.=1:
+export const x = 2;
INS.POST 2:
+console.log("done");
```

The four-hex tag is the low 16 bits of an xxHash32 fingerprint of the whole normalized file. The line operations refer to the original snapshot within that call. Hashline can replace/delete explicit ranges, insert before/after/head/tail, resolve whole syntax blocks with tree-sitter, edit several files, and remove or move files.

### Strong parts

- **Explicit stale detection.** A section tag binds line numbers to a file version.
- **Fail-closed recovery.** When the file changed, recovery remaps only unchanged anchors with consistent offsets and surrounding context; changed or ambiguous targets reject.
- **Lower model output.** The model emits line numbers plus new content instead of retyping old content.
- **Multi-file preflight.** Every section is parsed, read, policy-checked, and applied in memory before writes begin.
- **Fresh grounding.** Successful results return a new `[path#TAG]` header and compact diff.
- **Rich integration.** Streaming preview, unified diff details, LSP formatting/diagnostics, ACP routing, notebook serialization, approval classification, generated-file protection, and model-specific mode selection are built in.
- **Grammar assistance.** Providers supporting custom grammar tools can receive Hashline's Lark grammar.
- **Loop protection.** Three repeated identical no-op patches escalate from a soft result to a hard tool error.

### Safety qualifications

Hashline's hash proves “this file version probably matches”; it does **not** prove that the model selected the intended line. A valid tag plus the wrong line number still edits the wrong line. The optional seen-line guard only proves that a line was displayed, not that it was intended, and the oh-my-pi coding-agent setting currently defaults that guard to **off**.

Other qualifications matter for a strict tool:

1. **The tag is only 16 bits.** Two different file states can share the same four-hex tag, and re-reading cannot resolve such a collision because it mints the same tag. The concrete exposure is narrow but real: `patcher.ts` computes `liveMatches = computeFileHash(normalized) === expected` and, when true, applies the edit **directly** — recovery never runs. So a drifted file that happens to hash to the model's stale tag is treated as fresh. Collisions become likely across roughly 256 unrelated states by the birthday bound. (The snapshot store itself is *hardened* against this: `snapshots.test.ts` asserts colliding texts are retained as distinct versions with separate `seenLines`, a regression test for issue #4075. `byHash` resolving a collision to the most-recent version is a deliberate fallback, not blanket acceptance.)
2. **Some stale operations still apply.** Head/tail-only insertion applies to live content with a warning even when the tag is stale because the position is considered stable.
3. **The tool repairs intent after parsing.** It may drop echoed boundary lines, keep omitted structural closers, shift insertions across closers based on indentation, or auto-prefix malformed body rows. These repairs are conservative and warned, but the persisted result can differ from the literal payload.
4. **Whole-file newline normalization occurs.** Hashline normalizes the whole file to LF and restores the first detected newline style. A mixed LF/CRLF file is therefore flattened even when untouched lines were outside the edit. `pi-edit-safe` deliberately preserves this case byte-for-byte.
5. **Multi-file writes are not rollback-atomic.** Validation is preflighted for all sections, but an I/O failure during serial commits can leave earlier files written; the error reports which ones landed.
6. **Large files lose Hashline anchors.** Files above 4 MiB are not snapshotted and receive no `[path#TAG]` header. `pi-edit-safe` still permits an exact edit on large files; only its fuzzy fallback is size-gated.
7. **Complexity is substantial.** Hashline's core is about 5,900 source lines (5,906 non-test), before roughly 8,600 lines of coding-agent edit integration covering all modes and rendering. That complexity buys real features, but its changelog also records recent critical fixes for boundary repair, duplicated-context recovery, collisions, and malformed ranges.

---

## Side-by-side

| Dimension | Active `pi-edit-safe` | oh-my-pi Hashline |
|---|---|---|
| Address | Unique old-content span | Whole-file 4-hex tag + line/range |
| Stale context | Indirect: target must still resolve | Explicit rejection plus conservative remap |
| Wrong line in unchanged file | Old text must identify it | Valid tag does not validate chosen line |
| Ambiguity | Always throws | Recovery throws; live line addressing has no content ambiguity check |
| Fuzzy behavior | Full-span structural equality only | Normally none; snapshot recovery maps unchanged lines |
| Payload fidelity | Literal splice, except uniform newline adaptation | May auto-repair boundaries/landing and formatter may transform output |
| Untouched bytes | Preserved, including mixed endings | BOM preserved; mixed endings flatten to first style |
| Batch semantics | One file, sequential entries, one final write | Original line numbers; multi-file preflight then serial writes |
| Model burden | One call shape (`edits[]` only), but must repeat old text | New DSL, but emits only anchors and new text |
| Multi-file / move / delete | No | Yes |
| Syntax-aware blocks | No | Yes, tree-sitter |
| TUI / SDK diff | Inherited from built-in (returns `diff`/`patch`/`firstChangedLine`, defines no renderers) | Streaming preview + rich result details |
| LSP / ACP / notebooks | No | Integrated |
| Exact large-file edit | Yes | No Hashline snapshot above 4 MiB |
| Auditability | Small and explicit | Large, feature-rich subsystem |

### Oh-my-pi `replace` mode

Oh-my-pi's `replace` mode is closer to `pi-edit-safe`, but is intentionally more permissive:

- Levenshtein-style matching with a default 0.95 threshold;
- can auto-select a dominant fuzzy candidate even when several candidates exceed the threshold — though this is gated more tightly than the bare threshold suggests: `confidence >= 0.97` **and** at least a `0.08` margin over the second-best candidate;
- can adjust replacement indentation to the matched location;
- supports `all: true`;
- normalizes and restores line endings for the whole file;
- writes each array entry before attempting the next, so a later failure can leave earlier entries applied.

It has much better diagnostics, diff rendering, LSP integration, and surrounding policy controls. For the narrow goal “never guess which occurrence the model meant,” however, `pi-edit-safe` is stricter.

---

## Benchmark evidence

Oh-my-pi's linked February 2026 benchmark is meaningful but not a direct verdict on this comparison:

- 16 models;
- three runs × 180 generated repair tasks;
- fresh sessions with a restricted file-editing toolset;
- Hashline beat patch mode for 14 of 16 models;
- several weaker/fast models gained dramatically, and some used substantially fewer output tokens.

However:

- it did not test `pi-edit-safe`;
- the article describes an earlier per-line-tag Hashline generation, while current Hashline uses a whole-file four-hex tag and a substantially evolved grammar;
- pass rate measures whether the final repair matched the fixture, not strict byte preservation or adversarial wrong-location resistance;
- current oh-my-pi itself routes several model families away from Hashline.

The result supports the architecture claim—**tool format materially changes model performance**—but does not establish that current Hashline is safer than the active tool.

---

## Recommended direction

### P0 — restore pi-native result quality — **DONE**

The matcher is unchanged; the result payload now carries pi's native shape:

- a standard unified patch (`generateUnifiedPatch`);
- `details.diff` and `firstChangedLine` (`generateDiffString`);
- built-in-quality pre-execution and final diff rendering, inherited by defining no renderers.

Both helpers are public pi exports (`dist/index.d.ts`), so this was a ~15-line change rather than a project. Remaining sub-item, if an SDK/ACP consumer ever needs it: bounded old/new snapshots (`oldText`/`newText` in `details`, as oh-my-pi's `pruneOversizedEditSnapshots` does).

### P0 — run a real model A/B

Use one corpus and compare:

1. pi built-in edit;
2. `pi-edit-safe`;
3. oh-my-pi `replace`;
4. oh-my-pi Hashline.

Measure pass@1, malformed calls, retries, output tokens, time, wrong-location edits, no-op loops, changed bytes outside the requested span, mixed-line-ending preservation, and behavior after external concurrent changes. Include both frontier and weak/fast models. The existing 12 hand cases should remain as deterministic corruption regressions, not stand in for this eval.

### P1 — add optional strong stale-read protection

Use a hybrid contract rather than replacing `oldText`:

- retain unique full-span `oldText` validation;
- optionally bind the edit to an exact stored snapshot/version emitted by `read`;
- use an opaque or at least 64-bit identifier and verify the stored full text, rather than trusting short-hash equality;
- recover only when the same unique old-content span is unchanged;
- reject instead of auto-repairing replacement content.

This combines Hashline's stale-context protection with `pi-edit-safe`'s higher-information content anchor.

### P1 — adopt selected operational safeguards

- repeated-no-op loop guard;
- generated-file policy hook;
- actionable occurrence previews and closest-context diagnostics, without auto-selecting them;
- optional formatter/diagnostics integration that reports any post-edit transformation accurately.

### P2 — Hashline only as an experimental coordinated mode

If model evals justify it, add a separate mode only alongside matching `read`/`search`/`write` snapshot output and model-specific fallback. Preserve strict mode as the default and retain these non-negotiable properties:

- no silent selection among multiple candidates;
- no 16-bit identity as the only guard;
- no whole-file mixed-newline rewrite;
- no silent boundary or indentation repair;
- every applied transformation visible in the diff.

---

## Verification notes

Every load-bearing claim above was re-checked against source on 2026-07-28: pi `0.82.1` dist, oh-my-pi at `d16c616` (fresh clone, HEAD confirmed), and this package. Confirmed as written: the xxHash32 low-16-bit tag (`format.ts:114`), `edit.enforceSeenLines` defaulting to `false`, `SNAPSHOT_MAX_BYTES = 4 * 1024 * 1024`, the four `replace`-mode model fallbacks (kimi, mimo, deepseek-v4-flash, step-3.7-flash), stale head/tail inserts applying with `HEADTAIL_DRIFT_WARNING`, `NOOP_HARD_LIMIT = 3`, `replace`-mode per-entry writes and `adjustIndentation`, and the benchmark's 16 models / 3×180 tasks / 14-of-16 result.

Four corrections were applied:

1. **Collision framing softened.** The earlier text said the implementation and tests "explicitly accept" colliding-tag edits. The cited test is actually a hardening regression (issue #4075) that keeps colliders distinct. The real exposure is the `liveMatches` fast path, which is now described precisely.
2. **`replace`-mode dominant-fuzzy gates added.** Auto-selection additionally requires `confidence >= 0.97` and a `0.08` margin over second-best, not merely exceeding the 0.95 threshold.
3. **Integration LOC corrected** from ~8,300 to ~8,600.
4. **The diff/patch gap was resolved, not just documented** — see the P0 entry. The relevant helpers (`generateDiffString`, `generateUnifiedPatch`) are public pi exports, and pi inherits built-in renderers per slot, so the "no TUI diff preview" gap did not require reimplementing any UI.

Two things the original review missed:

- **`npm test` was broken in a fresh checkout.** All five test files failed with `Cannot find package 'tsx'`; only Bun ran them. The vendored copy uses Node's native type stripping (`node --test --experimental-strip-types`) to match this repo's convention, which required replacing a constructor parameter property in `EditError` — parameter properties emit real code and are rejected by strip-only loaders.
- **The upstream install was unpinned.** `settings.json` referenced `git:github.com/TianZuo555/pi-edit-safe` with no commit SHA, so the `edit` tool auto-updated from a branch — which undercuts the auditability argument more than any Hashline feature does. Vendoring into this monorepo removes that class of drift entirely.

---

## Bottom line

`pi-edit-safe` is the better default **tool for this pi agent today**. Oh-my-pi is the better **reference architecture** for an editing subsystem.

Borrow its diff/diagnostic integration, no-op guard, stale-snapshot concept, model routing, and benchmark discipline. Do not trade away unique full-span matching, literal replacement, mixed-ending preservation, or auditability merely to copy the Hashline format.

---

## Sources

### Active tool

- [`packages/pi-edit-safe` in this repo](../packages/pi-edit-safe/README.md) (current, vendored)
- [Tool registration, schema, and result details](../packages/pi-edit-safe/index.ts)
- [Strict matcher and sequential applier](../packages/pi-edit-safe/lib/edit-replace.ts)
- [Input-shape normalization](../packages/pi-edit-safe/lib/prepare-arguments.ts)
- [A/B harness against pi's real built-in edit](../packages/pi-edit-safe/bench/ab.ts)

Upstream origin, as reviewed:

- [`pi-edit-safe` README at `7a0b4f7`](https://github.com/TianZuo555/pi-edit-safe/blob/7a0b4f75f393d753dbaee09d4dab63d5906921a8/README.md)
- [Tool registration and schema](https://github.com/TianZuo555/pi-edit-safe/blob/7a0b4f75f393d753dbaee09d4dab63d5906921a8/src/index.ts)
- [Strict matcher and sequential applier](https://github.com/TianZuo555/pi-edit-safe/blob/7a0b4f75f393d753dbaee09d4dab63d5906921a8/src/edit-replace.ts)
- [Input-shape normalization](https://github.com/TianZuo555/pi-edit-safe/blob/7a0b4f75f393d753dbaee09d4dab63d5906921a8/src/prepare-arguments.ts)

### pi built-in (comparison baseline)

- `dist/core/tools/edit.js` — whole-file LF normalize/restore, `details: { diff, patch, firstChangedLine }`
- `dist/core/tools/edit-diff.js` — `generateDiffString` / `generateUnifiedPatch`, both public exports
- `dist/modes/interactive/components/tool-execution.js` — per-slot renderer inheritance

### oh-my-pi

- [Edit tool reference at `d16c616`](https://github.com/can1357/oh-my-pi/blob/d16c6168c86f40fc44f25118c2fd06fe160fcb93/docs/tools/edit.md)
- [Mode selection and model fallbacks](https://github.com/can1357/oh-my-pi/blob/d16c6168c86f40fc44f25118c2fd06fe160fcb93/packages/coding-agent/src/utils/edit-mode.ts)
- [Hashline model-facing prompt](https://github.com/can1357/oh-my-pi/blob/d16c6168c86f40fc44f25118c2fd06fe160fcb93/packages/hashline/src/prompt.md)
- [Four-hex hash calculation](https://github.com/can1357/oh-my-pi/blob/d16c6168c86f40fc44f25118c2fd06fe160fcb93/packages/hashline/src/format.ts)
- [Snapshot store and collision behavior](https://github.com/can1357/oh-my-pi/blob/d16c6168c86f40fc44f25118c2fd06fe160fcb93/packages/hashline/src/snapshots.ts)
- [Patcher, stale checks, seen-line guard, and commit flow](https://github.com/can1357/oh-my-pi/blob/d16c6168c86f40fc44f25118c2fd06fe160fcb93/packages/hashline/src/patcher.ts)
- [Coding-agent edit defaults, including the disabled-by-default seen-line guard](https://github.com/can1357/oh-my-pi/blob/d16c6168c86f40fc44f25118c2fd06fe160fcb93/packages/coding-agent/src/config/settings-schema.ts)
- [4 MiB snapshot cap](https://github.com/can1357/oh-my-pi/blob/d16c6168c86f40fc44f25118c2fd06fe160fcb93/packages/coding-agent/src/edit/file-snapshot-store.ts)
- [Stale-anchor recovery](https://github.com/can1357/oh-my-pi/blob/d16c6168c86f40fc44f25118c2fd06fe160fcb93/packages/hashline/src/recovery.ts)
- [Hashline apply and automatic repair logic](https://github.com/can1357/oh-my-pi/blob/d16c6168c86f40fc44f25118c2fd06fe160fcb93/packages/hashline/src/apply.ts)
- [Oh-my-pi replace mode](https://github.com/can1357/oh-my-pi/blob/d16c6168c86f40fc44f25118c2fd06fe160fcb93/packages/coding-agent/src/edit/modes/replace.ts)
- [The Harness Problem benchmark article](https://blog.can.ac/2026/02/12/the-harness-problem/)
