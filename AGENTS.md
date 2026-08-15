# AGENTS.md

A collection of extensions for the [pi coding agent](https://pi.dev): per-repo model defaults, per-repo skill toggles, dedicated-model Git commits, token-speed meter, pasted-image cache, an ask-user tool, provider usage display, background-yielding bash, web search & fetch, and a strict edit tool. Published as independent npm packages from one npm-workspace monorepo.

## Tech stack

- Language: TypeScript 7 (strict, `noEmit`, `target: ES2022`, `module: ESNext`, `moduleResolution: bundler`). Source is shipped as-is — there is **no build step**; the `lib/` and `src/` directories under each package are committed TypeScript, not compiled output.
- Runtime: Node 26 (pinned in `mise.toml`). Type-only ESM.
- Framework: **Effect v4** (`effect@4.x`). Effect v4 is the standard framework and first choice for extensions requiring async orchestration, mutable state, lifecycle control, service layers, and typed error handling. The root `tsconfig.json` configures the compiler options and `@effect/language-service` plugin for the entire monorepo, while package-level `tsconfig.json` files extend `../../tsconfig.json`.
- pi runtime packages (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui`, `typebox`) are **peer dependencies** — pi provides them at runtime; they must not be bundled.
- `effect-tsgo patch` (the editor language-service binary patch) is declared **only** by `pi-background-terminals`. npm runs every workspace's `prepare` in parallel during `npm install`/`npm ci`, and two concurrent patches of the same TypeScript binary race on the backup rename; other Effect packages intentionally omit `prepare` and rely on the shared patched binary.
- Tooling: npm workspaces, `tsc` for typecheck-only, Node's built-in `node --test` runner, GitHub Actions for publishing.

## Repository layout

- `packages/` — one publishable workspace per extension. Real implementation lives here, mostly as `index.ts` (+ `lib/*.ts` helpers), except Effect-based packages also ship `src/**` runtimes (`pi-background-terminals`, `pi-commit`, `pi-goal`, `pi-image-cache`, `pi-repo-model`, `pi-repo-skills`, `pi-subagents`, `pi-todo`, `pi-token-speed`, `pi-usage`, `pi-vscode-bridge`, `pi-web-search`). The npm workspaces configuration (`"workspaces": ["packages/*"]` in root `package.json`) dynamically discovers all extension packages for checks, tests, and publishing.
- `extensions/` — thin re-export stubs (`export { default } from "../packages/<pkg>/index"`) kept only as compatibility entry points for the legacy aggregate Git package. **Do not put logic here** — edit the matching `packages/*` instead.
- `tests/` — repo-level tests run from the root (currently `pi-usage-providers.test.mjs`). Package-local tests live under `test/` (or next to source for `pi-background-terminals`).
- `.github/workflows/publish.yml` — npm publish on push to `main` (runs typecheck, workspace checks, and tests dynamically across all packages).
- `tsconfig.json` — root typecheck config covering all extensions and workspace packages.
- `mise.toml`, `package-lock.json` — tooling/lockfile.

Workspace → npm package map: `pi-repo-model`→`pi-tian-repo-model`, `pi-repo-skills`→`pi-tian-repo-skills`, `pi-commit`→`pi-tian-commit`, `pi-token-speed`→`pi-tian-token-speed`, `pi-image-cache`→`pi-tian-image-cache`, `pi-ask-user`→`pi-tian-ask-user`, `pi-usage`→`pi-tian-usage`, `pi-background-terminals`→`pi-tian-background-terminals`, `pi-edit-safe`→`pi-tian-edit-safe`, `pi-todo`→`pi-tian-todo`, `pi-subagents`→`pi-tian-subagents`, `pi-compact-output`→`pi-tian-compact-output`, `pi-goal`→`pi-tian-goal`, `pi-vscode-bridge`→`pi-tian-vscode-bridge`, `pi-web-search`→`pi-tian-web-search`.

## Common tasks

- Install deps: `npm install`
- Typecheck the whole monorepo (all extensions and packages): `npm run typecheck`
- Typecheck all Effect packages across workspaces: `npm run check`
- Typecheck individual Effect packages (scoped check):
    - `npm run check -w pi-tian-background-terminals`
    - `npm run check -w pi-tian-commit`
    - `npm run check -w pi-tian-goal`
    - `npm run check -w pi-tian-image-cache`
    - `npm run check -w pi-tian-repo-model`
    - `npm run check -w pi-tian-repo-skills`
    - `npm run check -w pi-tian-subagents`
    - `npm run check -w pi-tian-todo`
    - `npm run check -w pi-tian-token-speed`
    - `npm run check -w pi-tian-usage`
    - `npm run check -w pi-tian-vscode-bridge`
    - `npm run check -w pi-tian-web-search`
- Run all tests (repo-level and all package workspaces): `npm test`
- Test repo-level (usage providers): `npm run test:usage`
- Test individual packages (scoped test):
    - Test `pi-usage` (fetch/runtime): `npm test -w pi-tian-usage`
    - Test `pi-ask-user`: `npm test -w pi-tian-ask-user`
    - Test `pi-commit`: `npm test -w pi-tian-commit`
    - Test `pi-edit-safe`: `npm test -w pi-tian-edit-safe` (45 cases); A/B vs pi's real built-in edit: `npm run bench -w pi-tian-edit-safe`
    - Test `pi-repo-model`: `npm test -w pi-tian-repo-model`
    - Test `pi-repo-skills`: `npm test -w pi-tian-repo-skills`
    - Test `pi-todo`: `npm test -w pi-tian-todo`
    - Test `pi-token-speed`: `npm test -w pi-tian-token-speed`
    - Test `pi-background-terminals`: `npm test -w pi-tian-background-terminals`
    - Test `pi-subagents`: `npm test -w pi-tian-subagents`
    - Test `pi-compact-output`: `npm test -w pi-tian-compact-output`
    - Test `pi-goal`: `npm test -w pi-tian-goal`
    - Test `pi-image-cache`: `npm test -w pi-tian-image-cache`
    - Test `pi-vscode-bridge`: `npm test -w pi-tian-vscode-bridge`, compile its VS Code host with `npm run compile:vscode -w pi-tian-vscode-bridge`
    - Test `pi-web-search`: `npm test -w pi-tian-web-search`
- Inspect publishable tarballs: `npm run pack:check`
- Try an extension in a live pi session without installing: `pi -e ./packages/pi-repo-model`
- Publish one workspace manually (after `npm login`): `npm publish --workspace packages/pi-repo-model`

## Conventions

- When developing extensions, use **Effect v4** for non-trivial async orchestration, mutable session state, subprocess/file lifecycle, or concurrent cleanup — prefer `Effect`/`@effect/*` idioms (typed effects, `Effect.gen`, dependency injection via `Context`, `ManagedRuntime`, `SynchronizedRef`) over raw async/throw patterns. Follow `pi-background-terminals`, `pi-commit`, `pi-goal`, `pi-image-cache`, `pi-repo-model`, `pi-repo-skills`, `pi-subagents`, `pi-todo`, `pi-token-speed`, `pi-usage`, `pi-vscode-bridge`, and `pi-web-search` as reference implementations.
- **TUI width safety:** every custom `Component.render(width)`, `ctx.ui.setWidget` renderer, custom footer/editor, tool renderer, and message renderer must return lines whose ANSI-aware `visibleWidth()` is no greater than `width`. Use `truncateToWidth(line, width, "")` (or width-aware wrapping) after composing prefixes, content, and suffixes; never return fixed-width strings. Exercise renderers at narrow widths such as 42 columns.
- **Prompt & schema description separation:** Keep all model-facing text (tool `description`, `promptSnippet`, `promptGuidelines`, parameter/schema `description`s, system prompts, continuation prompts, and result formatters) in a dedicated `prompt.ts` module (under `lib/prompt.ts` or `src/prompt.ts`). Do not inline prompt strings or schema descriptions directly into runtime orchestration, tool definitions, or schema definitions in `index.ts` or implementation files. This enables tuning model-facing phrasing, token budgets, and behavioral policies cleanly without touching execution logic or UI rendering.
- **Intentional non-Effect packages** (linear/sync UI or trivial I/O only): `pi-ask-user`, `pi-compact-output`, `pi-edit-safe`.
- One extension per package; the package `name`/version in each `packages/*/package.json` is the source of truth for npm publishing.
- `files` arrays in each package's `package.json` define tarball contents — add new source files there when they should ship (e.g. `lib`, `src`, `docs`).
- Machine-local state (per-repo prefs, caches, tokens) lives under `~/.pi/...`, never inside a repo. Extensions read credentials pi already writes to `~/.pi/agent/auth.json`.
- Packages ship **uncompiled TypeScript**, so all source must use erasable-syntax-only constructs — no `enum`, no namespaces, and no constructor parameter properties (`constructor(readonly x: T)`), which Node's type-stripping loader rejects. Declare the field and assign it in the body instead.
- Keep `extensions/*.ts` as one-line re-export stubs; real code goes in `packages/*`.
- When changing an extension, bump that package's `version` to trigger an npm release — CI compares the local version against the registry and publishes only unpublished versions, with provenance.
- Version update policy: bump only the changed package; use a patch release for fixes, a minor release for backward-compatible features, and a major release for breaking changes. Documentation-only changes that do not alter a published package do not require a version bump. Keep `package-lock.json` synchronized when package versions change.
- **Temporarily disabling publish:** set `"private": true` in `packages/<pkg>/package.json`. The CI workflow checks this field and automatically skips publishing private packages (`⏭ <name> is private, skipping`). Remove `"private": true` when ready to publish again.

## Working agreement

- Prefer small, reviewable changes; bump and publish only the package(s) that actually changed.
- Always run root `npm run typecheck`, `npm run check`, and `npm test` (or scoped checks `npm run check -w pi-tian-*` / `npm test -w pi-tian-*` for modified packages) before pushing. The publish workflow runs monorepo typecheck, workspace Effect checks, all test suites, and dynamic package publishing across all workspaces.
- Keep this file in sync with real workflows — update it when commands, workspace layout, or publish steps change.
