/**
 * Pattern classification for grep.
 *
 * ripgrep needs to be told whether a pattern is a regex or a literal. Asking
 * the model to declare it wastes a parameter and gets it wrong; instead we
 * detect metacharacters and let ripgrep validate its own regex dialect. The
 * runtime retries parser failures as fixed strings. Using JavaScript's RegExp
 * parser here would accept lookarounds that ripgrep rejects and reject some
 * syntax that ripgrep accepts.
 */

const REGEX_METACHARS = /[.*+?^${}()|[\]\\]/;

/**
 * Wildcard-only patterns that mean "dump everything". These cost a full-repo
 * read, blow the output budget, and are never what the caller wants: the
 * intent is almost always to read one file, which `read` does properly.
 */
const WILDCARD_ONLY =
  /^(?:\.[*+]\??|\.|\*|\+|\?|\^|\$|\^\.\*\$?|\(\.\*\)|\[\^\]?\]?)$/;

export type PatternMode = "regex" | "literal";

export interface ClassifiedPattern {
  readonly mode: PatternMode;
  /** True when the pattern only matches "anything", so the call is refused. */
  readonly wildcardOnly: boolean;
}

export function classifyPattern(pattern: string): ClassifiedPattern {
  const trimmed = pattern.trim();
  const hasMeta = REGEX_METACHARS.test(pattern);

  if (hasMeta && WILDCARD_ONLY.test(trimmed)) {
    return { mode: "regex", wildcardOnly: true };
  }

  if (!hasMeta) return { mode: "literal", wildcardOnly: false };
  return { mode: "regex", wildcardOnly: false };
}

/**
 * Smart-case: an all-lowercase pattern searches case-insensitively, any
 * uppercase character makes it exact. This is ripgrep's `--smart-case`, and we
 * mirror the decision locally only to describe it back to the model.
 */
export function isSmartCaseInsensitive(pattern: string): boolean {
  return pattern === pattern.toLowerCase();
}
