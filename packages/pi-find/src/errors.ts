import { Data } from "effect";

/** The rg or fd binary could not be located or started. */
export class SearchToolMissingError extends Data.TaggedError(
  "SearchToolMissingError",
)<{
  readonly message: string;
  readonly tool: "rg" | "fd";
}> {}

/** The child process ran but reported a real failure (bad glob, unreadable root). */
export class SearchProcessError extends Data.TaggedError("SearchProcessError")<{
  readonly message: string;
  readonly tool: "rg" | "fd";
  readonly exitCode?: number;
}> {}

/** The call itself is malformed, such as an empty pattern or missing path. */
export class SearchInputError extends Data.TaggedError("SearchInputError")<{
  readonly message: string;
}> {}

/** The user or the harness cancelled the search. */
export class SearchAbortedError extends Data.TaggedError("SearchAbortedError")<{
  readonly message: string;
}> {}

export type SearchError =
  | SearchToolMissingError
  | SearchProcessError
  | SearchInputError
  | SearchAbortedError;

/** Convert a typed failure into the Error the pi tool contract expects. */
export function toThrowable(error: SearchError): Error {
  if (error._tag === "SearchAbortedError") {
    const aborted = new Error(error.message);
    aborted.name = "AbortError";
    return aborted;
  }
  return new Error(error.message);
}
