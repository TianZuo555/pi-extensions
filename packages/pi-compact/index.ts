// pi-compact — Codex remote compaction via a configurable (cheaper) model.
//
// Fork of @narumitw/pi-codex-compact (MIT) that decouples the compaction model
// from the session model: the opaque checkpoint produced by e.g. gpt-5.6-luna
// replays correctly on sol/terra/astra (verified against the Codex backend), so
// compaction runs at luna prices while the session keeps the expensive model.
//
// Quick try:  pi -e ./packages/pi-compact

export { createCompactExtension, default } from "./src/compact.ts";
