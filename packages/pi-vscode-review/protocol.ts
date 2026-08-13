export type ReviewDecision = "feedback" | "approved" | "cancelled";

export interface ReviewAnnotation {
  filePath: string;
  lineStart: number;
  lineEnd: number;
  side: "old" | "new";
  text: string;
  suggestedCode?: string;
}

export interface ReviewRequest {
  reviewId: string;
  cwd: string;
  diffLabel: string;
  patch: string;
}

export interface ReviewSubmission {
  decision: ReviewDecision;
  annotations: ReviewAnnotation[];
}
