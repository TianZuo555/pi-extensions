# AGENTS.md

A collection of extensions for the [pi coding agent](https://pi.dev): per-repo model defaults, per-repo skill toggles, dedicated-model Git commits, token-speed meter, pasted-image cache, an ask-user tool, provider usage display, background-yielding bash, and a strict edit tool. Published as independent npm packages from one npm-workspace monorepo.

## Tech stack
- Language: TypeScript (strict, `noEmit`, `target: ES2022`, `module: ESNext`, `moduleResolution: bundler`). Source is shipped as-is — there is **no build step**; the `lib/` and `src/` directories under each package are committed TypeScript, not compiled output.
- Runtime: Node 26 (pinned in `mise.toml`). Type-only ESM.
- pi runtime packages (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui`, `typebox`) are **peer dependencies** — pi provides them at runtime; they must not be bundled.
- **Effect v4 packages** (`pi-background-terminals`, `pi-commit`, `pi-goal`, `pi-image-cache`, `pi-subagents`, `pi-usage`, `pi-vscode-bridge`) use `effect`, `@effect/language-service`, and `@effect/tsgo`. Their prerelease `effect` runtime is pinned exactly to the tested beta (`4.0.0-beta.101`). Each carries its own `tsconfig.json` and is excluded from the root typecheck.
- `effect-tsgo patch` (the editor language-service binary patch) is declared **only** by `pi-background-terminals`. npm runs every workspace's `prepare` in parallel during `npm install`/`npm ci`, and two concurrent patches of the same TypeScript binary race on the backup rename; other Effect packages intentionally omit `prepare` and rely on the shared patched binary.
- Tooling: npm workspaces, `tsc` for typecheck-only, Node's built-in `node --test` runner, GitHub Actions for publishing.

## Repository layout
- `packages/` — one publishable workspace per extension. Real implementation lives here, mostly as `index.ts` (+ `lib/*.ts` helpers), except Effect-based packages also ship `src/**` runtimes (`pi-background-terminals`, `pi-commit`, `pi-goal`, `pi-image-cache`, `pi-subagents`, `pi-usage`, `pi-vscode-bridge`).
- `extensions/` — thin re-export stubs (`export { default } from "../packages/<pkg>/index"`) kept only as compatibility entry points for the legacy aggregate Git package. **Do not put logic here** — edit the matching `packages/*` instead.
- `tests/` — repo-level tests run from the root (currently `pi-usage-providers.test.mjs`). Package-local tests live under `test/` (or next to source for `pi-background-terminals`).
- `.github/workflows/publish.yml` — npm publish on push to `main`.
- `tsconfig.json` — root typecheck config. **Excludes all Effect-based packages** (each carries its own `tsconfig.json`).
- `mise.toml`, `package-lock.json` — tooling/lockfile.

Workspace → npm package map: `pi-repo-model`→`pi-tian-repo-model`, `pi-repo-skills`→`pi-tian-repo-skills`, `pi-commit`→`pi-tian-commit`, `pi-token-speed`→`pi-tian-token-speed`, `pi-image-cache`→`pi-tian-image-cache`, `pi-ask-user`→`pi-tian-ask-user`, `pi-usage`→`pi-tian-usage`, `pi-background-terminals`→`pi-tian-background-terminals`, `pi-edit-safe`→`pi-tian-edit-safe`, `pi-todo`→`pi-tian-todo`, `pi-subagents`→`pi-tian-subagents`, `pi-compact-output`→`pi-tian-compact-output`, `pi-goal`→`pi-tian-goal`, `pi-vscode-bridge`→`pi-tian-vscode-bridge`.

## Common tasks
- Install deps: `npm install`
- Typecheck the simple extensions (everything except Effect-based ones): `npm run typecheck`
- Typecheck Effect packages (run separately locally and in CI):
  - `npm run check -w pi-tian-background-terminals`
  - `npm run check -w pi-tian-commit`
  - `npm run check -w pi-tian-goal`
  - `npm run check -w pi-tian-image-cache`
  - `npm run check -w pi-tian-subagents`
  - `npm run check -w pi-tian-usage`
  - `npm run check -w pi-tian-vscode-bridge`
- Test repo-level (usage providers): `npm run test:usage`
- Test `pi-usage` (fetch/runtime): `npm test -w pi-tian-usage`
- Test `pi-ask-user`: `npm test -w pi-tian-ask-user`
- Test `pi-commit`: `npm test -w pi-tian-commit`
- Test `pi-edit-safe`: `npm test -w pi-tian-edit-safe` (45 cases); A/B vs pi's real built-in edit: `npm run bench -w pi-tian-edit-safe`
- Test `pi-todo`: `npm test -w pi-tian-todo`
- Test `pi-background-terminals`: `npm test -w pi-tian-background-terminals`
- Test `pi-subagents`: `npm test -w pi-tian-subagents`
- Test `pi-compact-output`: `npm test -w pi-tian-compact-output`
- Test `pi-goal`: `npm test -w pi-tian-goal`
- Test `pi-image-cache`: `npm test -w pi-tian-image-cache`
- Test `pi-vscode-bridge`: `npm test -w pi-tian-vscode-bridge`, typecheck with `npm run check -w pi-tian-vscode-bridge`, compile its VS Code host with `npm run compile:vscode -w pi-tian-vscode-bridge`
- Inspect publishable tarballs: `npm run pack:check`
- Try an extension in a live pi session without installing: `pi -e ./packages/pi-repo-model`
- Publish one workspace manually (after `npm login`): `npm publish --workspace packages/pi-repo-model`

## Conventions
- When developing extensions, use **Effect** for non-trivial async orchestration, mutable session state, subprocess/file lifecycle, or concurrent cleanup — prefer `Effect`/`@effect/*` idioms (typed effects, `Effect.gen`, dependency injection via `Context`) over raw async/throw patterns. Follow `pi-background-terminals`, `pi-commit`, `pi-goal`, `pi-image-cache`, `pi-subagents`, and `pi-usage` as reference implementations.
- **TUI width safety:** every custom `Component.render(width)`, `ctx.ui.setWidget` renderer, custom footer/editor, tool renderer, and message renderer must return lines whose ANSI-aware `visibleWidth()` is no greater than `width`. Use `truncateToWidth(line, width, "")` (or width-aware wrapping) after composing prefixes, content, and suffixes; never return fixed-width strings. Exercise renderers at narrow widths such as 42 columns.
- **Intentional non-Effect packages** (linear/sync UI or trivial I/O only): `pi-ask-user`, `pi-compact-output`, `pi-edit-safe`, `pi-repo-model`, `pi-repo-skills`, `pi-todo`, `pi-token-speed`.
- One extension per package; the package `name`/version in each `packages/*/package.json` is the source of truth for npm publishing.
- `files` arrays in each package's `package.json` define tarball contents — add new source files there when they should ship (e.g. `lib`, `src`, `docs`).
- Machine-local state (per-repo prefs, caches, tokens) lives under `~/.pi/...`, never inside a repo. Extensions read credentials pi already writes to `~/.pi/agent/auth.json`.
- Packages ship **uncompiled TypeScript**, so all source must use erasable-syntax-only constructs — no `enum`, no namespaces, and no constructor parameter properties (`constructor(readonly x: T)`), which Node's type-stripping loader rejects. Declare the field and assign it in the body instead.
- Keep `extensions/*.ts` as one-line re-export stubs; real code goes in `packages/*`.
- When changing an extension, bump that package's `version` to trigger an npm release — CI compares the local version against the registry and publishes only unpublished versions, with provenance.
- Version update policy: bump only the changed package; use a patch release for fixes, a minor release for backward-compatible features, and a major release for breaking changes. Documentation-only changes that do not alter a published package do not require a version bump. Keep `package-lock.json` synchronized when package versions change.

## Working agreement
- Prefer small, reviewable changes; bump and publish only the package(s) that actually changed.
- Always run **all eight** typechecks before pushing: `npm run typecheck` (root) **and** each `npm run check -w pi-tian-*` for background-terminals, commit, goal, image-cache, subagents, usage, and vscode-bridge. The publish workflow runs all eight plus `test:usage`, the pi-usage package tests, and the ask-user, commit, edit-safe, subagents, compact-output, goal, image-cache, background-terminals, and vscode-bridge test suites before publishing.
- Keep this file in sync with real workflows — update it when commands, workspace layout, or publish steps change.
