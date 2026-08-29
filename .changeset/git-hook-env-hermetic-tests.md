---
"@tian.zuo/pi-commit": patch
"@tian.zuo/pi-subagents": patch
"@tian.zuo/pi-repo-model": patch
"@tian.zuo/pi-repo-skills": patch
---

Make git-shelling tests immune to hook-exported `GIT_DIR`. git exports `GIT_DIR` (and `GIT_WORK_TREE`, `GIT_INDEX_FILE`, …) to hook subprocesses, and lefthook's pre-push passes that environment through to `pnpm test` — every git invocation in the tests then ignored its cwd and operated on the repository being pushed, committing fixtures onto the real branch, renaming it, and contaminating the shared repo config (`Pi Commit Test`). Test helpers and test processes now strip the redirecting variables so fixture repositories resolve from their working directories again.
