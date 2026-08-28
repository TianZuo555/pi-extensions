# @tian.zuo/pi-token-speed

Release notes: [changelog](https://github.com/TianZuo555/pi-extensions/blob/main/packages/pi-token-speed/CHANGELOG.md) · [GitHub releases](https://github.com/TianZuo555/pi-extensions/releases)

Live and final tokens-per-second reporting for the [pi coding agent](https://pi.dev).

```bash
pi install npm:@tian.zuo/pi-token-speed
```

## How it works

While the assistant streams, the footer shows a smoothed tokens-per-second
rate; when the message finishes it shows a summary with the average rate, total
output tokens, and time-to-first-token. The summary stays on screen after the
stream stops — including the model's between-stream thinking and tool-call
gaps — so the readout is always visible instead of blanking out whenever
generation pauses.

The live rate is sampled from streamed text (a responsive chars-per-token
estimate); the end-of-message average uses the provider's authoritative output
token count when available. The mode is remembered in
`~/.pi/token-speed/config.json`.

## Commands

- `/tps` — cycle the display mode: `live` → `final` → `off`.
- `/tps live` — live meter + summary.
- `/tps final` — summary only.
- `/tps off` — show nothing.

## License

[MIT](../../LICENSE) © Tian Zuo
