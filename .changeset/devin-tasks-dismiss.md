---
"@tian.zuo/pi-devin-acp": patch
---

`/devin-tasks` no longer strands dead ops forever. Devin emits a tool call's terminal update right after a turn is cancelled — exactly while the superseded turn's listener generation is stale — and those updates were dropped entirely, leaving completed execs listed as running. Session-scoped op tracking now survives supersession (only delivery into the turn stream stays generation-gated), and an unexpected `devin acp` process exit drops the tracked ops it owned. For entries already stranded, `d` in `/devin-tasks` (dashboard and detail view, plus a confirm in the non-TUI picker) removes an op from the list without messaging Devin; an op that is genuinely still running re-adds itself on its next update.
