# pi-todo (deprecated)

Release notes: [changelog](https://github.com/TianZuo555/pi-extensions/blob/main/packages/pi-todo/CHANGELOG.md) · [GitHub releases](https://github.com/TianZuo555/pi-extensions/releases)

> **Deprecated:** no longer recommended or actively developed. Use Pi without
> this extension for ordinary single-agent work. The source remains here for
> reference; deprecation does not introduce a replacement tool.

npm package `@tian.zuo/pi-todo` · workspace `packages/pi-todo`

## Why it is deprecated

Inspired by [Why Claude Code Dropped Todos and Slash Commands](https://tonylee.im/en/blog/why-claude-code-dropped-todos-slash-commands/)
by Tony Lee:

- **Remove scaffolding for simple work.** Capable models can track short plans
  in context. Maintaining a separate checklist adds tool calls, repeated list
  writes, and prompt overhead without necessarily improving results.
- **Keep structure where coordination needs it.** Complex, long-running,
  multi-session or multi-agent work can benefit from durable shared state,
  dependencies, blockers, and isolated execution context. That is a task
  coordination layer, not merely a visible todo list.

This extension provides a session-local checklist reconstructed from history,
not cross-session shared state or dependency-aware coordination. Rather than
expand that checklist into mandatory scaffolding, the design direction is to
let the model handle ordinary work and add coordination only when needed.

The article describes Claude Code's Tasks and Skills; those features are not
implemented by this extension or implied to be available in Pi.

## Remove it

```bash
pi remove npm:@tian.zuo/pi-todo
```

Restart Pi or run `/reload` to unload it from an existing session. Remove any
instructions that require the `todo` tool from your own prompts or `AGENTS.md`.

## Historical behavior

- One tool, `todo`, with `write` (replace the whole list) and `read`.
- Items are `{ id, title, status }`. There is no per-item prose field: writes
  resend the entire list every time, so per-item descriptions are paid
  repeatedly and never shown.
- Statuses are `not-started`, `in-progress`, `completed`.
- The list renders through pi's own `ctx.ui.setWidget` above the editor. No
  bespoke widget component.
- Tool metadata stays under 950 serialized characters, enforced by tests.
- `/todos` shows progress, `/todos clear` empties the list.

## The one guard

`write` replaces the whole list, so a partial resend silently deletes items —
no error, nothing in the transcript. Every write is compared against the
previous list, and any **unfinished** item that disappeared is named in the
result:

```text
Todo list updated: 1/2 completed.
Warning: 1 unfinished item disappeared from this write and is now gone:
3. Update the changelog. write replaces the whole list, so resend every item
you still intend to do.
```

Pruning *completed* items is legitimate housekeeping and is never reported.
Duplicate ids are rejected outright, since ids are how later writes address
items.

## State and branching

State lives in tool-result `details`, so branching, forking, and resuming
rebuild the list belonging to that point in history.

## Archived tests

Tests remain as historical reference, but this package no longer declares a
`test` script. Local workspace runs and CI skip them.
