import { Data } from "effect";

export class RepoSkillsConfigError extends Data.TaggedError("RepoSkillsConfigError")<{
  readonly message: string;
}> {}

export type RepoSkillsError = RepoSkillsConfigError;
