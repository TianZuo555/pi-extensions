---
"@tian.zuo/pi-background-terminals": patch
---

Force exit after the background-terminal test suite finishes and run test files serially. On Windows the test runner could linger for many minutes after all tests passed when a spawned shell handle outlived its test, and the serial run avoids the open Node test-runner race (nodejs/node#64833) where `--test-force-exit` with concurrency can drop verdicts.
