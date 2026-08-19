# pi-find

ripgrep/fd-backed `grep` and `find` for the [pi coding agent](https://pi.dev).

Install: `npm:pi-tian-find` · npm package `pi-tian-find` · workspace `packages/pi-find`

## Why

pi's built-in `grep` and `find` already shell out to ripgrep and fd, but they expose a thin
slice of both and ship **zero `promptGuidelines`** — the model gets a tool description and no
advice on how to search well. This package replaces them with the same engines behind a
better interface.

| | pi built-in | **pi-find** |
|---|---|---|
| `grep` guidelines | none | 5 |
| `find` guidelines | none | 4 |
| multi-pattern search | — | yes, array of patterns in `grep` |
| exclude filter | — | `exclude: "test/,*.min.js"` |
| case handling | `ignoreCase` flag | smart-case by default, `caseSensitive` to force |
| regex vs literal | `literal` flag | auto-detected, falls back to literal when uncompilable |
| `find` matching | glob only | substring/regex on the whole path **or** glob |
| path filter | `glob` string | directory / filename / glob DSL with rg/fd directory pruning |
| context lines | re-reads the file | ripgrep's own context events |

## Measured

A headless A/B benchmark (deterministic 189-file fixture with planted needles, a
1.6 MB single-line minified bundle, gitignored build output, and same-basename
decoys; 6 tasks × 2 repeats per arm) compared three arms — pi's built-in
grep/find, this extension, and `bash` with both search tools disabled so the
model had to shell out to rg/fd directly — across three models: DeepSeek
V4 Flash, GLM 5.3, and GPT 5.6 Luna (144 runs, all 100% correct). Harness:
`pi -p --mode json`, measuring search actions, tokens, and errors from the
JSON transcript.

| observation | result |
|---|---|
| model's free choice (tools + bash both available) | **0/36 runs used bash to search** — every model picked the structured tools |
| built-in tools vs bash (forced comparison) | 0/36 runs used the built-in grep/find — models preferred writing `rg` by hand |
| output tokens, this extension vs bash | −26% (DeepSeek), −35% (GLM 5.3), −10% (GPT Luna) |
| minified-bundle trap task | bash worst case spiralled to 9 calls / 1558 tokens; the bounded tool did it in 1 call / 83 |
| model mistakes (e.g. a stringified pattern array) | flagged in the result with a resend notice; the same mistake under bash returns a wall of noise |

Two takeaways. First, the model votes with its actions: given bash and these
tools side by side it always searches through the tools, but given pi's
built-ins it always writes shell instead — the interface, not tool availability,
drives the choice. Second, the wins concentrate exactly where an agent is
weakest unaided: bounded output on hostile files and built-in recovery from
its own serialization slips.

## Tools

### `grep`

Content search. Smart-case: an all-lowercase pattern matches case-insensitively, any
uppercase makes it exact. Regex is detected automatically for single patterns, and **ripgrep's own parser** is the
validator — a pattern it rejects is retried as a literal instead of surfacing a parse error.

Pass an array of strings in `pattern` to search for **any** of several literal patterns in one pass (Aho-Corasick with SIMD Teddy prefilter):

```jsonc
{ "pattern": ["user_id", "userId", "UserId", "USER_ID"] }
```

Wildcard-only single patterns (`.*`, `.`, `^.*$`) are refused with a pointer to `read`, because
they match every line and are never a useful regex search. Pattern arrays are always literal, so
`[".*"]` searches for those two characters.

When every path include is a simple extension glob such as `*.ts` or `*.d.ts`, grep also supplies
a temporary ripgrep file type as an engine-side file-selection hint. This retains `.gitignore`
semantics and limits content search and JSON output to the combined extension set; root-relative
client matchers remain authoritative.

### `find`

Path search. `pattern` is matched against the **whole repo-relative path** as a literal
substring (`"profile"` also hits `chrome/browser/profiles/x.cc`), or as a regex when it
contains regex syntax (`"\.tsx$"`, `"^src"` — a regex that does not compile is retried as a
literal). Multiple whitespace-separated words must all appear, in any order, so `"deep b"`
and `"b deep"` both find `src/deep/b.ts`. Directory constraints in `path` (e.g. `"src/"`) are
pushed down directly to rg/fd for directory-level pruning. Other include and exclude shapes
are filtered against root-relative paths without overriding `.gitignore`.

Pass an empty `pattern` to list everything matching `path` alone.

## The path DSL

`path` and `exclude` both take a single string, a comma-separated list, or an array. Spaces
inside a path are preserved; use separate array elements for multiple constraints or for a
literal path containing a comma. Three shapes are recognised without touching the filesystem,
so the same parser works for excludes and for paths outside the workspace:

| Written | Means |
|---|---|
| `src/`, `src/foo/`, `src` | everything beneath that directory |
| `main.rs` | that filename **at any depth** (slashless glob with basename matching) |
| `src/main.rs` | exactly that path |
| `Dockerfile`, `src/LICENSE` | a dotless last segment is ambiguous between an extensionless file and a directory: slashless names match at any depth; names with directories match as workspace-relative paths |
| `*.ts`, `src/**/*.cc`, `{src,lib}/**` | glob |

A leading `!` is optional and ignored, so `exclude: "test/"` and `exclude: "!test/"` behave
the same. Brace alternations are protected from comma splitting: `{src,lib}/**` stays one
token.

Excludes are not just a post-filter: directory-shaped ones (`dist/**`, `**`) are pushed down to
ripgrep (and to fd on full-root walks) as engine-level negative globs, so an untracked `dist/`
with tens of thousands of files is pruned during traversal instead of being read and then
discarded — measured 1.15s → 0.007s on a 50k-file tree. Only globs with directory-closure
semantics are pushed: engines apply excludes to directories as well as files, so `*.min.js`
would prune a directory named `cache.min.js` whole, taking files the client-side matcher keeps.
Basename globs, exact filenames, fd under `--search-path`, and `/name` anchors therefore stay
client-side, and results are identical either way.

Relative constraints remain rooted at the session cwd, so every returned path can be passed
directly to `read`/`edit`, pattern matching sees the whole repo-relative path, and excludes use
the same namespace. A single absolute, `~/`, or `../` path outside the workspace is resolved
into an external root and a relative include glob; its results are returned as absolute paths.
Extensionless external paths are settled with a stat (a file contributes its directory as the
root, anything else is used as the root itself). An external path must be the call's sole `path`
constraint; run separate searches instead of mixing it with additional roots or globs.

## Binaries

Resolution order per binary (successful resolutions are cached and revalidated):

1. `~/.pi/agent/bin/{rg,fd}` — pi downloads these itself for its built-ins, so the common
   case needs no install
2. anything on `PATH` (`fd` or Debian/Ubuntu's `fdfind`)

Required versions are ripgrep >= 12.0 and fd >= 8.7.0; these provide `--no-require-git`, which
keeps `.gitignore` behavior consistent outside Git repositories. Older binaries are rejected
during discovery and routed through the same actionable install/upgrade flow as missing ones.

On session startup with UI support, `pi-find` checks for missing binaries and detects Homebrew,
APT, Pacman, DNF, Zypper, APK, Winget, Chocolatey, Scoop, or MacPorts. Non-privileged installers
can run after confirmation. Commands requiring `sudo` or root are shown as a copyable terminal
command instead, because extension subprocesses cannot answer password prompts. If installation
is skipped, the tool reports an install command rather than a raw spawn error.

## Bounded by design

Output is consumed incrementally. Grep stops early once `limit` matches have been observed; find
stops early once `limit` files have been matched. Beyond that:

- `limit` counts **matches**, not lines — `context: 3` does not eat your budget
- grep/find limits are capped at 1 000 and context is capped at 20 lines
- hitting a result limit is reported in model-visible output with an actionable larger limit
- lines longer than 400 chars are clipped, so one minified file cannot flood a result
- each tool result stays below pi's 50KB ceiling with clean text truncation notices
- `.git/` is always excluded (packed objects match almost any pattern by chance)

## Development

```bash
pnpm --filter pi-tian-find run check   # typecheck
pnpm --filter pi-tian-find test        # 158 tests
pi -e ./packages/pi-find               # try it live
```

The test suite runs the **real** rg and fd binaries against a fixture tree, because unit
tests on the DSL cannot tell whether ripgrep interprets the generated globs as intended.
Those cases skip automatically when a binary is unavailable.

## Coexisting with other search extensions

These tools deliberately reuse pi's built-in names (`grep`, `find`) so they override the
built-ins rather than adding a second search surface to the system prompt. If another
extension also registers `grep`/`find` (for example `@ff-labs/pi-fff` in `override` mode),
load order decides the winner — enable only one.
