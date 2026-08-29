---
"@tian.zuo/pi-antigravity": minor
---

Register the pi-tool bridge only while an Antigravity model is selected: `pi-bridge-<pid>` is created when an agy model is first selected (including session start on one) and deregistered — with its manifest cache evicted — when switching to any other model or shutting down. Sessions that never use Antigravity models no longer run a bridge server or touch agy at all.
