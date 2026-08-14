import { Data } from "effect";

export class RepoModelConfigError extends Data.TaggedError("RepoModelConfigError")<{
  readonly message: string;
}> {}

export class RepoModelApplyError extends Data.TaggedError("RepoModelApplyError")<{
  readonly message: string;
}> {}

export type RepoModelError = RepoModelConfigError | RepoModelApplyError;
