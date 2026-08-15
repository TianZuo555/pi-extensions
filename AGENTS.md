# AGENTS.md

A collection of extensions for the [pi coding agent](https://pi.dev): per-repo model defaults, per-repo skill toggles, dedicated-model Git commits, token-speed meter, pasted-image cache, an ask-user tool, provider usage display, background-yielding bash, web search & fetch, and a strict edit tool. Published as independent npm packages from one pnpm-workspace monorepo.

## Tech stack

- Language: TypeScript 7 (strict, `noEmit`, `target: ES2022`, `module: ESNext`, `moduleResolution: bundler`). Source is shipped as-is — there is **no build step**; the `lib/` and `src/` directories under each package are committed TypeScript, not compiled output.
- Runtime: Node 26 and pnpm 11 (both pinned in `mise.toml`; the exact pnpm version is also declared in the root `package.json` `packageManager` field). Type-only ESM.
- Framework: **Effect v4** (`effect@4.x`). Effect v4 is the standard framework and first choice for extensions requiring async orchestration, mutable state, lifecycle control, service layers, and typed error handling. The root `tsconfig.json` configures the compiler options and `@effect/language-service` plugin for the entire monorepo, while package-level `tsconfig.json` files extend `../../tsconfig.json`.
- pi runtime packages (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui`, `typebox`) are **peer dependencies** — pi provides them at runtime; they must not be bundled. They are also root `devDependencies` so every workspace resolves them via pnpm's `resolvePeersFromWorkspaceRoot` and the shared typecheck works without per-package duplication.
- `effect-tsgo patch` (the editor language-service binary patch) is declared **only** by `pi-background-terminals`. pnpm runs every workspace project's `prepare` during `pnpm install`, and two concurrent patches of the same TypeScript binary race on the backup rename; other Effect packages intentionally omit `prepare` and rely on the shared patched binary.
- Tooling: pnpm workspaces (`pnpm-workspace.yaml`), `tsc` for typecheck-only, Node's built-in `node --test` runner, GitHub Actions for publishing. Dependency overrides live in `pnpm-workspace.yaml` (`overrides:`), not in `package.json`.

## Repository layout

- `packages/` — one publishable workspace per extension. Real implementation lives here, mostly as `index.ts` (+ `lib/*.ts` helpers), except Effect-based packages also ship `src/**` runtimes (`pi-background-terminals`, `pi-commit`, `pi-goal`, `pi-image-cache`, `pi-repo-model`, `pi-repo-skills`, `pi-subagents`, `pi-todo`, `pi-token-speed`, `pi-usage`, `pi-vscode-bridge`, `pi-web-search`). The pnpm workspace configuration (`packages/*` globs in `pnpm-workspace.yaml`) dynamically discovers all extension packages for checks, tests, and publishing.
- `extensions/` — thin re-export stubs (`export { default } from "../packages/<pkg>/index"`) kept only as compatibility entry points for the legacy aggregate Git package. **Do not put logic here** — edit the matching `packages/*` instead.
- `tests/` — repo-level tests run from the root (currently `pi-usage-providers.test.mjs`). Package-local tests live under `test/` (or next to source for `pi-background-terminals`).
- `.github/workflows/publish.yml` — npm publish on push to `main` (installs with pnpm, runs typecheck, workspace checks, and tests dynamically across all packages, then publishes via the npm CLI for OIDC trusted publishing).
- `pnpm-workspace.yaml` — workspace globs and dependency overrides.
- `pnpm-lock.yaml` — pnpm lockfile (do not commit `package-lock.json`).
- `tsconfig.json` — root typecheck config covering all extensions and workspace packages.
- `mise.toml` — tooling pins (Node, pnpm).

Workspace → npm package map: `pi-repo-model`→`pi-tian-repo-model`, `pi-repo-skills`→`pi-tian-repo-skills`, `pi-commit`→`pi-tian-commit`, `pi-token-speed`→`pi-tian-token-speed`, `pi-image-cache`→`pi-tian-image-cache`, `pi-ask-user`→`pi-tian-ask-user`, `pi-usage`→`pi-tian-usage`, `pi-background-terminals`→`pi-tian-background-terminals`, `pi-edit-safe`→`pi-tian-edit-safe`, `pi-todo`→`pi-tian-todo`, `pi-subagents`→`pi-tian-subagents`, `pi-compact-output`→`pi-tian-compact-output`, `pi-goal`→`pi-tian-goal`, `pi-vscode-bridge`→`pi-tian-vscode-bridge`, `pi-web-search`→`pi-tian-web-search`.

## Common tasks

- Install deps: `pnpm install`
- Typecheck the whole monorepo (all extensions and packages): `pnpm run typecheck`
- Typecheck all Effect packages across workspaces: `pnpm run check`
- Typecheck individual Effect packages (scoped check):
    - `pnpm --filter pi-tian-background-terminals run check`
    - `pnpm --filter pi-tian-commit run check`
    - `pnpm --filter pi-tian-goal run check`
    - `pnpm --filter pi-tian-image-cache run check`
    - `pnpm --filter pi-tian-repo-model run check`
    - `pnpm --filter pi-tian-repo-skills run check`
    - `pnpm --filter pi-tian-subagents run check`
    - `pnpm --filter pi-tian-todo run check`
    - `pnpm --filter pi-tian-token-speed run check`
    - `pnpm --filter pi-tian-usage run check`
    - `pnpm --filter pi-tian-vscode-bridge run check`
    - `pnpm --filter pi-tian-web-search run check`
- Run all tests (repo-level and all package workspaces): `pnpm test`
- Test repo-level (usage providers): `pnpm run test:usage`
- Test individual packages (scoped test):
    - Test `pi-usage` (fetch/runtime): `pnpm --filter pi-tian-usage test`
    - Test `pi-ask-user`: `pnpm --filter pi-tian-ask-user test`
    - Test `pi-commit`: `pnpm --filter pi-tian-commit test`
    - Test `pi-edit-safe`: `pnpm --filter pi-tian-edit-safe test` (45 cases); A/B vs pi's real built-in edit: `pnpm --filter pi-tian-edit-safe run bench`
    - Test `pi-repo-model`: `pnpm --filter pi-tian-repo-model test`
    - Test `pi-repo-skills`: `pnpm --filter pi-tian-repo-skills test`
    - Test `pi-todo`: `pnpm --filter pi-tian-todo test`
    - Test `pi-token-speed`: `pnpm --filter pi-tian-token-speed test`
    - Test `pi-background-terminals`: `pnpm --filter pi-tian-background-terminals test`
    - Test `pi-subagents`: `pnpm --filter pi-tian-subagents test`
    - Test `pi-compact-output`: `pnpm --filter pi-tian-compact-output test`
    - Test `pi-goal`: `pnpm --filter pi-tian-goal test`
    - Test `pi-image-cache`: `pnpm --filter pi-tian-image-cache test`
    - Test `pi-vscode-bridge`: `pnpm --filter pi-tian-vscode-bridge test`; compile its VS Code host with `pnpm --filter pi-tian-vscode-bridge run compile:vscode`
    - Test `pi-web-search`: `pnpm --filter pi-tian-web-search test`
- Inspect publishable tarballs: `pnpm run pack:check`
- Try an extension in a live pi session without installing: `pi -e ./packages/pi-repo-model`
- Publish one workspace manually (after `npm login`): `pnpm --filter pi-tian-repo-model publish --access public --no-git-checks`

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
- Version update policy: bump only the changed package; use a patch release for fixes, a minor release for backward-compatible features, and a major release for breaking changes. Documentation-only changes that do not alter a published package do not require a version bump. Keep `pnpm-lock.yaml` synchronized when package versions change.
- **Temporarily disabling publish:** set `"private": true` in `packages/<pkg>/package.json`. The CI workflow checks this field and automatically skips publishing private packages (`⏭ <name> is private, skipping`). Remove `"private": true` when ready to publish again.

## Working agreement

- Prefer small, reviewable changes; bump and publish only the package(s) that actually changed.
- Always run root `pnpm run typecheck`, `pnpm run check`, and `pnpm test` (or scoped checks `pnpm --filter pi-tian-* run check` / `pnpm --filter pi-tian-* test` for modified packages) before pushing. The publish workflow runs monorepo typecheck, workspace Effect checks, all test suites, and dynamic package publishing across all workspaces.
- Keep this file in sync with real workflows — update it when commands, workspace layout, or publish steps change.
