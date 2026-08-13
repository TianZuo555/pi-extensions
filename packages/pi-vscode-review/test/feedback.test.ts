import assert from "node:assert/strict";
import test from "node:test";
import { formatApproval, formatReviewFeedback } from "../lib/feedback.ts";
import type { ReviewRequest } from "../protocol.ts";

const request: ReviewRequest = {
  reviewId: "review-1",
  cwd: "/tmp/project",
  diffLabel: "Current worktree changes (git diff HEAD)",
  patch: "",
};

test("formats line-addressed feedback by file", () => {
  const output = formatReviewFeedback(request, [
    {
      filePath: "src/app.ts",
      lineStart: 42,
      lineEnd: 48,
      side: "new",
      text: "Move validation before the database call.",
      suggestedCode: "validate(input);",
    },
  ]);

  assert.match(output, /## src\/app\.ts/);
  assert.match(output, /### Lines 42-48 \(new\)/);
  assert.match(output, /Move validation before the database call\./);
  assert.match(output, /\*\*Suggested code:\*\*/);
});

test("formats approval separately from findings", () => {
  assert.equal(
    formatApproval(request),
    "# Code Review\n\nApproved: Current worktree changes (git diff HEAD). No changes requested.",
  );
});
