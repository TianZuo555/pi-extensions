---
"@tian.zuo/pi-antigravity": patch
"@tian.zuo/pi-background-terminals": patch
"@tian.zuo/pi-commit": patch
"@tian.zuo/pi-find": patch
"@tian.zuo/pi-goal": patch
"@tian.zuo/pi-image-cache": patch
"@tian.zuo/pi-repo-model": patch
"@tian.zuo/pi-repo-skills": patch
"@tian.zuo/pi-subagents": patch
"@tian.zuo/pi-todo": patch
"@tian.zuo/pi-token-speed": patch
"@tian.zuo/pi-usage": patch
"@tian.zuo/pi-web-search": patch
---

Move the runtime dependency to `effect@4.0.5` (from the `4.0.0-rc.117` release candidate), so installing this extension no longer pulls a pre-release Effect. `pi-usage` also picks up `playwriter@0.9.0` and `pi-web-search` `unpdf@1.9.1`. No API changes on the extension surface.
