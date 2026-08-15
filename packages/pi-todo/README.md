# pi-todo

A small `todo` tool for the **pi coding agent**. Replaces
[`tintinweb/pi-manage-todo-list`](https://github.com/tintinweb/pi-manage-todo-list),
which is a verbatim clone of GitHub Copilot's `manage_todo_list`.

Install: `npm:pi-tian-todo` · npm package `pi-tian-todo` · workspace `packages/pi-todo`

## Why replace it

The Copilot clone spends **~565 tokens on every request**: a 22-line
`description` holding "When to use" (7 bullets), "When NOT to use" (3), a
"CRITICAL workflow" (5 steps), and a "Todo states" block — plus ~180 tokens of
parameter descriptions, and a ~30-token nag appended to every write result
("Ensure that you continue to use the todo list…").

The cause is structural: it defines **no `promptSnippet` and no
`promptGuidelines`**, so behavioural policy had nowhere to go but the one field
that ships inside the tool schema on every turn. It was written for a harness
that has no such slots; pi has both.

| | Copilot clone | **pi-todo** |
|---|---|---|
| description | ~385 tok | ~55 tok |
| parameter descriptions | ~180 tok | ~50 tok |
| promptGuidelines | none | 2 bullets (~35 tok) |
| per-write nag in the result | ~30 tok | none |
| **total** | **~565 tok** | **~140 tok** |

It also contradicted itself — the description says "Use this tool VERY
frequently", then the write handler warns *"Small todo list (<3 items). This
task might not need a todo list."*

## What this one does

- One tool, `todo`, with `write` (replace the whole list) and `read`.
- Items are `{ id, title, status }`. There is no per-item prose field: writes
  resend the entire list every time, so per-item descriptions are paid
  repeatedly and never shown.
- Statuses are unchanged from the tool it replaces — `not-started`,
  `in-progress`, `completed` — so lists in existing sessions still rebuild.
- The list renders through pi's own `ctx.ui.setWidget` above the editor. No
  bespoke widget component.
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
rebuild the list belonging to that point in history. The session scanner also
accepts results from the old `manage_todo_list` tool, so lists created before
the switch survive.

## Tests

```bash
pnpm --filter pi-tian-todo test
```
