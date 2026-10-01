// pi-compact — compaction via a configurable cheaper model (default: GPT-6 Luna).
//
// Fork of @narumitw/pi-codex-compact (MIT) that decouples the compaction model
// from the session model. Legacy Codex uses opaque checkpoints; new OpenAI
// ChatGPT OAuth uses Pi's text summarizer because opaque compaction is forbidden.
//
// Quick try:  pi -e ./packages/pi-compact

export { createCompactExtension, default } from "./src/compact.ts";
