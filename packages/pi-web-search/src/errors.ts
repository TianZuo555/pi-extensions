import { Data } from "effect";

export class WebSearchConfigError extends Data.TaggedError("WebSearchConfigError")<{
  readonly message: string;
  readonly provider?: string;
}> {}

export class WebSearchApiError extends Data.TaggedError("WebSearchApiError")<{
  readonly message: string;
  readonly provider: string;
  readonly status?: number;
}> {}

export class WebSearchTimeoutError extends Data.TaggedError("WebSearchTimeoutError")<{
  readonly message: string;
  readonly provider?: string;
}> {}

export class WebSearchClosedError extends Data.TaggedError("WebSearchClosedError")<{
  readonly message: string;
}> {}

export type WebSearchError =
  | WebSearchConfigError
  | WebSearchApiError
  | WebSearchTimeoutError
  | WebSearchClosedError;
