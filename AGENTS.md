# AGENTS.md

A collection of extensions for the [pi coding agent](https://pi.dev): per-repo model defaults, per-repo skill toggles, dedicated-model Git commits, token-speed meter, pasted-image cache, an ask-user tool, provider usage display, and background-yielding bash. Published as independent npm packages from one npm-workspace monorepo.

## Tech stack
- Language: TypeScript (strict, `noEmit`, `target: ES2022`, `module: ESNext`, `moduleResolution: bundler`). Source is shipped as-is — there is **no build step**; the `lib/` and `src/` directories under each package are committed TypeScript, not compiled output.
- Runtime: Node 26 (pinned in `mise.toml`). Type-only ESM.
- pi runtime packages (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui`, `typebox`) are **peer dependencies** — pi provides them at runtime; they must not be bundled.
- `pi-background-terminals` additionally uses **Effect v4** (`effect`, `@effect/language-service`, `@effect/tsgo`) and has its own tsconfig. Its prerelease `effect` runtime is pinned exactly to the tested beta.
- Tooling: npm workspaces, `tsc` for typecheck-only, Node's built-in `node --test` runner, GitHub Actions for publishing.

## Repository layout
- `packages/` — one publishable workspace per extension. Real implementation lives here, mostly as `index.ts` (+ `lib/*.ts` helpers), except `pi-background-terminals` which uses `index.ts` + `src/**`.
- `extensions/` — thin re-export stubs (`export { default } from "../packages/<pkg>/index"`) kept only as compatibility entry points for the legacy aggregate Git package. **Do not put logic here** — edit the matching `packages/*` instead.
- `tests/` — repo-level tests run from the root (currently `pi-usage-providers.test.mjs`). `pi-commit` keeps tests under `test/`; `pi-background-terminals` keeps its `*.test.ts` files next to source.
- `.github/workflows/publish.yml` — npm publish on push to `main`.
- `tsconfig.json` — root typecheck config. **Excludes `pi-background-terminals`** (it carries its own `tsconfig.json`).
- `mise.toml`, `package-lock.json` — tooling/lockfile.

Workspace → npm package map: `pi-repo-model`→`pi-tian-repo-model`, `pi-repo-skills`→`pi-tian-repo-skills`, `pi-commit`→`pi-tian-commit`, `pi-token-speed`→`pi-tian-token-speed`, `pi-image-cache`→`pi-tian-image-cache`, `pi-ask-user`→`pi-tian-ask-user`, `pi-usage`→`pi-tian-usage`, `pi-background-terminals`→`pi-tian-background-terminals`.

## Common tasks
- Install deps: `npm install`
- Typecheck (the 7 simple extensions): `npm run typecheck`
- Typecheck `pi-background-terminals` (not covered by the root command; run separately locally and in CI): `npm run check -w pi-tian-background-terminals`
- Test repo-level (usage providers): `npm run test:usage`
- Test `pi-commit`: `npm test -w pi-tian-commit`
- Test `pi-background-terminals`: `npm test -w pi-tian-background-terminals`
- Inspect publishable tarballs: `npm run pack:check`
- Try an extension in a live pi session without installing: `pi -e ./packages/pi-repo-model`
- Publish one workspace manually (after `npm login`): `npm publish --workspace packages/pi-repo-model`

## Conventions
- One extension per package; the package `name`/version in each `packages/*/package.json` is the source of truth for npm publishing.
- `files` arrays in each package's `package.json` define tarball contents — add new source files there when they should ship (e.g. `lib`, `src`, `docs`).
- Machine-local state (per-repo prefs, caches, tokens) lives under `~/.pi/...`, never inside a repo. Extensions read credentials pi already writes to `~/.pi/agent/auth.json`.
- Keep `extensions/*.ts` as one-line re-export stubs; real code goes in `packages/*`.
- When changing an extension, bump that package's `version` to trigger an npm release — CI compares the local version against the registry and publishes only unpublished versions, with provenance.

## Working agreement
- Prefer small, reviewable changes; bump and publish only the package(s) that actually changed.
- Always run **both** typechecks before pushing: `npm run typecheck` (root) **and** `npm run check -w pi-tian-background-terminals`. The publish workflow runs both plus the commit and background-terminals test suites before publishing.
- Keep this file in sync with real workflows — update it when commands, workspace layout, or publish steps change.
