# pi-find

Simple, bounded `grep` and `find` tools for the [pi coding agent](https://pi.dev),
backed by ripgrep and fd.

Install: `npm:@tian.zuo/pi-find` · npm package `@tian.zuo/pi-find` · workspace
`packages/pi-find`

The extension reuses pi's built-in tool names, so the model sees one search
surface instead of competing built-in and extension tools.

## Tools

### `grep`

```text
grep(pattern, path?, glob?)
```

- `pattern` is a case-sensitive ripgrep regular expression.
- `path` is one file or directory and defaults to the current directory.
- `glob` optionally limits file names, for example `*.ts` or `**/*.test.ts`.

```jsonc
{ "pattern": "TODO|FIXME", "path": "src", "glob": "*.ts" }
```

### `find`

```text
find(pattern, path?)
```

- `pattern` is a file glob, for example `*.ts` or `**/*.test.ts`.
- `path` is one directory and defaults to the current directory.

```jsonc
{ "pattern": "**/*.test.ts", "path": "packages" }
```

## Search behavior

- Both tools respect `.gitignore` and always skip `.git`.
- Hidden files and directories are not searched by default. An explicitly
  named hidden path still works, for example `path: ".github"`.
- Grep stops after 100 matches; find stops after 200 files. A result says when
  the fixed limit was reached so the caller can narrow the search.
- Grep lines longer than 400 characters are clipped.
- Search output also has a hard byte limit, and running searches are
  cancellable.
- Relative result paths can be passed directly to pi's `read` and `edit` tools.

For uncommon searches involving several roots, exclusions, multiline matching,
counts, sorting, or pipelines, use `rg` or `fd` through the shell rather than
expanding these tool schemas.

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
