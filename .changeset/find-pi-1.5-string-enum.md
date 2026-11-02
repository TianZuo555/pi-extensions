---
"@tian.zuo/pi-find": patch
---

Keep the `output` parameter and result schema typed with pi 1.5. `@earendil-works/pi-ai` 1.5 no longer re-exports TypeBox, so the published `StringEnum` type made `Static` resolve to `unknown`. The tool now builds the same `{ type: "string", enum: [...] }` schema with a local `Type.Unsafe` helper. The emitted JSON Schema and tool behavior do not change.
