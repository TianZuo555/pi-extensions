# pi-todo

Release notes: [changelog](https://github.com/TianZuo555/pi-extensions/blob/main/packages/pi-todo/CHANGELOG.md) · [GitHub releases](https://github.com/TianZuo555/pi-extensions/releases)

A small `todo` tool for the **pi coding agent**.

Install: `npm:@tian.zuo/pi-todo` · npm package `@tian.zuo/pi-todo` · workspace `packages/pi-todo`

## What it does

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

## Tests

```bash
pnpm --filter @tian.zuo/pi-todo test
```
