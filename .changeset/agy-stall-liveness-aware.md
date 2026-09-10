---
"@tian.zuo/pi-antigravity": patch
---

Stop killing long quiet tool steps as stalls. agy emits no stdout while a tool is ACTIVE, so a slow foreground command (a cold `cargo build`) was indistinguishable from a wedged process and died once `AGY_TOOL_STALL_TIMEOUT_MS` elapsed. The watchdog now asks for positive evidence before killing: when the tool budget expires it checks for a live process-group-leading child of the agy process and extends the budget while that evidence holds, bounded by a grace ceiling so tools that spawn nothing (`schedule`, `search_web`) still time out. Turns stalled between steps, where no tool is running, fail immediately as before without paying for the scan. Probes are epoch-fenced: if stream activity rearms the watchdog while a probe is in flight, that probe's verdict is discarded instead of killing a turn that has since resumed.
