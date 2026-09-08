---
"@tian.zuo/pi-find": patch
---

Fix root-relative glob matching without bypassing ignore rules, isolate grep from user ripgrep configuration, and report unexpected process termination as an error. Preserve unusual filenames with NUL-delimited find output and JSON-quoted display paths, and never surface partial records after a timeout kill. Normalize @ and home paths, reject explicit .git searches, retain empty-search timeout warnings, and document search limits. Add regression coverage for these behaviors and active cancellation.
