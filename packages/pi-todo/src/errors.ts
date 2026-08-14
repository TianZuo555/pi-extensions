import { Data } from "effect";

export class TodoDuplicateIdError extends Data.TaggedError("TodoDuplicateIdError")<{
  readonly duplicates: number[];
  readonly message: string;
}> {}

export class TodoMissingListError extends Data.TaggedError("TodoMissingListError")<{
  readonly message: string;
}> {}

export class TodoClosedError extends Data.TaggedError("TodoClosedError")<{
  readonly message: string;
}> {}

export type TodoError =
  | TodoDuplicateIdError
  | TodoMissingListError
  | TodoClosedError;
