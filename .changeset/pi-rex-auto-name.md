---
"@tian.zuo/pi-rex": minor
---

Name the Rex session and tab from the first prompt. The extension asks the current session model for one label, then runs `rex session rename` for the first tab and `rex window rename` for the current tab. The model call runs in the background, so the first response is not delayed. A hand-set label is kept. Set `rex.autoName` to `false` to turn automatic naming off. The `rex.renameTab` setting is removed.
