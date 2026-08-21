# `@tian.zuo/pi-compact-output` implementation guide

## Goal

Build a TUI-only Pi extension that:

- Renders every collapsed tool call as one descriptive terminal line.
- Uses Pi's existing `Ctrl+O` (`app.tools.expand`) action to reveal each tool's original rendering and the complete reasoning text.
- Works with FFF's `grep`, `find`, `ffgrep`, and `fffind` tools without registering over them.
- Keeps persisted italic reasoning to one concise line in compact mode and shows Pi's animated working indicator with `Thinking: <one-line reasoning preview>`.
- Handles GPT-5.6 models that emit several standalone thinking messages and multiple thinking blocks per turn.

The extension must change presentation only. It must not change tool execution, schemas, results, session data, or model context.

## Architecture decision

Do **not** re-register `grep`, `find`, `bash`, `edit`, or any other tool.

The current tool owners include:

- `@ff-labs/pi-fff@0.10.1` for `grep` and `find` in override mode.
- `@tian.zuo/pi-background-terminals` for `bash`.
- `@tian.zuo/pi-edit-safe` for `edit`.

Pi exposes per-tool renderers but no public global tool-renderer decorator. `pi.getAllTools()` returns metadata, not executable definitions or renderers, so it cannot safely proxy third-party tools.

For Pi 0.83, implement a small, guarded presentation patch around the exported TUI classes:

- `ToolExecutionComponent`
- `AssistantMessageComponent`

This patch runs after Pi has selected the real tool definition and renderer. Consequently, load order does not affect FFF or the other tool overrides.

This relies on Pi internals. Keep all internal field access in one adapter, gate it to Pi 0.83.x, fail safely, and make it reversible.

## User-visible behavior

### Collapsed tool calls

A tool component must render exactly one line while collapsed:

```text
… grep /registerTool/ in packages
✓ read packages/pi-commit/index.ts
✗ edit packages/foo.ts — oldText not found
```

Rules:

- Use `…` while pending, `✓` after success, and `✗` after failure.
- Prefer the first visually non-empty line from the tool's own `renderCall()` component.
- Do not show successful result output while collapsed.
- For failures only, append the first error line if space permits.
- Do not show a surrounding box, blank spacer, preview, diff, image, or search matches.
- Use `truncateToWidth()` so the result never exceeds the terminal width.
- A collapsed `render()` call must return zero or one array element.
- Preserve intentionally hidden components by returning `[]` when Pi marked the component hidden.

### Expanded tool calls

When Pi marks a tool component expanded, call its original `render(width)` method and return the output unchanged.

Do not create a new shortcut. Pi already binds `Ctrl+O` to `app.tools.expand`, which globally toggles all tool rows.

Returning the original rendering preserves:

- FFF search results and pagination notices.
- Read output.
- Edit diffs.
- Background-terminal rendering and `/ps` hints.
- Images.
- Errors.
- Streaming and custom tool renderers.

"Original rendering" means the tool owner's current expanded behavior. Do not attempt to invent a raw-output viewer for tools that intentionally keep their own expanded output bounded.

### Reasoning

While Pi is working, display only its normal animated indicator with a one-line preview:

```text
<spinner> Thinking: # Plan
```

The compact transcript contains one persisted italic reasoning line. `Ctrl+O` expands assistant messages too, restoring the complete reasoning text through Pi's original renderer.

Rules:

- Call `ctx.ui.setWorkingMessage("Thinking")` in TUI mode and update it from live assistant `message_update` events with the first sanitized reasoning line.
- Keep Pi's default animated working indicator; do not call `setWorkingIndicator()`.
- Replace visual `thinking` content with one sanitized summary line in collapsed mode.
- When the assistant component is expanded, pass the original message to Pi's renderer.
- Preserve text, tool calls, stop reasons, errors, usage, signatures, and every other message property.
- Never mutate the message or its `content` array.

GPT-5.6 Luna/Sol can emit repeated assistant messages containing only thinking between tool rounds. Summarizing each block keeps the transcript compact while the live working indicator supplies one spinner plus the current one-line preview.

## Package layout

Create:

```text
packages/pi-compact-output/
├── index.ts
├── lib/
│   ├── compact-tool-line.ts
│   └── patch-ui-components.ts
├── test/
│   ├── compact-tool-line.test.ts
│   └── patch-ui-components.test.ts
├── package.json
├── README.md
└── LICENSE

extensions/compact-output.ts
```

The compatibility stub must contain only:

```ts
export { default } from "../packages/pi-compact-output/index";
```

Use this package identity:

```json
{
  "name": "@tian.zuo/pi-compact-output",
  "version": "0.1.0"
}
```

The package must ship uncompiled TypeScript. Follow the repository's erasable-syntax-only rule: no enums, namespaces, or constructor parameter properties.

Use a narrow peer requirement because this package patches a Pi 0.83 runtime shape:

```json
{
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": ">=0.83.0 <0.84.0",
    "@earendil-works/pi-tui": "*"
  }
}
```

Use this test script:

```json
{
  "scripts": {
    "test": "node --test --experimental-strip-types test/*.test.ts"
  }
}
```

## Implementation steps

### 1. Build the compact tool-line helper

Implement `lib/compact-tool-line.ts` as a pure helper where practical.

It should receive a narrow view of the current tool component and the render width. Keep Pi's runtime-private fields behind one interface:

```ts
interface ToolExecutionInternals {
  toolName: string;
  args: unknown;
  callRendererComponent?: Component;
  isPartial: boolean;
  result?: {
    isError?: boolean;
    content?: Array<{
      type: string;
      text?: string;
    }>;
  };
  hideComponent?: boolean;
}
```

Algorithm:

1. If `hideComponent` is true, return no line.
2. Render `callRendererComponent` using the available width.
3. Select its first visually non-empty line.
4. Remove trailing padding without stripping ANSI styling.
5. If no rendered call line exists, generate a conservative fallback summary.
6. Prefix the status marker.
7. For an error result, append the first non-empty text result line.
8. Collapse embedded newlines/whitespace in fallback values.
9. Truncate the final string with `truncateToWidth()`.

Use these fallback fields only:

- `bash`: `command`
- `read`, `write`, `edit`: `path`
- `grep`: `pattern`, then `path`
- `find`: `pattern`, then `path`
- `web_search`: `query`
- `web_fetch`: `url`
- `todo`: `operation`
- `mcp`: `tool` or `action`
- Unknown tools: tool name only

Do not stringify arbitrary arguments. They may contain secrets, file content, replacement text, image data, or long prompts.

### 2. Patch `ToolExecutionComponent`

In `lib/patch-ui-components.ts`:

1. Save the current `ToolExecutionComponent.prototype.render` method.
2. Save the current `ToolExecutionComponent.prototype.setExpanded` method.
3. Keep expanded state in a `WeakMap<ToolExecutionComponent, boolean>`.
4. Replace `setExpanded` with a wrapper that records the value and then calls the saved method.
5. Replace `render` with a wrapper:
   - If expanded, call the saved render method unchanged.
   - Otherwise return the compact line.
   - On an unexpected object shape or exception, call the saved render method rather than crashing Pi.

Do not patch `updateDisplay()`. Pi and third-party tools must remain responsible for creating and updating their renderer components.

The interactive mode calls `setExpanded()` for tool components, so the wrapper follows Pi's existing expansion state. Treat a missing WeakMap entry as collapsed.

### 3. Patch `AssistantMessageComponent`

Save `AssistantMessageComponent.prototype.updateContent` and replace it with a wrapper. Add a presentation-only `setExpanded` method to `AssistantMessageComponent` so Pi's existing `app.tools.expand` traversal includes reasoning components.

When collapsed and `message.content` contains thinking blocks, create a shallow visual clone:

```ts
const summary = compactThinkingSummary(message);
const displayMessage = {
  ...message,
  content: summary
    ? message.content.map((part) =>
        part.type === "thinking" ? { ...part, thinking: summary } : part,
      )
    : message.content.filter((part) => part.type !== "thinking"),
};

originalUpdateContent.call(this, displayMessage);
```

Call the original method with the original message when expanded or when there are no thinking blocks. Keep the raw message in a side map because Pi's `invalidate()` replays the display clone.

This intentionally leaves the actual session message unchanged. It also lets the original component continue handling:

- Final text.
- Tool-call detection.
- Maximum-length errors.
- Aborted requests.
- Provider errors.
- OSC shell-integration markers.

### 4. Make patch installation safe

Use `Symbol.for("@tian.zuo/pi-compact-output.patch-state")` on `globalThis` to hold shared patch state.

The state should contain:

- Saved original methods.
- Installed wrapper methods.
- A reference count.
- The tool and assistant expanded-state WeakMaps.
- The raw assistant-message map used to restore full reasoning after invalidation.
- Installation status or an unsupported-version reason.

Requirements:

- Installing twice increments the reference count instead of stacking wrappers.
- Releasing decrements it.
- Restore the saved methods only when the count reaches zero.
- Restoration is idempotent.
- Before restoring a method, verify that the prototype still contains this extension's wrapper so a later extension is not overwritten.
- Catch errors at the presentation boundary and fall back to Pi's original methods.

Import Pi's `VERSION` and support only `0.83.x`. On any other version:

- Do not patch either prototype.
- Keep Pi's original rendering.
- Store a diagnostic reason.
- Show one warning during `session_start` in TUI mode.

### 5. Wire the extension lifecycle

In `packages/pi-compact-output/index.ts`:

1. Install the UI patches immediately when the extension factory runs. This ensures transcript components created during startup or `/reload` use the patched methods.
2. On `session_start` and `agent_start`:
   - If `ctx.mode === "tui"`, call `ctx.ui.setWorkingMessage("Thinking")`.
   - If patch installation was rejected, notify the user once.
3. On assistant `message_start`/`message_update`, set `Thinking: <one-line preview>` in TUI mode.
4. On `agent_end` and `session_shutdown`:
   - Restore the default working message with `ctx.ui.setWorkingMessage()` in TUI mode.
   - Release the prototype patch once.

Do not register a tool, keyboard shortcut, or command.

## FFF compatibility requirements

FFF's renderers already understand Pi's `expanded` option. The compact-output extension must sit outside those renderers:

- Collapsed: display only the first call-description line.
- Expanded: invoke the complete original `ToolExecutionComponent.render()` result.

Test FFF-like definitions using all names:

- `grep`
- `find`
- `ffgrep`
- `fffind`

Verify that:

1. Collapsed output contains the query/pattern and location.
2. Match/result lines are absent while collapsed.
3. Expanded output exactly matches the original renderer.
4. Pagination/truncation notices return when expanded.
5. The extension makes zero calls to `pi.registerTool()`.
6. The extension does not import FFF or depend on its package.

Do not inspect FFF source information or depend on extension load order. The post-render presentation approach must work for any final owner of those tool names.

## Test plan

At minimum, add tests for:

1. A collapsed tool returns exactly one line.
2. Widths `120`, `20`, and `1` never overflow.
3. Pending, success, and error markers are correct.
4. An error includes a bounded first error line.
5. Successful result output is absent while collapsed.
6. Expanded rendering is byte-for-byte identical to the saved original renderer.
7. Images are absent collapsed and restored by the original expanded renderer.
8. An intentionally hidden component stays hidden.
9. Unknown-tool fallback does not stringify a secret argument.
10. FFF-style grep/find results disappear collapsed and return expanded.
11. A self-shell/background-terminal style component compacts correctly.
12. A GPT-5.6 fixture with several headings in a thinking block renders no reasoning.
13. Several consecutive thinking blocks render no reasoning.
14. Several separate thinking-only assistant messages each render no transcript lines.
15. Thinking followed by final text preserves the final text.
16. Length, aborted, and error stop reasons remain visible.
17. Frozen input messages prove the wrapper does not mutate session data.
18. Installation is idempotent.
19. Restoration restores the exact saved methods.
20. Unsupported Pi versions leave original rendering active.
21. A fake Pi registration object proves the extension never calls `registerTool()`.

Use real `ToolExecutionComponent` and `AssistantMessageComponent` instances for at least one integration test. Pure helpers and fake components can cover narrow formatting cases.

## Repository integration

Update these existing files surgically:

- Root `package.json`
  - Add `extensions/compact-output.ts` to the aggregate Pi extension list.
  - The new pnpm workspace is discovered automatically through the existing `packages/*` pattern in `pnpm-workspace.yaml`.
  - Add `test:compact-output` if root scripts expose per-package tests.
  - Update the Pi development dependency from 0.80 to `^0.83.0` so tests use the supported runtime shape.
- `pnpm-lock.yaml`
  - Synchronize the new workspace and dependency version.
- `.github/workflows/publish.yml`
  - Add a `@tian.zuo/pi-compact-output` test step before publishing.
- `README.md`
  - Add the extension table row.
  - Add install commands and npm link.
  - Explain one-line tool rows and `Ctrl+O`.
  - Explain that reasoning remains in session data but is hidden visually.
  - Document the Pi 0.83 requirement.
- `AGENTS.md`
  - Add the workspace-to-package mapping.
  - Add the package test command.
  - Include the new suite in the workflow description.
- `extensions/compact-output.ts`
  - Keep it as the one-line re-export only.

## Verification commands

Run the full relevant checks:

```bash
pnpm install
pnpm run typecheck
pnpm --filter @tian.zuo/pi-background-terminals run check
pnpm --filter @tian.zuo/pi-compact-output test
pnpm --filter @tian.zuo/pi-background-terminals test
pnpm --filter @tian.zuo/pi-ask-user test
pnpm --filter @tian.zuo/pi-commit test
pnpm --filter @tian.zuo/pi-edit-safe test
pnpm --filter @tian.zuo/pi-subagents test
pnpm run pack:check
```

Then smoke-test the extension without installing it:

```bash
pi -e ./packages/pi-compact-output
```

Manual acceptance test:

1. Start a GPT-5.6 Luna or Sol turn that performs several searches and edits.
2. Confirm only one live spinner row labeled `Thinking` appears.
3. Confirm no italic reasoning or repeated hidden-thinking labels remain afterward.
4. Confirm every tool call occupies one line by default.
5. Confirm FFF still executes `grep` and `find` and returns correct results to the model.
6. Press `Ctrl+O` and confirm the original detailed tool renderers return.
7. Press `Ctrl+O` again and confirm all tool rows return to one line.
8. Run an edit that fails and verify the collapsed row contains a short error.
9. Run an image-producing tool and verify the image appears only when expanded.
10. Run `/reload` and repeat the expansion test to catch stacked prototype wrappers.

## Acceptance criteria

The work is complete only when all of these are true:

- No tool is registered, replaced, proxied, or executed by this extension.
- Every non-hidden collapsed tool component is one line.
- `Ctrl+O` returns each tool's exact original renderer.
- FFF override and non-override names both work.
- Existing `bash` and `edit` overrides still own execution.
- Persisted thinking rows are absent, including GPT-5.6's repeated blocks.
- The normal animated `Thinking` working row remains visible during generation.
- Session messages and LLM context are unchanged.
- `/reload` does not stack patches.
- Unsupported Pi versions fail safely to normal rendering.
- Both repository typechecks and all relevant tests pass.
- The publishable tarball includes all required source and documentation files.

## Working-tree warning

The repository already contains unrelated, unfinished usage and subagent changes. Do not reset, rewrite, stash, or clean them. Several root files required by this implementation are already modified, including `.github/workflows/publish.yml`, `AGENTS.md`, `README.md`, `package.json`, and `package-lock.json`. Merge into those files with small edits and preserve all existing changes. Leave `packages/pi-usage/**`, `tests/pi-usage-providers.test.mjs`, `docs/subagent-*`, `extensions/subagents.ts`, and `packages/pi-subagents/**` untouched except where an existing shared root list genuinely needs the new compact-output entry.
