---
"@tian.zuo/pi-beautify-style": patch
---

Address three review findings.

**Narrow terminals.** The footer prepended its editor-alignment indent before clamping the payload, so a width smaller than the indent still emitted at least one payload column plus the full indent — `render(1)` produced three columns. `indentFooterLine` now clamps the indent to the width first and gives the payload whatever remains, down to zero.

**Prompt separation.** The `@session:[...]` header, including the instruction that referenced sessions are untrusted context, was inlined in `extensions/feature/reference/session.ts`. It moved to `lib/prompt.ts` as `SESSION_REFERENCE_HEADER`, next to the subagent delegation text, so all model-facing wording lives in one auditable place.

**Main-screen patch cleanup.** `installMainScreenDoRenderPatch` patched `TuiMainScreen.prototype.applyLineResets` but returned nothing, so unloading the extension left the stale-scrollback behavior active until the process restarted. It now returns an ownership-guarded disposer, called from `session_shutdown`, that restores the original method only when the slot still holds this installation.
