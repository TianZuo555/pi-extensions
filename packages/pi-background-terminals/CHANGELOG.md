# @tian.zuo/pi-background-terminals

## 0.5.2

### Patch Changes

- [#18](https://github.com/TianZuo555/pi-extensions/pull/18) [`da8a245`](https://github.com/TianZuo555/pi-extensions/commit/da8a24508455894eacee56df69f71c9ce67e93bd) Thanks [@Alx8g](https://github.com/Alx8g)! - Batch background terminals that finish close together into one bounded completion follow-up while preserving exactly-once delivery and the existing singleton message shape.

- [#20](https://github.com/TianZuo555/pi-extensions/pull/20) [`a45525c`](https://github.com/TianZuo555/pi-extensions/commit/a45525c4f64c0fec5e054366c4d0ffa4f37df2cd) Thanks [@Alx8g](https://github.com/Alx8g)! - Preserve the full quiet window for arrivals that follow a busy-held expiry, keep the maximum hold fixed, and charge truncation markers to the strict aggregate completion budget.

## 0.5.1

### Patch Changes

- [#7](https://github.com/TianZuo555/pi-extensions/pull/7) [`c160eaa`](https://github.com/TianZuo555/pi-extensions/commit/c160eaac7ba17055d8324f3e609e036d189bf66a) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Force exit after the background-terminal test suite finishes and run test files serially. On Windows the test runner could linger for many minutes after all tests passed when a spawned shell handle outlived its test, and the serial run avoids the open Node test-runner race (nodejs/node#64833) where `--test-force-exit` with concurrency can drop verdicts.

- [#10](https://github.com/TianZuo555/pi-extensions/pull/10) [`21e8e95`](https://github.com/TianZuo555/pi-extensions/commit/21e8e95d62fdc8b9befb00df841658888d02b066) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Create a dedicated Windows Job Object before starting each background terminal, then use a pre-shell launcher to join the job before the requested Bash process can run. Closing the manager-owned `KILL_ON_JOB_CLOSE` handle now reaps the complete tree—including descendants re-parented after the shell exits—without a post-spawn assignment race. A startup probe preserves direct-spawn/taskkill fallback on hosts whose outer Job Object forbids nesting.

- [#4](https://github.com/TianZuo555/pi-extensions/pull/4) [`5a678c5`](https://github.com/TianZuo555/pi-extensions/commit/5a678c5d43a47f7cfbf18eec104e9f8daf40001b) Thanks [@nzalexgarciagil-ctrl](https://github.com/nzalexgarciagil-ctrl)! - Force-kill Windows process trees atomically so timeouts cannot leave detached descendants running.

## 0.5.0

- Changelog tracking was introduced after this release.
