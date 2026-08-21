# AGENTS.md

A collection of independent extensions for the [pi coding agent](https://pi.dev) published as npm packages from a pnpm workspace monorepo.

## Stack & Architecture

- **Runtime & Tooling:** Node 26, pnpm 11 workspaces (`pnpm-workspace.yaml`), TypeScript 7 (strict, `noEmit`, ESM).
- **No Build Step:** Packages ship uncompiled TypeScript directly (`lib/`, `src/`). Use only erasable syntax supported by Node's type stripper: **no `enum`**, **no `namespace`**, and **no constructor parameter properties** (`constructor(readonly x: T)`).
- **Frameworks:** [Effect v4](https://effect.website) (`effect@4.x`) for async orchestration, mutable state, and service layers. Pi runtime packages (`@earendil-works/*`, `typebox`) are peer dependencies provided at runtime; do not bundle them.
- **Monorepo Layout:**
  - `packages/<pkg>/` — source of truth for all extensions.
  - `extensions/<pkg>.ts` — legacy re-export stubs; **never add logic here**.

## Common Commands

- Install: `pnpm install`
- Typecheck: `pnpm run typecheck`
- Effect check: `pnpm run check` (or scoped: `pnpm --filter <pkg> run check`)
- Test all: `pnpm test` (or scoped: `pnpm --filter <pkg> test`)
- Try locally: `pi -e ./packages/<pkg>`

## Core Conventions

- **TUI Width Safety:** All renderers (`Component.render(width)`, `setWidget`, tool renderers) must guarantee `visibleWidth(line) <= width` (e.g., via ANSI-aware truncation or wrapping).
- **Prompt Separation:** Keep all model-facing text (tool descriptions, system prompts, schema strings) in a dedicated `prompt.ts` module (`lib/prompt.ts` or `src/prompt.ts`), separated from runtime execution logic.
- **State & Auth:** Machine-local state and caches belong under `~/.pi/...`, never inside the repository.
- **Publishing & Versioning:** Bump `version` in `packages/<pkg>/package.json` when modifying an extension. To temporarily disable CI publishing for a package, set `"private": true` in its `package.json`.
- **Pre-push Verification:** Ensure `pnpm run typecheck`, `pnpm run check`, and `pnpm test` pass before committing.
