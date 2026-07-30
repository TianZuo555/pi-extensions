# Review: tool-result pruning for Pi

**Status:** review and recommendation. Companion to `docs/tool-result-pruning-system-design.md`. No implementation started.

**Reviewing:** `docs/tool-result-pruning-system-design.md` (design proposal for `pi-tian-tool-prune`)

**Verified against:** installed Pi **0.83.0** (`dist/core/extensions/runner.js`, `dist/core/agent-session.js`, `docs/compaction.md`, `docs/extensions.md`). The design doc says "verified against 0.80.10" — re-verify before implementing.

**Measured against:** 322 local session JSONL files in `~/.pi/agent/sessions` (73 MB), replayed offline as a counterfactual.

---

## 0. The claim being tested

The design doc is a response to a public post about Maka's tool-result pruning. The post's argument, in its own words:

> 做 Agent 有个不成文的默认假设：tool result 很重要，模型要看完原文才能继续推理。最近发现这个假设可能是错的。
>
> 在 maka 里，我们对 tool result 做了激进的 prune ⋯ 结论让人意外：推理质量几乎没有变化，近乎无损压缩。
>
> 1. 信息已经被蒸馏进 Assistant Message ⋯ 后续轮次的模型，更多是在跟"它自己的理解"对话，而不是在跟 tool result 原文对话。
> 2. Attention 在长上下文里本来就稀疏 ⋯ 模型本来就没在认真"读"它。
> 3. 决策点已经过去 ⋯ 保留原文是"存档"，不是"决策输入"。
>
> 实测数据：对同一个任务（MIPS interpreter），Maka 的总 token 消耗只有 OpenCode 的 38%，但 output token 是它的 2.7 倍 ⋯ 有 DeepSeek cache 命中率 95% 的贡献，也有 tool result prune 的贡献。
>
> 信息的真正载体不是原文，是理解。

The design doc already dismantles the strong form of this ("information's true carrier is understanding, not the original" → too strong; *Lost in the Middle* → directionally plausible, overstated; the 38%/2.7× figures → unverifiable from the public repo). I agree with all of that and will not re-argue it.

What I add here is: **the weak form of the claim is true and worth acting on, I measured how much it is worth on this machine's real sessions, and the design doc's proposed implementation is roughly five times larger than the payoff justifies.**

---

## 1. Verdict

The design doc is good — notably better than the post it critiques. Four things in it are correct and load-bearing, and should survive into any implementation:

1. **`context`-as-projection.** Rewrite a deep copy before each provider call; never mutate session history. This is exactly the right seam, and the doc is right that `tool_result` (too early, destroys evidence) and `before_provider_request` (too late, provider-specific) are both wrong.
2. **Read-once eligibility.** Guarantee one successful model request sees each result in full before it can be compacted.
3. **Fail open.** Any uncertainty about eligibility, lookup, or recoverability → keep the full result.
4. **The reframe.** "Declining marginal utility plus recoverability" instead of "tool results are unimportant"; "context is a projection of evidence" instead of "information is understanding."

Three things I would change:

| # | Change | Why |
|---|---|---|
| A | **Drop `recall_tool_result` from v1.** | ~65% of large results are already recoverable through tools Pi *already has*. |
| B | **Invert the cache-risk ordering of `stale` vs `active`.** | `stale` invalidates the hottest part of the prompt prefix on every turn; `active` is near cache-neutral. The doc has them backwards. |
| C | **Replace the 5-arm live A/B with offline replay over existing sessions.** | Cheaper, faster, exactly measures what you need for tuning, and supports a recoverability proxy the live plan cannot. |

And one thing the doc misses, which is the **strongest argument in favour of the feature** — see §4.

---

## 2. The payoff is real — measured

### Method

For each session JSONL: reconstruct the `user`/`assistant`/`toolResult` message sequence; for message *i*, count the number of later assistant messages (= number of future provider requests that message is re-sent in); estimate tokens as `chars / 4`. Cumulative provider-visible input = `Σ tokens(i) × future_requests(i)`. Read-once avoided = for each `toolResult` over threshold, `(chars − 600) / 4 × (future_requests − 1)` — i.e. keep one request full, then a ~600-char capsule forever after. Sessions with fewer than 5 assistant messages excluded.

### Result

Cumulative provider-visible input across all sessions: **~857M estimated tokens.**

| Prune threshold | Results hit | Avoided | % of cumulative input |
|---|---|---|---|
| > 500 tok (2 KB) | 2504 | 417M | **48.7%** |
| > 2k tok (8 KB) — *Maka's default* | 813 | 323M | **37.7%** |
| > 8k tok (32 KB) — *design doc's proposed default* | 146 | 170M | **19.8%** |
| > 30k tok (120 KB) | **8** | 89M | **10.3%** |

Per-session, the top cases reach 60–71% of cumulative input avoidable. Aggregated over the 40 largest sessions: 795M cumulative input, 301M avoidable (38%).

### Two things fall out of this

**The distribution is a power law.** *Eight* tool results account for 10% of all repeated input on this machine. A v1 that prunes only the handful of monsters is nearly risk-free and still worth ~20%. This validates the design doc's conservative 8k default as a *starting* point — but it should be stated explicitly that 8k forfeits roughly half the available benefit, and that Maka's 2k threshold (which the doc calls "aggressive, unvalidated") is where the money actually is. The threshold should be a tuned dial, not a moral position.

**Large results are dominated by reproducible tools.** Of the 813 results over 2k tokens:

| Tool | Count | Bytes | Reproducible without an archive? |
|---|---|---|---|
| `read` | 448 (55%) | 11.2 MB | **Yes** — re-read `path` |
| `bash` | 183 (22%) | 4.1 MB | **No** — side effects, time-varying |
| `fetch_content` / `web_search` / `get_search_content` | 101 (12%) | 4.0 MB | **Yes** — `get_search_content` + `responseId` |
| `ffgrep` / `code_search` / `grep` / `find` | 79 (10%) | 1.1 MB | **Yes** — re-run the query |
| other | 2 | — | — |

That last column is the key to recommendation A.

### Caveat the design doc must absorb

**This is an upper bound, not a savings estimate.** It ignores compaction. Long sessions already get cut at `contextWindow − reserveTokens`, so tokens "avoided" by pruning overlap with tokens compaction would have removed anyway. The same caveat applies to Maka's published "1.87M tokens avoided" figure. The design doc already says estimated avoided tokens are "a counterfactual projection, not provider billing evidence" — good, but it should add *and not disjoint from compaction's savings* and label every such number that way.

---

## 3. Recommendation A — drop the recall tool from v1

The design doc's §4 (`recall_tool_result`) plus §3's digest-bearing capsules plus the open questions about branch resolution and post-compaction recall together represent most of the project's complexity and most of its risk surface.

The table above shows ~65% of large results (`read`, search, web) need **no new recall mechanism at all**. The capsule can simply say "re-read it":

- **`read` results** → capsule carries `path` and line range; the model re-reads with the existing `read` tool. This is *better* than an archive: it returns current content, not a stale snapshot. The only loss is "what did this file look like before I edited it," which is rare and usually already captured in the edit's own diff.
- **search results** (`grep`/`find`/`ffgrep`/`code_search`) → capsule carries the query; re-run it. Same freshness argument.
- **web results** → Pi already ships the recall path. `web_search`/`fetch_content` return a `responseId`, and `get_search_content` retrieves bounded slices by `responseId` + `url`/`query` with `offset`/`limit`. The capsule just needs to name the `responseId`. Zero new machinery.
- **`bash`** → genuinely non-reproducible. This is the only category that needs true archival recall, and it is 22% of results / ~4 MB.

So: **v1 = `read` + web results only, capsules point at existing re-read paths, no `recall_tool_result` tool, no digest verification, no archive, no branch resolution, no post-compaction-recall guarantee.** That captures roughly two-thirds of the addressable savings at maybe 20% of the complexity, and it deletes design-doc open questions 1, 2, 8, and 9 outright.

`recall_tool_result` becomes a Phase 2 feature scoped narrowly to `bash` results, where it is actually necessary and where the design doc's careful digest/bounded-slice discipline earns its keep.

---

## 4. What the design doc misses: pruning *reduces* compaction

The design doc treats compaction defensively (§7: "leave compaction enabled, don't override `session_before_compact`, test recall after compaction"). It misses that the interaction is strongly **positive**, and this is the best argument for shipping the feature.

From Pi 0.83.0 internals:

- `agent-session.js` computes `contextTokens` from **provider-reported usage** (`calculateContextTokens(assistantMessage.usage)`), then calls `shouldCompact(contextTokens, contextWindow, settings)`. Usage reflects the **projected** — i.e. pruned — context.
- Compaction builds its summarization input from `sessionManager.getBranch()` — the **original, unpruned** entries (with per-result truncation to 2000 chars, as `docs/compaction.md` states).

Therefore:

1. **Pruning delays or eliminates auto-compactions.** Lower reported context → threshold reached later or never.
2. **Pruning does not degrade compaction summary quality.** The summarizer still reads original evidence from the session.

Fewer compactions means fewer summarization LLM calls, less latency, and less *irreversible* semantic loss — because compaction genuinely destroys detail in the active context, whereas a capsule with a re-read path does not. That is a **quality** upside, not merely a cost one, and it deserves to be the headline of the design doc's motivation section rather than a footnote.

**Edge case worth a fixture test:** on `stopReason === "error"` or zero-usage responses, `agent-session.js` falls back to `estimateContextTokens(this.agent.state.messages)` — the **unpruned** message array. So on API-error turns, compaction can trigger earlier than the true projected context warrants. Not harmful, but it means the interaction is not uniformly monotonic and should be asserted in tests.

---

## 5. Recommendation B — the cache-risk ordering is inverted

Anthropic-style prompt caching (and OpenAI's prefix caching) invalidates the cached prefix **from the first changed position onward**. Apply that to the two modes:

**`active` (read-once):** the prune boundary advances monotonically and always sits ~1–2 tool steps behind the tail. The invalidated suffix is small — roughly comparable to what appending a new turn costs anyway. **Near cache-neutral.**

**`stale` (protect recent N user turns):** the prune boundary sits at the *start* of the protected recent-turn window. Every new user turn shifts that window forward, which rewrites a position *behind the entire recent window* and invalidates all of it — the largest, hottest, most-frequently-re-read part of the prefix — **on every turn.**

The design doc has `stale` as the "conservative production arm" and `active` as the "Maka-style aggressive experiment." On cache economics that is backwards. Given cache-read pricing around 0.1× and cache-write around 1.25× of base input, `stale` could plausibly *increase* spend while reducing logical tokens — exactly the token-savings-vs-cost-savings conflation the design doc rightly warns about in §8, but then commits in its own mode ranking.

**Recommendation:** either measure cache behaviour before choosing the conservative default, or promote `active` (read-once, high threshold) to the conservative arm and treat `stale` as the experiment. My preference is the latter: `active` with an 8k threshold and a `read`-only allowlist is both the safest *and* the most cache-friendly starting configuration.

---

## 6. Smaller corrections to the design doc

**6.1 `emitContext` clones once, not per handler.** From `dist/core/extensions/runner.js`:

```js
async emitContext(messages) {
  let currentMessages = structuredClone(messages);
  for (const ext of this.extensions) {
    ...
    if (handlerResult && handlerResult.messages) currentMessages = handlerResult.messages;
  }
  return currentMessages;
}
```

The clone happens once; handler outputs then chain. A later extension sees the *previous* extension's rewritten array, not a fresh copy of session state. The design doc's test item "multiple context extensions chain without mutating shared input" should be reframed: **tolerate upstream rewrites, key every decision off `toolCallId`, never rely on array index or object identity being stable across requests.** Also note the runner swallows handler exceptions and emits an extension error — which means fail-open is partly free, but a thrown handler silently sends the *unpruned* context, so telemetry must distinguish "decided not to prune" from "crashed before pruning."

**6.2 Capsule byte-stability must be an invariant, not a preference.** The design doc says capsules should be deterministic (§3, invariant 6). Make it stricter: capsules must be **byte-identical across requests**, which forbids *any* live-state field — no "compacted after 3 steps", no request counters, no relative timestamps, no "estimated N tokens saved so far." A single varying byte re-invalidates the prefix on every request and destroys the entire cache argument. This deserves a dedicated test that projects the same session twice and asserts byte equality.

**6.3 New injection surface.** A tool result whose *content* contains a forged capsule header could induce the model to trust fabricated provenance or call recall with an attacker-chosen id. Capsule delimiting should be unspoofable (session-local nonce in the header), and any recall path must reject ids it did not mint. The design doc's safety invariants cover truthfulness (13) but not spoofing.

**6.4 Version drift.** Design doc says 0.80.10; installed is 0.83.0. `ToolResultMessage` shape, `sessionManager` API, and compaction internals should be re-read before implementation.

---

## 7. Recommendation C — replace the evaluation plan

The design doc proposes five arms (off / observe / stale / active / aggressive-active), non-inferiority intervals with confidence bounds, a paired batch runner with clean worktrees and randomized arm order, deterministic verifiers, acceptance gates, and multi-model robustness checks.

That is a research program. For a personal extension in a repo whose largest package is ~2k lines, the cost of building that harness exceeds the value of the savings it would validate — unless the goal is to publish a public claim, in which case it is proportionate.

**Do offline replay instead.** The 322 sessions already on disk are a free, deterministic, high-volume evaluation corpus. Replay gives:

- **Exact** projected-context deltas per session — not estimates from a handful of live tasks.
- Threshold and allowlist sweeps in *seconds*, over hundreds of real sessions, with zero provider spend.
- A **recoverability proxy the live plan cannot produce**: for each result that *would* have been pruned, check whether any later assistant message quotes a substring of it (n-gram match on identifiers, paths, error strings, literals). That directly measures "was the capsule lossy in practice," offline, at corpus scale. A live A/B can only observe aggregate pass rates and hope regressions surface.
- Cache-boundary simulation: count how many prefix bytes each mode invalidates per request, which settles §5 empirically before any live run.

Then keep a *smoke* test only: arms A (off) vs D (active, 8k, read-only) on ~10 real tasks, checking for protocol errors and gross behaviour changes. Drop arm B (observe adds a mode to maintain that replay already covers), drop arm E, drop the acceptance gates and the batch runner.

If the offline replay later shows something surprising and you *want* to publish, build the harness then, with the replay data telling you which tasks are worth running.

---

## 8. Recommended plan

### Phase 0 — offline replay analyzer (do this first, before any extension code)

A standalone script (not a published package) that reads `~/.pi/agent/sessions/**/*.jsonl` and reports, per policy configuration:

- cumulative provider-visible input, avoided tokens, and % — with and without simulated compaction;
- per-tool breakdown of eligible results;
- prefix-invalidation bytes per request for `active` vs `stale` (the §5 question);
- the quote-based recoverability proxy: how often later assistant text reproduces substrings of would-be-pruned results, broken down by tool;
- threshold sweep: 500 / 2k / 8k / 32k tokens.

**Exit:** you have empirically chosen a default threshold, a default mode, and a tool allowlist, and you know the measured lossiness risk per tool. This is also where the §2 numbers get re-derived properly with compaction modelled.

### Phase 1 — minimal extension

`packages/pi-tool-prune/` → `pi-tian-tool-prune`:

- **`context` handler only.** Replace `content` on eligible `toolResult` messages; preserve role, `toolCallId`, `toolName`, `isError`, timestamps, ordering, and the paired assistant tool call.
- **Read-once eligibility**, as the design doc specifies: at least one later assistant message with stop reason `toolUse` or `stop`; newest completed batch always full.
- **Allowlist:** `read` + `fetch_content` / `web_search` / `get_search_content` only. Not `bash`, not search tools, not custom tools, not images, not error results, not user-interaction tools.
- **Capsules:** byte-stable, ≤ ~150 tokens, carrying tool identity, source (path + range, or `responseId`), original size, and an explicit re-read instruction naming the *existing* tool to use.
- **No recall tool. No archive. No digest verification.**
- **Threshold:** whatever Phase 0 chose; expect 8k tokens.
- **Fail open** on every uncertainty, with telemetry distinguishing "not eligible" from "handler error."
- **Commands:** `/tool-prune status`, `/tool-prune on|off`, `/tool-prune explain <id>`. Skip `report` initially — replay covers analysis.
- **Fixture tests** per the design doc's §"Test strategy", minus every recall/archive/branch/compaction-recall case, plus: byte-identical capsule across two projections; upstream context extension rewrote the array; API-error turn does not mis-trigger compaction accounting.

**Exit:** typechecks, fixture tests pass, offline replay of real sessions shows the expected savings, and ~10 live tasks show no protocol errors and no visible behaviour change.

### Phase 2 — `bash` results and true recall

Only now introduce `recall_tool_result`, scoped to non-reproducible results (`bash`, and search if replay shows re-running is expensive). This is where the design doc's digest verification, bounded slices, branch-resolution question, and post-compaction recall test all belong — and where they are worth the cost, because there is no alternative recovery path.

**Exit:** recall succeeds reliably including after session reload and compaction; replay shows the added coverage is worth the added surface.

### Phase 3 — threshold reduction

Lower the threshold toward 2k tokens (where §2 says ~38% lives) once Phases 1–2 have shown no recoverability problems at 8k. This is a dial turn, not new code.

### Explicitly not planned

- LLM-generated semantic capsules (design doc Phase 3). Deterministic capsules plus a re-read path dominate: no extra latency, no extra spend, no hallucination risk, no cache disruption. Revisit only if replay shows deterministic capsules measurably lossy.
- Emergency context shaping / pruning unseen results (design doc Phase 4). Agreed with the doc that this is a separate design; I would add that Pi's existing overflow-recovery compaction already covers the emergency case adequately.
- `stale` mode, unless Phase 0's cache simulation contradicts §5.

---

## 9. Bottom line

**Ship it — as a substantially smaller thing than the design doc describes.**

The design doc's analysis is right, its safety framework is right, and its central principle — *context is a projection of evidence, not the evidence itself* — is the correct thesis and worth keeping verbatim. But its implementation plan carries archive/recall/digest machinery that Pi's existing tools make unnecessary for two-thirds of real cases, ranks its two modes backwards on cache economics, and proposes an evaluation harness that costs more than the savings it validates.

The trimmed version — `context`-only projection, `read` + web allowlist, byte-stable capsules pointing at re-read paths, no recall tool, validated by offline replay over 322 sessions already on disk — captures most of the benefit, is a few hundred lines, and is the version I would actually build.

And the strongest reason to build it is the one the design doc buries: **pruning delays compaction without degrading compaction's input.** Trading a recoverable capsule for a lossy LLM summary is a quality win, not just a cost win.

---

## Appendix — reproducing the measurements

The §2 numbers come from an ad-hoc replay over `~/.pi/agent/sessions/**/*.jsonl` using the method in §2. Phase 0 should turn that into a committed, reviewable script so the numbers are reproducible and can be re-run as policy changes. Key parameters used: token estimate `chars / 4`; capsule size 600 chars; eligibility `future_requests − 1` (one full read preserved); sessions with < 5 assistant messages excluded; compaction **not** modelled (hence upper bound).
