# Proposal: tool-result pruning for Pi

**Status:** design and experiment plan only; no implementation has started.

**Proposed package:** `@tian.zuo/pi-tool-prune` (`packages/pi-tool-prune/` when approved)

**Verified against:** Pi `0.80.10` extension, session, and compaction APIs; Maka's public runtime implementation and published Terminal-Bench report.

## Short version

The idea is valid, but the strongest version of the claim is not.

Large tool results are frequently low-value **after** the model has consumed them once, and repeatedly sending them can waste context, money, and attention. Selective pruning is therefore a promising agent-runtime optimization.

However, an API model has no durable latent memory between requests. Information survives only if it remains in messages, is encoded in later assistant output, is recoverable from the environment, or is stored in an external archive. A later assistant message is often a useful semantic distillation, but it is not guaranteed to preserve exact facts from the tool result.

The safe design is therefore not “delete old tool results.” It is:

> Keep the original session evidence, project a deterministic compact capsule into later model requests, and provide bounded on-demand recall.

Pi is a very good host for this mechanism because its `context` event can non-destructively rewrite a deep copy of messages before every model call. The stored session and TUI can retain the original result. Pi alone is not a scientific evaluation harness; a paired runner and task verifier are still needed to establish quality and economy effects.

## Verdict on the proposed explanations

| Claim | Assessment |
|---|---|
| Tool results are distilled into the next assistant message | **Often true, not guaranteed.** The next assistant message may contain a useful conclusion, tool arguments, or reasoning. It may also contain only another tool call and omit exact code, identifiers, values, or errors needed later. |
| Long-context attention is sparse and tool results are ignored | **Directionally plausible, overstated.** *Lost in the Middle* showed position-dependent task performance, often worse when relevant information is in the middle. It did not prove that tool-result messages are generally unread or establish a tool-specific attention law. Recent tool results are also commonly near the end, not the middle. |
| The decision point has passed after several steps | **Often true, not universally.** Old logs and search listings lose marginal value quickly. Source code, stack traces, API schemas, exact test failures, and user-selected values are often revisited. |
| “Information's true carrier is understanding, not the original” | **Too strong.** The carrier can be assistant text, tool-call arguments, a changed file, the current repository, a compact summary, or the original result. The harness must know which carrier remains available. |

The more defensible theory is **declining marginal utility plus recoverability**:

1. A tool result has high value for the first decision that follows it.
2. Its average value falls as later decisions and environment changes accumulate.
3. Re-sending the full result has a recurring cost on every subsequent request.
4. A small identity-bearing capsule plus explicit recall can preserve option value at much lower steady-state cost.

## What Maka actually does

The public Maka implementation is more careful than the post's simplified description.

### Active pruning

Maka's active policy:

- targets current-turn tool-result payloads larger than an estimated 2,048 tokens by default;
- protects the newest completed tool step so the model gets one request with the exact output;
- prunes an older completed step only after the model has had a request in which to consume it;
- archives the exact serialized result;
- replaces it with a typed placeholder containing tool identity, size, hash, archive reference, and read instructions;
- fails open: if archival fails, the full result remains;
- does not mutate the persisted source history.

This is **read once, then archive**, not unconditional deletion.

### Stale pruning

Maka separately prunes oversized tool results from older turns while preserving recent turns. It also archives before replacement and supports retrieval.

### Semantic summaries are separate

The active and stale placeholders are not themselves semantic “key summaries.” Maka has separate semantic-compaction machinery, but its published Terminal-Bench comparison explicitly ran with semantic compaction off. The observed economy there came from representation replacement, not an LLM-generated summary of each result.

### What the public benchmark establishes

The public Terminal-Bench 2.1 report says:

- active pruning fired in 21 of 57 completed Maka cells;
- 576 rewrites avoided an estimated 1.87M tokens of repeated input;
- pass rates among completed cells with and without prune diagnostics were nearly tied;
- stale pruning recorded zero events;
- there was no prune-off control, so the report explicitly does **not** estimate pruning's causal score effect.

The same report compares different product harnesses. System prompts, tool surfaces, shell behavior, and completion contracts also differ. It supports “the policy was live and saved projected input,” not “pruning alone was lossless.”

I could not verify the post's exact MIPS figures — 38% total tokens and 2.7× output — from the public repository. The repository names local MIPS and OpenCode trace artifacts, but those raw traces are not committed. The public full-run report has different aggregate ratios: 43.96M vs 47.77M total tokens and 1.86M vs 1.16M output tokens. The post may refer to a different private or single-task run.

## Why Pi is a good host

Pi exposes the right seam:

```text
stored session messages
        |
        v
context event -- deep-copy projection before every LLM call
        |
        v
provider serialization and request
```

The `context` handler can return modified messages without changing the session file. This gives the extension four important properties:

1. **Evidence remains intact.** The TUI, session tree, export, and debugging record keep the original result.
2. **The first read can remain exact.** Only later projections are compacted.
3. **The mechanism is provider-independent.** It operates on Pi `AgentMessage` values before provider-specific serialization.
4. **Recall can use the existing session.** Pi already stores the original tool result, so a second archive copy is unnecessary in the first design.

The extension should **not** use `tool_result` to implement pruning. That hook runs before the result is persisted and before the next model response; changing it there would prevent the model from seeing the original once and would replace the durable evidence.

The extension should also avoid `before_provider_request` for its primary rewrite. That payload is provider-specific, harder to type safely, and too late to preserve one common policy across providers.

### Pi is not the whole evaluation harness

Pi provides the mechanism, session ledger, lifecycle events, and usage records. It does not by itself provide:

- identical clean workspaces for paired runs;
- benchmark task selection and randomization;
- deterministic verifiers;
- repeated trials;
- statistical comparison;
- protection against provider-throughput drift.

A separate batch runner is needed for credible A/B results.

## Goals

1. Reduce repeated provider-visible tool-result tokens.
2. Preserve exact original results in Pi's session history.
3. Guarantee at least one successful model request sees each result in full.
4. Preserve assistant/tool-result protocol pairing.
5. Make every compacted result recoverable on demand.
6. Fail open whenever eligibility or recoverability is uncertain.
7. Keep the projected replacement deterministic and cache-stable.
8. Measure savings, cache effects, recalls, rereads, quality, and failures.
9. Allow observe-only, conservative, and aggressive policies to be compared.

## Non-goals

The first implementation should not:

- call another LLM to summarize every tool result;
- mutate or delete session entries;
- replace Pi's normal compaction system;
- claim that an assistant message is a complete memory;
- prune images or multimodal results;
- prune the newest unseen tool-result batch;
- hide errors, permission decisions, or user answers;
- enable aggressive pruning globally without an observe-only rollout;
- claim token reduction and cost reduction are identical.

## Core design

### 1. Projection, not history mutation

The extension operates only in `pi.on("context", ...)`.

For every provider-bound context, it identifies eligible `toolResult` messages and replaces only their `content`. It preserves:

- message role;
- `toolCallId`;
- `toolName`;
- `isError`;
- timestamp and protocol ordering;
- the corresponding assistant tool call.

The original `ToolResultMessage` remains in `ctx.sessionManager` and the session JSONL.

### 2. Read-once eligibility

A result is not eligible merely because it is large.

The minimum proof that it crossed a successful model boundary is a later assistant message whose stop reason is `toolUse` or `stop`. Messages ending in `length`, `error`, or `aborted` do not count initially. A result in the newest completed tool batch remains full.

Conceptually:

```text
assistant calls tool A
result A                   <- full on the next request
assistant consumes A and calls tool B
result B                   <- full; A may now be compacted
assistant consumes B ...
```

This mirrors the key safety property in Maka's active pruning.

A conservative policy can require two later successful assistant messages or a later user turn before eligibility.

### 3. Deterministic capsules

The first version should generate a deterministic **capsule**, not an LLM summary.

A capsule contains:

- a stable compacted-result id;
- tool name and tool-call id;
- relevant tool arguments when safely available, such as path, range, query, or command;
- success/error state;
- original text block and byte counts;
- SHA-256 of the canonical original content;
- a small tool-specific excerpt when policy allows it;
- an explicit instruction for exact recall.

Example shape:

```text
[Older tool result compacted after one successful later assistant step]
id: tr_8f31c0
tool: read
source: src/auth/service.ts, lines 1-400
original: 9,240 estimated tokens, sha256: ...
kept: deterministic head/tail excerpt
Exact content remains in the Pi session. Use recall_tool_result with id tr_8f31c0.
```

The wording and serialization must be stable. A result should not acquire a different capsule on every request.

### 4. On-demand recall

The extension registers one small model-facing tool, `recall_tool_result`.

The tool accepts a compacted-result id plus optional offset/limit. It:

1. resolves the id only within the current session and active branch;
2. finds the original tool result in session entries;
3. verifies the stored digest;
4. returns a bounded text slice with continuation metadata;
5. records a recall diagnostic.

The tool must never return an unbounded payload. A recalled chunk receives normal read-once protection and can later be compacted like any other large result.

Using the session as the source of truth avoids duplicating potentially sensitive tool output under another storage root. If Pi later changes session retention semantics, a private archive can be added with Maka's fail-open discipline.

### 5. Tool-specific capsule policies

Different outputs should not share one naïve truncation rule.

| Tool/result type | Initial policy |
|---|---|
| `bash` success | Keep command, exit status, size, and bounded tail; full result recallable |
| `bash` error | Protect longer; keep bounded head and tail around error output |
| `read` | Keep path/range, size/hash, small head and tail; exact recall available |
| `grep` / `find` | Keep query, match count if derivable, paths, and bounded top results |
| `write` / `edit` | Usually too small; do not target initially |
| user-interaction tools | Never prune initially |
| custom tools | Observe only unless explicitly allowlisted |
| image-containing results | Never prune initially |
| recall tool results | Protect the newest recalled chunk; never recursively erase before one read |

Tool allowlists are safer than trying to infer semantics for every custom tool.

### 6. Error handling

The default should retain error results longer than successful results. Exact failures are frequently needed across several repair steps.

Initial recommendation:

- successful result: eligible after one later successful assistant message in aggressive mode;
- error result: eligible only after two later successful assistant messages or a later user turn;
- aborted/cancelled tool result: never prune in the first version;
- unknown result shape: observe only.

### 7. Interaction with Pi compaction

This extension and Pi compaction solve different problems:

- tool-result pruning removes repeated low-value payloads from ordinary provider requests;
- Pi compaction summarizes an older conversation span when total context approaches its limit.

Pi already truncates tool results to 2,000 characters when serializing a compaction request. The initial extension should leave compaction enabled and should not override `session_before_compact`.

After compaction, old tool results may no longer appear in active model context, but the original session entries remain available for audit. Recall after a compaction must be tested explicitly before being promised as a hard guarantee.

### 8. Prompt caching

Pruning can help or hurt provider caching.

Replacing an old full result changes the prompt prefix once, potentially invalidating cache entries after that point. Once the deterministic capsule is stable, later calls can reuse the shorter prefix. The net result depends on provider cache boundaries, pricing, and turn shape.

Therefore telemetry must keep these distinct:

- logical input tokens;
- cache-read tokens;
- cache-write tokens;
- uncached input tokens;
- output tokens;
- estimated projected tokens avoided;
- actual monetary cost when provider pricing is available.

A 95% cache hit rate changes economics, but it does not by itself prove that fewer logical tokens were sent. “Token savings” and “cost savings” must not be conflated.

## Policy modes

The package should expose four modes.

| Mode | Behavior | Purpose |
|---|---|---|
| `off` | No analysis or rewrite | Control arm |
| `observe` | Compute eligibility and estimated savings; send full context | Safe shadow rollout |
| `stale` | Compact only results outside the protected recent user turns | Conservative production arm |
| `active` | Read-once compaction within a long tool loop | Maka-style aggressive experiment |

### Recommended initial defaults

For development and first release:

- mode: `observe`;
- minimum result size: 8,192 estimated tokens;
- protected recent user turns: 1;
- protected later assistant steps: 1 for success, 2 for errors;
- custom tools: deny-by-default;
- images: never;
- capsule target: at most 512 estimated tokens;
- exact recall: enabled and bounded.

Maka's 2,048-token threshold should be an explicit aggressive profile, not Pi's unvalidated default.

After the paired evaluation passes its gates, `stale` could become the recommended mode. `active` should remain opt-in until enough long-loop tasks show no material quality regression.

## User and operator controls

Proposed commands:

- `/tool-prune status` — mode, eligibility, projected savings, recalls, and recent decisions;
- `/tool-prune off|observe|stale|active` — session-local mode change;
- `/tool-prune explain <id>` — show why a result was or was not eligible;
- `/tool-prune report` — write a machine-readable session report.

A compact status indicator can show:

```text
prune: observe · 6 eligible · ~42k/request
```

Configuration should support global defaults and trusted project overrides. Project configuration must be ignored until `ctx.isProjectTrusted()` is true.

## Telemetry

Every provider projection should produce a non-context diagnostic record containing:

- session id and model identity;
- mode and policy version;
- request sequence number;
- result id, tool name, and eligibility reason;
- original/capsule character and token estimates;
- whether a rewrite occurred;
- whether the result was recalled later;
- assistant usage for the resulting request when available;
- cache read/write/input/output usage;
- compaction or overflow events near the request;
- errors and fail-open reasons.

Session aggregates should include:

- unique results compacted;
- rewrite applications across repeated requests;
- estimated cumulative input avoided;
- recall count and recalled tokens;
- rereads/re-executions of the same command or path when detectable;
- context overflows and automatic compactions;
- model calls, tool calls, wall time, tokens, and cost.

Estimated avoided tokens are a counterfactual projection, not provider billing evidence. Reports must label them accordingly.

## Safety invariants

1. A tool result is sent in full on at least one successful model request before active pruning.
2. The newest completed tool-result batch remains full unless an explicit emergency-overflow policy is separately designed.
3. Session entries are never mutated or deleted by the extension.
4. Assistant tool calls and tool-result protocol pairs are never removed or reordered.
5. Only `content` is replaced; tool identity and error state survive.
6. Every replacement is deterministic for the same policy and original digest.
7. Every compacted result has an exact current-session source and bounded recall path.
8. If eligibility, source lookup, digest verification, or recall safety is uncertain, keep the full result.
9. Images, user answers, and non-allowlisted custom-tool results are not pruned initially.
10. Observe mode and on mode make identical eligibility decisions; only on mode rewrites.
11. Diagnostics do not enter model context.
12. A project cannot silently enable a more aggressive policy before project trust.
13. Pruning never claims success or changes tool error semantics.
14. A cache or token estimate is never presented as actual billed savings.

## Evaluation plan

### Question hierarchy

The experiment should answer these questions in order:

1. **Activation:** Does the policy target a meaningful amount of repeated input?
2. **Recoverability:** Can the model recall exact old data when needed?
3. **Quality:** Does verifier success remain within the accepted non-inferiority margin?
4. **Behavior:** Does pruning increase rereads, repeated tool calls, or repair loops?
5. **Economy:** Does it reduce logical input, uncached input, latency, and cost after cache effects?
6. **Robustness:** Does the result hold across models, task types, and long-turn versus multi-turn sessions?

### Arms

Run at least these paired arms:

| Arm | Policy |
|---|---|
| A | Off |
| B | Observe only; validates accounting against A without changing prompts |
| C | Stale pruning, 8k threshold, one recent user turn protected |
| D | Active read-once pruning, 8k threshold |
| E | Aggressive Maka-style active pruning, 2k threshold |

Observe and off should have identical model-visible messages. Any systematic quality difference between them indicates harness drift or an extension side effect.

### Workloads

Use a mixed suite rather than one MIPS task:

- large-file inspection and cross-file refactoring;
- test failure diagnosis with long logs;
- search-heavy repository exploration;
- structured JSON/API inspection;
- long-running coding tasks with many tool steps;
- multi-turn interactive follow-ups that revisit earlier evidence;
- adversarial tasks where an exact old identifier or value is needed late;
- tasks where a previous error message becomes relevant after several repairs.

At least one suite should have deterministic tests or an external verifier. Human preference alone is too noisy for the primary quality gate.

### Harness controls

For each paired cell:

- use the same Pi version, extension set, model, thinking level, system prompt, tools, task text, and timeout;
- start from identical clean worktrees or snapshots;
- randomize arm order;
- avoid concurrent arms sharing a throttled provider account unless concurrency is deliberately paired;
- record provider errors and deadline kills separately from task failures;
- use multiple repetitions for stochastic models;
- retain raw session JSONL, verifier output, and usage artifacts;
- make the prune mode the only intended runtime-policy difference.

A product-harness comparison such as Maka versus OpenCode is useful operationally but cannot isolate pruning.

### Primary metrics

- verifier pass/fail or task reward;
- matched quality delta and confidence interval;
- total input, cache-read, cache-write, uncached input, and output tokens;
- actual provider cost where known;
- wall time and first-token latency;
- model-call and tool-call counts;
- recall rate;
- repeated reads/commands after a prune;
- automatic compactions and context overflows;
- completion and deadline rates.

### Initial acceptance gates

A reasonable first gate:

- no more than a 2 percentage-point absolute pass-rate regression on the paired suite, with uncertainty reported;
- zero unrecoverable compacted results;
- zero protocol-invalid provider requests;
- at least 20% median logical-input reduction on tasks where the policy activates;
- no more than 10% increase in tool calls or wall time;
- recalls succeed in at least 99% of valid requests;
- all fail-open paths preserve the original context.

These are engineering gates, not claims of statistical equivalence. The suite size must be large enough to make the quality interval useful.

## Test strategy

Before live model evaluation, use deterministic fixtures for the projection engine:

- one result with no later assistant message: not eligible;
- provider error after a result: not counted as a successful read;
- one later successful assistant step: eligible only in active mode;
- newest parallel result batch: protected together;
- old user turn: eligible in stale mode;
- assistant/tool-result pairing preserved exactly;
- text plus image result: skipped;
- error result protected longer;
- custom tool skipped without allowlist;
- capsule stable across repeated projections;
- digest mismatch: fail open;
- recall before and after session reload;
- recall after branch navigation and compaction;
- observe and active modes produce identical decision telemetry;
- only active mode changes content;
- multiple context extensions chain without mutating shared input;
- unusual Unicode and very large outputs remain bounded.

Then run a mock-provider A/B where the exact outgoing messages and token estimates are ground truth. Live provider runs come last.

## Rollout phases

### Phase 0 — document and shadow model

- approve terminology and invariants;
- define deterministic eligibility and capsule format;
- define telemetry schema;
- run `observe` locally without changing prompts.

**Exit:** accounting is stable and identifies meaningful repeated input in real Pi sessions.

### Phase 1 — conservative stale pruning

- context projection only;
- built-in tool allowlist;
- original session as source of truth;
- bounded recall tool;
- commands and report;
- stale mode only for production use.

**Exit:** deterministic tests pass and stale A/B meets the quality and recoverability gates.

### Phase 2 — active read-once pruning

- add successful-provider-boundary tracking;
- protect newest parallel batch;
- longer error retention;
- run paired long-tool-loop evaluation.

**Exit:** active A/B meets non-inferiority and economy gates across more than one model family.

### Phase 3 — optional semantic capsules

Only consider a summarizer after deterministic capsules are validated. Measure the nested model's token cost, latency, hallucinations, and cache disruption against simple capsules. A semantic summary must supplement source identity and recall, never replace them.

### Phase 4 — emergency context shaping

A separate design may allow pruning an unseen newest result to avoid overflow. That changes the read-once invariant and requires stronger extraction or chunked first delivery. It must not be smuggled into normal active mode.

## Open questions

1. Should recall search only the active branch or allow an explicit branch/session id?
2. Can Pi's current `SessionManager` reliably recover pre-compaction original messages in every session format and fork path?
3. Which assistant stop reasons count as proof of a successful read for every provider?
4. Should reasoning/thinking content count as semantic distillation when providers omit or encrypt it on replay?
5. What default excerpt is least harmful for source reads: head/tail, symbol-aware lines, or no excerpt?
6. How should extension order affect projection and telemetry when other extensions also modify `context`?
7. Does active rewriting improve or degrade actual cache economics on the user's main providers?
8. Should result ids be derived from tool-call id plus digest or be random session-local handles?
9. What is the smallest model-facing recall schema that still produces reliable recovery behavior?

## Recommendation

Proceed, but treat it as an empirical context-projection feature, not as proof that tool results are unimportant.

Pi is an excellent implementation harness because it already separates durable session history from provider-visible context. The best first product is an observe-only extension followed by conservative stale pruning. The aggressive Maka-style mode should be implemented only after the deterministic capsule, bounded recall, fail-open behavior, and paired A/B runner exist.

The central design principle should be:

> Context is a projection of evidence, not the evidence itself.

That is stronger and safer than “information is understanding, not the original”: it permits aggressive context economy while keeping exact source material available whenever the agent's later understanding proves incomplete.

## References

- Maka repository and architecture: <https://github.com/maka-agent/maka-agent>
- Maka active tool-result pruning implementation: <https://github.com/maka-agent/maka-agent/blob/main/packages/runtime/src/active-tool-result-prune.ts>
- Maka stale archive/pruning implementation: <https://github.com/maka-agent/maka-agent/blob/main/packages/runtime/src/tool-result-archive.ts>
- Maka Terminal-Bench 2.1 report: <https://github.com/maka-agent/maka-agent/blob/main/docs/eval/terminal-bench-2.1-maka-vs-kimi-code-v11.md>
- *Lost in the Middle: How Language Models Use Long Contexts*: <https://arxiv.org/abs/2307.03172>
- Pi extension docs verified locally at version 0.80.10: `docs/extensions.md`
- Pi session format docs verified locally at version 0.80.10: `docs/session-format.md`
- Pi compaction docs verified locally at version 0.80.10: `docs/compaction.md`
