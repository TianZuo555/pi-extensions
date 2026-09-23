# pi-find

Release notes: [changelog](https://github.com/TianZuo555/pi-extensions/blob/main/packages/pi-find/CHANGELOG.md) · [GitHub releases](https://github.com/TianZuo555/pi-extensions/releases)

Simple, bounded `grep` and `find` tools for the [pi coding agent](https://pi.dev),
backed by ripgrep and fd.

The extension reuses pi's built-in tool names, so the model sees one search
surface instead of competing built-in and extension tools.

## highlight 

Minimal description and tool schemas for saving context

## Tools

### `grep`

```text
grep(pattern, path?, glob?, output?, literal?)
```

- `pattern` is a case-sensitive ripgrep regular expression; prefix `(?i)` to
  ignore case. Set `literal: true` to search exact text instead, without
  escaping metacharacters.
- `path` is one file or directory and defaults to the current directory.
- `glob` optionally limits file names, for example `*.ts` or `**/*.test.ts`.
- `output` is `"content"` (default) or `"files"`. File mode uses `rg -l` to
  return unique paths without collecting every matching line in each file.
- A complete content search with **1–3 matching lines** automatically includes
  up to **5 lines before and after** each match; there is no context parameter.
  For a wider window, `read` the file at the reported line.

```jsonc
{ "pattern": "TODO|FIXME", "path": "src", "glob": "*.ts" }
{ "pattern": "registerTool(", "literal": true, "output": "files" }
{ "pattern": "SearchRuntime", "path": "src" }
```

Content is grouped by file, with `:` for matching lines and `-` for context:

```text
1 match in 1 file

src/main.ts
11- // Register the tool
12: pi.registerTool(tool);
13- }
```

Overlapping context windows are merged and context is not counted as matches.
Automatic context is collected in the same search, not by rereading files. It
is omitted for incomplete searches (limits, timeout, or skipped records) or if
it would exceed the output budget, so it never crowds out the matching lines.

### `find`

```text
find(pattern, path?)
```

- `pattern` is a case-insensitive file glob, for example `*.ts` or `**/*.test.ts`.
- `path` is one directory and defaults to the current directory.

```jsonc
{ "pattern": "**/*.test.ts", "path": "packages" }
```

## Search behavior

- Both tools respect `.gitignore` and always skip `.git`. Explicit `.git`
  roots, files inside them, and symlink aliases to them are rejected.
- Globs without `/` match basenames at any depth. Globs containing `/` match
  **only relative to the search directory** (or the parent of an explicit
  grep file), never also relative to cwd. For example, `{ "path": "src",
  "pattern": "deep/*.ts" }` finds direct children of `src/deep`, whereas
  `{ "path": "src", "pattern": "src/*.ts" }` searches `src/src`.
  From cwd, `src/*.ts` matches direct children of `src` and `src/**/*.ts`
  includes descendants. Use `/` in globs on every platform.
  Glob filtering never re-includes ignored files. When an empty result comes
  from a glob that repeats the path, the hint names the corrected glob, for
  example `[Glob "src/**/*.ts" is relative to path "src"; try "**/*.ts".]`.
- A leading `!` excludes instead of includes, like ripgrep's own `--glob`: for
  example `glob: "!*.test.ts"` or `pattern: "!**/*.generated.ts"`.
- A leading `@` is stripped from input paths; `~` and `~/...` expand to the
  home directory. Ripgrep user configuration is ignored so it cannot change
  the tool's case sensitivity or ignore behavior.
- Hidden files and directories are not searched by default. An explicitly
  named hidden path still works, for example `path: ".github"`. A glob such
  as `.github/**/*.yml` alone does not enable hidden traversal; use
  `{ "path": ".github", "pattern": "*.yml" }`. Empty default searches include
  this hint; it is omitted when the path is already hidden or names a file.
- Grep returns up to 100 matching lines or 200 files; find returns up to 200
  files. One extra result distinguishes overflow from an exact fit, then the
  process is stopped. Partial results are labelled, and summary counts refer
  to the results actually displayed, not an assumed total.
- Returned files are sorted by path, and content within each file by line.
  This sorts the collected batch, not the whole search before limiting;
  truncated batches are not guaranteed to contain the globally first paths.
- Grep skips files larger than 4 MiB during directory traversal. Explicitly
  named files follow ripgrep's explicit-file behavior and can exceed that limit.
- Grep lines longer than 400 UTF-16 code units are clipped around the first
  match, keeping late matches visible without splitting surrogate pairs.
  Context lines are clipped from the start. Ellipses mark omitted text.
- A single match or path record larger than 8 MiB is skipped instead of being
  buffered, and the result says so. Explicitly named files bypass
  ripgrep's traversal size cap, so this is what keeps a search of a
  single-line bundle, sourcemap, or lockfile from ballooning memory.
- Search output also has a hard byte limit, and running searches are
  cancellable.
- Relative result paths can be passed directly to pi's `read` and `edit` tools.
  Paths containing control characters, backslashes, or quotes are JSON-quoted;
  decode the JSON string before using them. Newlines in filenames do not create
  extra find results.
- Timeouts are marked as partial, including when no results were gathered.
  Unexpected process termination is an error, not a completed empty search.
- Directories that cannot be read (for example, permission denied) are
  skipped. The rest is still searched, and the result is marked partial and
  names the first unreadable path. A regex or glob syntax error is still an
  error.

For uncommon searches involving several roots, complex exclusions, multiline
matching, counts, global sorting, pagination, or pipelines, use `rg` or `fd`
through the shell rather than expanding these tool schemas.

## Hidden files and secrets

Default searches do not walk hidden paths. This reduces accidental exposure of
files such as `.env`, `.npmrc`, and private keys in model-visible tool output.
It is not a complete secret boundary: explicitly named files, ordinary tracked
files, `read`, and shell tools can still expose secrets. Strong secret isolation
must be enforced across every filesystem tool, not only grep.

## Debug logging

Off by default: nothing is recorded unless you set `PI_FIND_DEBUG=1` (or
`true`/`on`). Setting `PI_FIND_DEBUG_FILE` alone does not enable it. When
enabled, each search appends one local JSON object to
`~/.pi/pi-find/debug.jsonl` (override with `PI_FIND_DEBUG_FILE`); the file
rotates to `debug.jsonl.1` at 10 MiB and nothing is sent anywhere.

Each event records the parameters, duration, and outcome (`ok`, `error` with
its error type, or `aborted`), plus internals the transcript does not show:

- which limit bound (`resultLimitHit` for the result cap, `outputLimitHit`
  for the byte budget), and collected vs displayed counts;
- `outputBytes` (the text returned to the model) and, for grep,
  `clippedLines`;
- `rejectedByGlob` (matches or paths the glob filtered out) and the basename
  `prefilter` passed to rg/fd (`*` means the whole tree was enumerated);
- for grep content searches that ran to completion, rg's own
  `searchedFiles`/`searchedBytes`;
- `pathError` when unreadable paths were skipped, whether automatic context
  was dropped for budget, and stable notice IDs (`hidden_path`,
  `glob_prefix`, …);
- `sessionId`, `sessionFile`, `toolCallId`, and `model`, so an event can be
  joined with the pi session to see what the model did next.

Logging never fails a search. Summarize the log (default: the active file
and its rotated sibling):

```bash
pnpm --filter @tian.zuo/pi-find debug-stats            # text report
pnpm --filter @tian.zuo/pi-find debug-stats -- --json  # machine-readable
```

The report shows empty and partial rates by cause, empty results with glob
rejections (usually a slash glob against the wrong base), broad scans,
notices, errors, and the model's next action after empty, partial, or
failed searches: another grep/find, a shell search, a `read`, or nothing.
Sections `[A]` (globs with a fixed directory prefix) and `[B]` (output cost)
track the two open questions in
[`docs/pi-find-search-decision.md`](../../docs/pi-find-search-decision.md).

## Binaries

The extension first uses pi's managed `~/.pi/agent/bin/{rg,fd}` binaries, then
checks `PATH` (`fdfind` is accepted on Debian/Ubuntu). It requires ripgrep >=
12.0 and fd >= 8.7.0. If either is unavailable, the tool returns a clear install
or upgrade message; it does not run a package manager.

## Development

```bash
pnpm --filter @tian.zuo/pi-find run check
pnpm --filter @tian.zuo/pi-find test
pi -e ./packages/pi-find
```

The integration tests run real rg and fd searches when those binaries are
available.
