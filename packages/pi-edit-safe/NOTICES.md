# Dependency attribution. none required at runtime beyond what pi bundles,
# but recorded for completeness.

## opencode
- Source: https://github.com/sst/opencode  (`packages/opencode/src/tool/edit.ts`)
- License: MIT, Copyright (c) 2025 opencode
- Used for: algorithmic reference for the line-trimmed, whitespace-normalized,
  escape-normalized fuzzy strategies and the `isDisproportionateMatch` heuristic.
  Re-implemented from scratch; no code copied verbatim.

## pi-coding-agent
- Source: https://github.com/earendil-works/pi  (`core/tools/edit-diff.ts`)
- License: MIT
- Used for: the unicode punctuation normalization table (smart quotes, dash
  variants, special spaces, NFKC) behind the `unicode` fuzzy strategy. Applied
  span-only here (comparison never rewrites file bytes), unlike upstream's
  whole-content normalize-and-restore pipeline.

## cline
- Source: https://github.com/cline/cline  (evals/diff-edits/diff-apply)
- License: MIT
- Used for: original upstream diff-apply concepts (via opencode).

## gemini-cli
- Source: https://github.com/google-gemini/gemini-cli  (editCorrector)
- License: Apache-2.0
- Used for: original upstream edit-correction concepts (via opencode).

## maka-agent
- Source: https://github.com/Maka-Agent/maka-agent
- License: NONE (all rights reserved) — NOT used as a code source.
- Used for: design philosophy only (strict ambiguity handling, full-span
  verification, hard gates before fuzzy matching, throw-on-ambiguity
  orchestration). Reproduced from scratch without referencing its source code.
