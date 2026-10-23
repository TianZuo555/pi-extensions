---
"@tian.zuo/pi-vscode-bridge": patch
---

Deprecate `@tian.zuo/pi-vscode-bridge`. The extension, its VS Code companion, and the `/vscode-connect` command are no longer recommended or actively developed. The source stays in the repository for reference, but the root package no longer loads it and CI no longer builds, tests, or packages it.

Remove it with `pi remove npm:@tian.zuo/pi-vscode-bridge` and `code --uninstall-extension tianzuo.pi-vscode-bridge`, then restart Pi or run `/reload`. No replacement extension is introduced.
