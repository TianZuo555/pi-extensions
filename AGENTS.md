# AGENTS.md

A collection of extensions for the [pi coding agent](https://pi.dev): per-repo model defaults, per-repo skill toggles, dedicated-model Git commits, token-speed meter, pasted-image cache, an ask-user tool, provider usage display, background-yielding bash, and a strict edit tool. Published as independent npm packages from one npm-workspace monorepo.

## Tech stack
- Language: TypeScript (strict, `noEmit`, `target: ES2022`, `module: ESNext`, `moduleResolution: bundler`). Source is shipped as-is — there is **no build step**; the `lib/` and `src/` directories under each package are committed TypeScript, not compiled output.
- Runtime: Node 26 (pinned in `mise.toml`). Type-only ESM.
- pi runtime packages (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui`, `typebox`) are **peer dependencies** — pi provides them at runtime; they must not be bundled.
- `pi-background-terminals` and `pi-goal` additionally use **Effect v4** (`effect`, `@effect/language-service`, `@effect/tsgo`) and have their own tsconfigs. Their prerelease `effect` runtime is pinned exactly to the tested beta (`4.0.0-beta.101`).
- `effect-tsgo patch` (the editor language-service binary patch) is declared **only** by `pi-background-terminals`. npm runs every workspace's `prepare` in parallel during `npm install`/`npm ci`, and two concurrent patches of the same TypeScript binary race on the backup rename; `pi-goal` therefore intentionally omits `prepare` and relies on the shared patched binary.
- Tooling: npm workspaces, `tsc` for typecheck-only, Node's built-in `node --test` runner, GitHub Actions for publishing.

## Repository layout
- `packages/` — one publishable workspace per extension. Real implementation lives here, mostly as `index.ts` (+ `lib/*.ts` helpers), except `pi-background-terminals` (`index.ts` + `src/**`) and `pi-goal` (`index.ts` + pure `lib/*.ts` + Effect `src/**`).
- `extensions/` — thin re-export stubs (`export { default } from "../packages/<pkg>/index"`) kept only as compatibility entry points for the legacy aggregate Git package. **Do not put logic here** — edit the matching `packages/*` instead.
- `tests/` — repo-level tests run from the root (currently `pi-usage-providers.test.mjs`). `pi-ask-user`, `pi-commit`, `pi-edit-safe`, `pi-subagents`, `pi-compact-output`, and `pi-goal` keep tests under `test/`; `pi-background-terminals` keeps its `*.test.ts` files next to source.
- `.github/workflows/publish.yml` — npm publish on push to `main`.
- `tsconfig.json` — root typecheck config. **Excludes `pi-background-terminals` and `pi-goal`** (each carries its own `tsconfig.json`).
- `mise.toml`, `package-lock.json` — tooling/lockfile.

Workspace → npm package map: `pi-repo-model`→`pi-tian-repo-model`, `pi-repo-skills`→`pi-tian-repo-skills`, `pi-commit`→`pi-tian-commit`, `pi-token-speed`→`pi-tian-token-speed`, `pi-image-cache`→`pi-tian-image-cache`, `pi-ask-user`→`pi-tian-ask-user`, `pi-usage`→`pi-tian-usage`, `pi-background-terminals`→`pi-tian-background-terminals`, `pi-edit-safe`→`pi-tian-edit-safe`, `pi-todo`→`pi-tian-todo`, `pi-subagents`→`pi-tian-subagents`, `pi-compact-output`→`pi-tian-compact-output`, `pi-goal`→`pi-tian-goal`.

## Common tasks
- Install deps: `npm install`
- Typecheck the simple extensions (everything except the Effect-based ones): `npm run typecheck`
- Typecheck `pi-background-terminals` (not covered by the root command; run separately locally and in CI): `npm run check -w pi-tian-background-terminals`
- Typecheck `pi-goal` (not covered by the root command; run separately locally and in CI): `npm run check -w pi-tian-goal`
- Test repo-level (usage providers): `npm run test:usage`
- Test `pi-ask-user`: `npm test -w pi-tian-ask-user`
- Test `pi-commit`: `npm test -w pi-tian-commit`
- Test `pi-edit-safe`: `npm test -w pi-tian-edit-safe` (45 cases); A/B vs pi's real built-in edit: `npm run bench -w pi-tian-edit-safe`
- Test `pi-todo`: `npm test -w pi-tian-todo`
- Test `pi-background-terminals`: `npm test -w pi-tian-background-terminals`
- Test `pi-subagents`: `npm test -w pi-tian-subagents`
- Test `pi-compact-output`: `npm test -w pi-tian-compact-output`
- Test `pi-goal`: `npm test -w pi-tian-goal`
- Inspect publishable tarballs: `npm run pack:check`
- Try an extension in a live pi session without installing: `pi -e ./packages/pi-repo-model`
- Publish one workspace manually (after `npm login`): `npm publish --workspace packages/pi-repo-model`

## Conventions
- When developing extensions, use **Effect** if possible — prefer `Effect`/`@effect/*` idioms (typed effects, `Effect.gen`, dependency injection via `Context`) over raw async/throw patterns for any non-trivial control flow, following the existing `pi-background-terminals` and `pi-goal` packages as reference implementations.
- One extension per package; the package `name`/version in each `packages/*/package.json` is the source of truth for npm publishing.
- `files` arrays in each package's `package.json` define tarball contents — add new source files there when they should ship (e.g. `lib`, `src`, `docs`).
- Machine-local state (per-repo prefs, caches, tokens) lives under `~/.pi/...`, never inside a repo. Extensions read credentials pi already writes to `~/.pi/agent/auth.json`.
- Packages ship **uncompiled TypeScript**, so all source must use erasable-syntax-only constructs — no `enum`, no namespaces, and no constructor parameter properties (`constructor(readonly x: T)`), which Node's type-stripping loader rejects. Declare the field and assign it in the body instead.
- Keep `extensions/*.ts` as one-line re-export stubs; real code goes in `packages/*`.
- When changing an extension, bump that package's `version` to trigger an npm release — CI compares the local version against the registry and publishes only unpublished versions, with provenance.
- Version update policy: bump only the changed package; use a patch release for fixes, a minor release for backward-compatible features, and a major release for breaking changes. Documentation-only changes that do not alter a published package do not require a version bump. Keep `package-lock.json` synchronized when package versions change.

## Working agreement
- Prefer small, reviewable changes; bump and publish only the package(s) that actually changed.
- Always run **all three** typechecks before pushing: `npm run typecheck` (root) **and** `npm run check -w pi-tian-background-terminals` **and** `npm run check -w pi-tian-goal`. The publish workflow runs all three plus the ask-user, commit, edit-safe, subagents, compact-output, goal, and background-terminals test suites before publishing.
- Keep this file in sync with real workflows — update it when commands, workspace layout, or publish steps change.
