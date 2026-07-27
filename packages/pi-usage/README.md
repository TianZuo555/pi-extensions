# pi-tian-usage

Show **OpenAI Codex** and **GitHub Copilot** account usage from inside the
[pi coding agent](https://pi.dev).

`/usage` opens a menu with the current usage for both providers, and a compact
meter is shown in the footer whenever the active model belongs to a supported
provider.

```text
OpenAI Codex · Plus
  Weekly limit:     [████████████░░░░░░░░] 60% left · resets 14:20 on 27 Jul
GitHub Copilot · Business
  Premium credits:  [██████░░░░░░░░░░░░░░] 31% left · 7,787 / 25,000 credits
  Quota resets: 2026-08-01
```

Only metered quotas are shown. The unmetered `chat` and `completions` seat
buckets are omitted, and the premium bucket is labelled **Premium credits** on
credit-billed accounts (`token_based_billing`) and **Premium requests**
otherwise.

## Commands

- `/usage` — open the usage menu. A cancellable loading spinner is shown while
  the provider endpoints are queried (press `Esc` to cancel). Pick **Refresh**
  to re-query, **Close** to dismiss. In non-interactive modes it prints a
  one-line summary instead.

## Statusline

When the active model provider is Codex or Copilot, the footer shows a compact
Azure Blue meter such as `codex 60% wk`, `copilot 31% credits`, or
`copilot 49% premium`, refreshed at most every five minutes (results are cached
to avoid hammering the endpoints).

## How it works

Credentials are read from the same store pi writes, `~/.pi/agent/auth.json`:

| Provider | Endpoint | Token used |
|----------|----------|------------|
| OpenAI Codex | `https://chatgpt.com/backend-api/wham/usage` | ChatGPT OAuth **access** token (pi resolves/refreshes it via the model registry, falling back to `auth.json`) |
| GitHub Copilot | `https://api.github.com/copilot_internal/user` | GitHub OAuth token (the `refresh` credential pi stores for `github-copilot`) |

For Copilot, if pi has no stored credential the extension falls back to the
`GH_TOKEN` / `GITHUB_TOKEN` / `GITHUB_COPILOT_TOKEN` / `COPILOT_GITHUB_TOKEN`
environment variables and then to the VS Code Copilot credential file
(`~/.config/github-copilot/apps.json`).

Provider requests allow up to 30 seconds per attempt and retry one transient
network, timeout, rate-limit, or server failure. Simultaneous startup and
`/usage` checks share the same in-flight request so they cannot race an OAuth
refresh or duplicate a cold request. Recorded expired Codex tokens are never
sent to the endpoint when Pi cannot refresh them.

A provider that has no resolvable credential is shown as **Not configured** —
sign in with `/login` and select that provider.

## Install

```bash
pi install npm:pi-tian-usage
```

Try it without installing permanently:

```bash
pi -e npm:pi-tian-usage
```

## License

[MIT](./LICENSE) © Tian Zuo
