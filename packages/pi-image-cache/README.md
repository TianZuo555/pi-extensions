# @tian.zuo/pi-image-cache

Release notes: [changelog](https://github.com/TianZuo555/pi-extensions/blob/main/packages/pi-image-cache/CHANGELOG.md) · [GitHub releases](https://github.com/TianZuo555/pi-extensions/releases)

Temporary pasted-image caching with compact placeholders for the [pi coding agent](https://pi.dev).

```bash
pi install npm:@tian.zuo/pi-image-cache
```

## How it works

Caches pasted images so they survive as compact `[Image#NNN]` placeholders and
are re-attached to the model on send.

On macOS, `Ctrl+V` pastes the clipboard image directly — both raw image data
(screenshots, "Copy Image") and image files copied in Finder, including
multiple files at once. File references win over pasteboard image data,
because Finder also puts a generic 1024×1024 document icon on the clipboard
next to the file it copied.

The cache lives under `~/.pi/agent/cache/image-cache/` with a 24h TTL,
alongside a small PNG rendition per non-PNG image so inline previews work in
Kitty-protocol terminals (Ghostty, Kitty, WezTerm) and after a session resume.

## Commands

- `Ctrl+V` — paste a clipboard image (macOS).
- `/images` — list cached images.
- `/image-cache-clear` — clear the cache.

## License

[MIT](../../LICENSE) © Tian Zuo
