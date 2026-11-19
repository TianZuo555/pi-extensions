# pi-candy-eval

Ask Codex accounts a fixed reasoning puzzle through the [magpie](https://github.com/yetone/magpie) gateway, and keep the answers. A degraded upstream model shows up two ways: it gets the puzzle wrong, or it thinks far less than it used to.

There is no timer. The probe runs when you or the model ask for it, because pi starts background resources only after a session begins and a periodic probe is easy to leave running unnoticed.

## The puzzle

Three flavours, two shapes each, and the shapes can be told apart by touch:

|        | apple | peach | watermelon |
| ------ | ----- | ----- | ---------- |
| circle | 7     | 9     | 8          |
| star   | 7     | 6     | 4          |

The least number of sweets that guarantees a differently-shaped apple and peach pair is **21**, by taking 9 circles and 12 stars. **29** is the answer when the shapes cannot be felt: 7 circle-apple, 9 circle-peach, 8 circle-watermelon and 4 star-watermelon make 28 sweets with no apple or peach star. So 29 is a specific wrong answer that says the model ignored the one condition in the question.

## Install

```sh
pi install npm:@tian.zuo/pi-candy-eval
```

It needs magpie, signed in to at least one Codex account: only magpie can send a request to one named account.

```sh
magpie accounts codex        # what it can probe
magpie status                # the gateway address, 127.0.0.1:3425 by default
```

## Use

```
/candy              probe every switched-on Codex account now
/candy <email>      probe one account
/candy history      the last 10 runs, with the median reasoning tokens
```

The `candy_eval` tool does the same for the model, for questions like "is this account degraded?".

Each probe:

1. issues a ten-minute magpie gateway key held to that one account;
2. asks the puzzle at `PI_CANDY_EFFORT`, default `high`;
3. reads the answer from the reply's last line (`答案：N颗`), so a correct answer that also mentions 29 stays 21;
4. appends the run — answer, verdict, reasoning tokens, latency — to `~/.pi/candy-eval/runs.jsonl`.

## Reading the numbers

- `21` is a pass. Any other answer is a miss, and `29` is the blind-candy answer.
- Reasoning tokens vary about ±40% between runs of the same account at the same level. Compare the median of several runs, not one.
- The thinking level is a ceiling, not a floor: an easy puzzle is answered in similar time at `low` and at `high`. Change `PI_CANDY_EFFORT` only if you accept that earlier runs are no longer comparable.
- The puzzle is public, so a model may answer 21 from memory. A pass is weaker evidence than a miss.

## Environment

| Variable              | Default             | Meaning               |
| --------------------- | ------------------- | --------------------- |
| `PI_CANDY_MODEL`      | `codex/gpt-6.2-sol` | the model to ask      |
| `PI_CANDY_EFFORT`     | `high`              | its thinking level    |
| `PI_CANDY_GATEWAY`    | `magpie status`     | the gateway address   |
| `PI_CANDY_MAGPIE_BIN` | discovered          | the magpie executable |
| `PI_CANDY_STATE_DIR`  | `~/.pi/candy-eval`  | where the runs live   |

## Limits

- Only Codex accounts behind magpie: the probe needs a gateway key pinned to an account.
- Each run spends that account's allowance, like any other model call: about 5,400 input tokens, most of them the cached Codex system prompt.
- One run is not a verdict. Two misses in a row, or a reasoning count far under the account's median, are worth acting on.

## Try it locally

```sh
pnpm install
pnpm --filter @tian.zuo/pi-candy-eval check
pnpm --filter @tian.zuo/pi-candy-eval test
pi -e ./packages/pi-candy-eval
```
