---
"@tian.zuo/pi-compact-output": minor
---

Support every Pi build whose TUI still exposes the prototype members the patch replaces — including Pi 1.x — by replacing the hand-maintained `0.83.x–0.87.x` version allowlist with a capability probe.

The allowlist had gone stale: it was last widened in 0.1.2 (pi 0.87.x) and never updated for pi 0.99, 1.2, or 1.3, so the extension silently installed in no-op mode and rendered nothing but a warning while the TUI internals it patches were unchanged. It was not caught because the test asserting the gate derived its expectation from the installed `VERSION`, so it passed for every version, and 29 other tests returned early when the patch failed to install. Those guards now assert installation instead of skipping, so a future incompatible Pi build fails the suite instead of disabling the extension quietly.

`isSupportedPiVersion` is removed; `installUiPatches()` reports incompatibility through `reason` when a required prototype member is missing.
