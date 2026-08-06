# Phase 4 review — fixes required before Phase 5

Reviewer: primary agent. Status: **changes requested**. Do not start Phase 5 until these are green.

Scope: `lib/backend-herdr.ts`, `lib/herdr/*.ts`, `lib/report-file.ts`, `test/backend-herdr.test.ts`.
Everything below was verified empirically, not guessed. Fix in the order listed.

---

## B1 — CRITICAL: no Herdr run can exceed 30 seconds

`lib/herdr/cli.ts` `execHerdr` passes `timeout: timeoutMs ?? DEFAULT_TIMEOUT_MS` (30 000 ms) to
`execFile`. `promptAndWait` calls `herdrJson(promptArgs, self.cliOptions)` and `cliOptions` never
carries a `timeoutMs`, so the **`herdr` child process is SIGTERM'd after 30 s** while
`agent prompt --wait --timeout <input.timeoutMs>` is still legitimately waiting. The default run
timeout is 10 minutes (`DEFAULT_RUN_TIMEOUT_MS`), so effectively every real run dies at 30 s.

Verified `execFile` behaviour on kill:

```
err: { killed: true, signal: 'SIGTERM', code: null, msg: 'Command failed: ...' }
stdout: ""
```

That hits `if ("killed" in error && error.killed) reject(error)` → `Effect.tryPromise` catch →
a generic `HerdrCommandError` with message `"Command failed: …"`. So it is **not** mapped to
`timed_out` either; the run reports an opaque failure.

Required:
1. The subprocess timeout for a blocking call must always exceed the herdr-side `--timeout`.
   Pass an explicit per-call timeout: for `agent prompt --wait` and `agent wait`, use
   `input.timeoutMs + <grace>` (grace ≈ 15 s) so herdr's own deadline always fires first.
2. Add a distinct `HerdrTimeoutError` (or a `killed: true` flag on `HerdrCommandError`) so a
   killed subprocess is not indistinguishable from an arbitrary command failure, and map it to
   the `timedOut` branch in `promptAndWait`.
3. Add a test: a fake herdr that sleeps longer than the subprocess timeout must produce a
   timed-out output, not a generic failure.

## B2 — CRITICAL: `try/catch/finally` inside `Effect.gen` does not work

`runEffect` wraps its body in `try { … } catch (error) { … } finally { … }`. A `yield*` failure
is **not** a JavaScript throw. Verified:

```
A: outer:boom          # Effect.fail escaped the try/catch entirely
                       # "!! try/catch caught" never printed
                       # "!! finally ran"    never printed
```

(For contrast, a plain `throw` inside the same gen *is* caught — so the block is not obviously
dead on inspection, which is why this slipped through.)

Consequences, all live:
- The `catch (error)` branch — including `if (aborted) return self.cancelledOutput(...)` — is
  dead for every herdr CLI failure. Failures escape to the `Effect.catch` in `run()`, which calls
  `this.failOutput(input, message)` **with no paneId/workspaceId**, so the pane the user needs to
  inspect is not reported on the exact path where they need it most.
- The `finally` never runs → `input.signal.removeEventListener("abort", onAbort)` never happens →
  abort-listener leak on every failed run.
- `HerdrApiError.code` is flattened to a message string, losing the typed code.

Required: drop the `try/catch/finally` and express this with Effect combinators. Use
`Effect.onExit` (or `Effect.ensuring`) for the listener removal, and `Effect.catch` at the point
where paneId/workspaceId are still in scope so failure output keeps the herdr metadata. Do not
reintroduce `try/catch` around `yield*`.

## B3 — CRITICAL: transcript fallback destroys all indented output

`stripTranscriptChrome`'s regex is `/^[\s\u2500-\u257f\u2590-\u259f\u2550-\u256f]+.*$/gm`.
`\s` in the character class means **every line beginning with a space or tab is deleted** — code
blocks, nested bullets, wrapped JSON, everything an agent typically indents. Verified:

```
input:    "line one\n  indented content here\n\tTabbed\n── box ──\nplain"
stripped: "line one\n\n\n\nplain"
```

Required: remove `\s` from the class so only genuine box-drawing lines are dropped, e.g.
`/^[\u2500-\u257f\u2580-\u259f]+.*$/gm`. Add a test asserting an indented line survives.

## B4 — Blocked agents are reported as successful completions

Plan step 8 requires `blocked` to surface. Today, when the report file is missing/invalid **and**
`agentStatus === "blocked"`, `composeReport` returns `settled: true` with no marker, so the parent
sees a normal completion for an agent that is sitting on an approval prompt.

Also in `composeReport`: the `diagnostic` ternary's `blocked` and `else` branches are byte-identical
(`"structured report file"` twice), and `semanticReportFromFile` hardcodes that same string for the
valid branch — so the `agentStatus` argument is currently inert.

Required: when `agentStatus === "blocked"`, put that in the semantic report diagnostic and in
`reportText` so it is visible to the parent. Never auto-answer. Add a test.

## B5 — Cancellation cannot interrupt a running prompt

`promptAndWait` takes `aborted: boolean` **by value** and `onAbort` (unused). The only abort check
is `input.signal.aborted` between prompt attempts, but `agent prompt --wait` blocks for the whole
run, so an abort mid-prompt sends no `esc` and does nothing until the prompt returns.

Required: react to the abort signal while the prompt is in flight — send `esc` on the signal's
`abort` event and resolve the run as cancelled. Delete the dead `aborted` / `onAbort` parameters.

Related, flag-only (Phase 6, do **not** fix now): `SubagentSupervisor.cancelRun` only calls
`this.runs.cancel(...)`; nothing ever calls `backend.cancel(...)`, so `HerdrSubagentBackend.cancel`
is currently unreachable. Note it in the Phase 6 checklist.

## B6 — The empty-prompt guard is dead code

`buildInteractivePrompt` always appends the handoff block, so `composedPrompt.trim()` is never
empty and the `"composed Herdr prompt is empty"` branch is unreachable. The corresponding test
admits this in a comment and asserts almost nothing.

Required: guard the real precondition — reject when `task.trim()` is empty — and make the test
assert that specific error and that `herdr` was never invoked.

## B7 — Redundant `pane get` round-trip

`runEffect` issues `pane get <paneId>` solely to read `workspace_id`, but
`pane layout --current` already returns `layout.workspace_id`, which `currentLayout` discards.

Required: return `workspaceId` from `currentLayout` and delete the `pane get` call.

## B8 — `stripAnsi` only handles CSI

`/\u001b\[[0-?]*[ -/]*[@-~]/g` misses OSC sequences (`\u001b]…\u0007` / `…\u001b\\`), which
full-screen agents emit for titles. Extend the regex to cover OSC too, or use the `strip-ansi`
package if it is already reachable as a dependency (prefer the regex; do not add a dependency).

## B9 — Flaky suite: unhandled async EPIPE in `rpc-child.ts`

`npm test -w pi-tian-subagents` failed once with `write EPIPE` at `lib/rpc-child.ts:207`
(`supervisor-lifecycle.test.ts` → "clears pending delivery state on dispose"). Running that file
alone passes, and a direct `node --test test/*.test.ts` passed 110/110 — so it is load-dependent,
pre-existing, and not caused by Phase 4. It still makes CI unreliable.

Cause: `child.stdin?.write(...)` is wrapped in a synchronous `try/catch`, but EPIPE after the
child is killed on dispose arrives asynchronously and is unhandled.

Required: attach an `error` listener to `child.stdin` that rejects/ignores in-flight commands
instead of letting the error go unhandled.

## B10 — Test hygiene

`test/backend-herdr.test.ts`, last case, sets and deletes `process.env.FAKE_HERDR_RECORD_ARGS`
directly instead of through `withEnv`, so a failed assertion leaks the variable into later tests.
Route it through `withEnv`.

---

## Acceptance

- `npm run check -w pi-tian-subagents` clean.
- `npm test -w pi-tian-subagents` green **three consecutive runs** (B9 is a flake — one green run
  is not evidence).
- New tests exist for B1, B3, B4, B6.
- No `try/catch` around any `yield*` anywhere in the package.
- Constraints from `docs/herdr-refactor-plan.md` §"Constraints for the implementer" still hold:
  Effect v4 idioms, erasable syntax only, argv arrays never shell strings, no real `herdr`
  invocation in tests.
- Do not start Phase 5. Do not commit, push, or change branches.
