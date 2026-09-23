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
grep(pattern, path?, glob?, output?, literal?, context?)
```

- `pattern` is a case-sensitive ripgrep regular expression. Set `literal: true`
  to search exact text instead, without escaping metacharacters.
- `path` is one file or directory and defaults to the current directory.
- `glob` optionally limits file names, for example `*.ts` or `**/*.test.ts`.
- `output` is `"content"` (default) or `"files"`. File mode uses `rg -l` to
  return unique paths without collecting every matching line in each file.
- `context` is the number of surrounding lines, from 0 to 50. Omit it to
  automatically include up to **5 lines before and after** when a complete
  search has **1–3 matching lines**. Set `context: 0` for matches only, or a
  positive number to request context explicitly. File mode ignores context.

```jsonc
{ "pattern": "TODO|FIXME", "path": "src", "glob": "*.ts" }
{ "pattern": "registerTool(", "literal": true, "output": "files" }
{ "pattern": "SearchRuntime", "path": "src", "context": 0 }
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
is omitted for incomplete searches (limits, timeout, or skipped records), or
if it would exceed the output budget. Explicit context that cannot fit is
omitted with a notice so it never crowds out the matching lines.

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
  Glob filtering never re-includes ignored files.
- A leading `!` excludes instead of includes, like ripgrep's own `--glob`: for
  example `glob: "!*.test.ts"` or `pattern: "!**/*.generated.ts"`.
- A leading `@` is stripped from input paths; `~` and `~/...` expand to the
  home directory. Ripgrep user configuration is ignored so it cannot change
  the tool's case sensitivity or ignore behavior.
- Hidden files and directories are not searched by default. An explicitly
  named hidden path still works, for example `path: ".github"`. A glob such
  as `.github/**/*.yml` alone does not enable hidden traversal; use
  `{ "path": ".github", "pattern": "*.yml" }`. Empty results include this hint.
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

For uncommon searches involving several roots, complex exclusions, multiline
matching, counts, global sorting, pagination, or pipelines, use `rg` or `fd`
through the shell rather than expanding these tool schemas.

## Hidden files and secrets

Default searches do not walk hidden paths. This reduces accidental exposure of
files such as `.env`, `.npmrc`, and private keys in model-visible tool output.
It is not a complete secret boundary: explicitly named files, ordinary tracked
files, `read`, and shell tools can still expose secrets. Strong secret isolation
must be enforced across every filesystem tool, not only grep.

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
