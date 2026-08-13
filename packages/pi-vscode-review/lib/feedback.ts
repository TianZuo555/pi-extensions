import type { ReviewAnnotation, ReviewRequest } from "../protocol.ts";

function safePath(value: string): string {
  return value.replace(/[\r\n]/g, " ").trim() || "(unknown file)";
}

function safeText(value: string): string {
  return value.trim();
}

function renderAnnotation(annotation: ReviewAnnotation): string {
  const range = annotation.lineStart === annotation.lineEnd
    ? `Line ${annotation.lineStart}`
    : `Lines ${annotation.lineStart}-${annotation.lineEnd}`;
  let output = `### ${range} (${annotation.side})\n`;
  const text = safeText(annotation.text);
  if (text) output += `${text}\n`;

  if (annotation.suggestedCode?.trim()) {
    output += `\n**Suggested code:**\n\`\`\`\n${annotation.suggestedCode.trim()}\n\`\`\`\n`;
  }

  return `${output}\n`;
}

/** Convert VS Code annotations into a compact, line-addressed Pi message. */
export function formatReviewFeedback(
  request: ReviewRequest,
  annotations: ReviewAnnotation[],
): string {
  if (annotations.length === 0) {
    return "# Code Review\n\nNo findings were submitted. Continue with the current implementation.";
  }

  const byFile = new Map<string, ReviewAnnotation[]>();
  for (const annotation of annotations) {
    const filePath = safePath(annotation.filePath);
    const existing = byFile.get(filePath) ?? [];
    existing.push(annotation);
    byFile.set(filePath, existing);
  }

  let output = "# Code Review Feedback\n\n";
  output += `**Diff:** ${request.diffLabel}\n\n`;

  for (const [filePath, fileAnnotations] of byFile) {
    output += `## ${filePath}\n\n`;
    for (const annotation of [...fileAnnotations].sort(
      (a, b) => a.lineStart - b.lineStart || a.lineEnd - b.lineEnd,
    )) {
      output += renderAnnotation(annotation);
    }
  }

  output += "\nValidate each finding against the current file before making changes.";
  return output;
}

export function formatApproval(request: ReviewRequest): string {
  return `# Code Review\n\nApproved: ${request.diffLabel}. No changes requested.`;
}
