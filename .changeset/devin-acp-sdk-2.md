---
"@tian.zuo/pi-devin-acp": patch
---

Move the ACP imports to `@agentclientprotocol/sdk/unstable` and update the SDK from 1.9.0 to 2.0.0. SDK 2.0 makes the stable v1 schema the default entrypoint and removes the legacy connection classes; the unstable entrypoint is the one that still carries the fields this extension reads (`PromptResponse.usage`, `plan_update`, `plan_removed`). Devin's wire protocol is unchanged, so sessions, usage reporting, and plan rendering keep working.
