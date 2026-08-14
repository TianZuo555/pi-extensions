# pi-tian-web-search

Clean, lightweight web search and fetch tools for the [pi coding agent](https://pi.dev).

Supports **OpenAI Responses** (with simple, concise system instructions and automatic pi/Codex OAuth reuse), **Exa**, **Firecrawl**, and **Ollama** (local/cloud), plus built-in direct HTML-to-Markdown fetch fallback.

## Features

- **`web_search` Tool**: Queries live web sources and returns concise summaries with cited source links.
  - **OpenAI Responses (`/v1/responses` or Codex)**: Uses OpenAI's server-side web search with a simple, clean prompt. Reuses your active pi login (`openai-codex` or `openai`), or uses `OPENAI_API_KEY`.
  - **Exa**: High quality search results via `EXA_API_KEY`.
  - **Firecrawl**: Clean search output via `FIRECRAWL_API_KEY`.
  - **Ollama**: Local (`http://localhost:11434`) or cloud web search.
- **`web_fetch` Tool**: Reads web pages and documentation as clean Markdown.
  - Native scrapers for **Firecrawl** (`/v1/scrape`), **Exa** (`/contents`), and **Ollama** (`/api/web_fetch`).
  - **Direct Fetch Fallback**: High-performance HTML-to-Markdown extraction when no scraping key is provided.
- **`/web-search` (alias `/web-tools`) Command**: View provider statuses and switch active search/fetch backends interactively.

## Installation

```bash
pi install npm:pi-tian-web-search
```

Or try in a live session without installing:

```bash
pi -e ./packages/pi-web-search
```

## Configuration

Precedence: **Environment Variables** > **`~/.config/pi-tian-web-search/config.json`** > **`~/.pi/agent/auth.json` (Codex / OpenAI login)**.

### Environment Variables

| Variable | Description | Default |
| :--- | :--- | :--- |
| `OPENAI_API_KEY` | OpenAI API key or Codex JWT | Reused from Pi login if available |
| `OPENAI_BASE_URL` | Custom OpenAI Responses endpoint | `https://api.openai.com/v1/responses` |
| `OPENAI_SEARCH_MODEL` | Model for OpenAI Responses search | `gpt-5.6-luna` |
| `EXA_API_KEY` | Exa API key | - |
| `FIRECRAWL_API_KEY` | Firecrawl API key | - |
| `FIRECRAWL_BASE_URL` | Custom Firecrawl API URL | `https://api.firecrawl.dev/v1` |
| `OLLAMA_HOST` | Ollama host URL | `http://localhost:11434` |
| `OLLAMA_API_KEY` | Ollama API key (for cloud endpoints) | - |

### Slash Commands

- `/web-search` — View active providers and configuration status.
- `/web-search set search <openai|exa|firecrawl|ollama>` — Set active search provider.
- `/web-search set fetch <firecrawl|exa|ollama|direct>` — Set active fetch provider.
- `/web-search key <openai|exa|firecrawl> <key>` — Save API key in config.
- `/web-search ollama <url>` — Save custom Ollama host.

## License

MIT
