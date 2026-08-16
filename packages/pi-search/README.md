# pi-search

ripgrep/fd-backed `grep`, `find`, and `multi_grep` for the [pi coding agent](https://pi.dev).

Install: `npm:pi-tian-search` · npm package `pi-tian-search` · workspace `packages/pi-search`

## Why

pi's built-in `grep` and `find` already shell out to ripgrep and fd, but they expose a thin
slice of both and ship **zero `promptGuidelines`** — the model gets a tool description and no
advice on how to search well. This package replaces them with the same engines behind a
better interface.

| | pi built-in | **pi-search** |
|---|---|---|
| `grep` guidelines | none | 4 |
| `find` guidelines | none | 4 |
| `multi_grep` | — | yes, 3 guidelines |
| exclude filter | — | `exclude: "test/,*.min.js"` |
| case handling | `ignoreCase` flag | smart-case by default, `caseSensitive` to force |
| regex vs literal | `literal` flag | auto-detected, falls back to literal when uncompilable |
| `find` matching | glob only | fuzzy path score **or** glob |
| path filter | `glob` string | directory / filename / glob DSL |
| pagination | truncates | cursor to continue |
| context lines | re-reads the file | ripgrep's own context events |

## Tools

### `grep`

Content search. Smart-case: an all-lowercase pattern matches case-insensitively, any
uppercase makes it exact. Regex is detected automatically, and **ripgrep's own parser** is the
validator — a pattern it rejects is retried as a literal instead of surfacing a parse error.
That covers both unbalanced syntax (`needle(arg`, which models emit when grepping a call
site) and JavaScript-only constructs ripgrep does not support, such as lookaheads
(`needle(?=\s)`) and backreferences (`(a)\1`).

```jsonc
{ "pattern": "registerTool", "path": "src/", "exclude": "test/,*.min.js", "context": 2 }
```

Wildcard-only patterns (`.*`, `.`, `^.*$`) are refused with a pointer to `read`, because they
match every line and are never a useful search.

### `find`

Path search. `pattern` is a **fuzzy score against the whole repo-relative path**, so
`"deep b"` finds `src/deep/b.ts` and `"profile"` also hits
`chrome/browser/profiles/x.cc`. Multiple words all have to match but need not be adjacent or
ordered (fzf extended-match semantics). For an exact filename, put a glob in `path`
(`"**/profile.h"`) — that is a precise filter, while `pattern` is a ranking.

Pass an empty `pattern` to list everything matching `path` alone.

### `multi_grep`

One pass for several **literal** patterns. ripgrep matches them together (Aho-Corasick with
SIMD Teddy prefilter), which beats a regex alternation and beats repeated greps. Built for
naming-convention sweeps:

```jsonc
{ "patterns": ["user_id", "userId", "UserId", "USER_ID"] }
```

## The path DSL

`path` and `exclude` both take a single string, a comma-separated list, or an array. Spaces
inside a path are preserved; use separate array elements for multiple constraints or for a
literal path containing a comma. Three shapes are recognised without touching the filesystem,
so the same parser works for excludes and for paths outside the workspace:

| Written | Means |
|---|---|
| `src/`, `src/foo/`, `src` | everything beneath that directory |
| `main.rs` | that filename **at any depth** (`**/main.rs`) |
| `src/main.rs` | exactly that path |
| `Dockerfile`, `src/LICENSE` | a dotless last segment is ambiguous between an extensionless file and a directory, so it matches **either** — the file at any depth or the directory's contents |
| `*.ts`, `src/**/*.cc`, `{src,lib}/**` | glob |

A leading `!` is optional and ignored, so `exclude: "test/"` and `exclude: "!test/"` behave
the same. Brace alternations are protected from comma splitting: `{src,lib}/**` stays one
token.

Relative constraints remain rooted at the session cwd, so every returned path can be passed
directly to `read`/`edit`, fuzzy matching sees the whole repo-relative path, and excludes use
the same namespace. A single absolute or `~/` filename/glob outside the workspace is split
into an external root and a relative include glob; its results are returned as absolute paths.
Extensionless external paths are settled with a stat (a file contributes its directory as the
root, anything else is used as the root itself). Mixing different external roots is rejected
with an actionable error, so run one search per external root.

## Binaries

Resolution order per binary, cached for the session:

1. `~/.pi/agent/bin/{rg,fd}` — pi downloads these itself for its built-ins, so the common
   case needs no install
2. anything on `PATH` (`fd` or Debian/Ubuntu's `fdfind`)

If neither has it, the tool fails with the install command for that binary rather than a
spawn error.

## Bounded by design

Output is consumed incrementally. Grep stops after probing one match past `limit`; fuzzy find
walks only a bounded candidate set so it can rank the whole path rather than returning the
first filesystem entries it encounters. Beyond that:

- `limit` counts **matches**, not lines — `context: 3` does not eat your budget
- grep/find limits are capped at 1 000 and context is capped at 20 lines
- hitting a result limit is reported in model-visible output with an actionable larger limit
- lines longer than 400 chars are clipped, so one minified file cannot flood a result
- each tool result stays below pi's 50KB ceiling; a page that overflows stores its remainder
  under a cursor, and the follow-up serves the *original* results rather than re-running it
- cursors are session-scoped, consumed once, bounded to 32, and cannot be replayed across
  tools or against a different query; a mismatched attempt leaves the cursor usable by the
  original query
- `.git/` is always excluded (packed objects match almost any pattern by chance)
- fuzzy `find` caps its candidate walk at 20 000 files and reports when it did

## Development

```bash
pnpm --filter pi-tian-search run check   # typecheck
pnpm --filter pi-tian-search test        # 104 tests
pi -e ./packages/pi-search               # try it live
```

The test suite runs the **real** rg and fd binaries against a fixture tree, because unit
tests on the DSL cannot tell whether ripgrep interprets the generated globs as intended.
Those cases skip automatically when a binary is unavailable.

## Coexisting with other search extensions

These tools deliberately reuse pi's built-in names (`grep`, `find`) so they override the
built-ins rather than adding a second search surface to the system prompt. If another
extension also registers `grep`/`find` (for example `@ff-labs/pi-fff` in `override` mode),
load order decides the winner — enable only one.
