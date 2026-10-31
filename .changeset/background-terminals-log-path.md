---
"@tian.zuo/pi-background-terminals": minor
---

Remove `terminal_log_read`. A truncated result now gives the path of the full log file, and the model reads it with `read` or `grep`. A yielded result gives the log paths, so the model can check a server. In Code Mode, a truncated `output` adds `full_output_path` for stdout and `full_stderr_path` for stderr.

The log files now stay until the session ends, with a total limit of 256 MiB for stopped commands. Past the limit, the oldest files are deleted first.

Session data showed that the model read a truncated log in only 19 of 275 cases, ran the command again in 40 cases, and that 15 of 50 `terminal_log_read` calls failed.
