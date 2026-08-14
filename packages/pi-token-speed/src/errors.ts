import { Data } from "effect";

export class TokenSpeedConfigError extends Data.TaggedError("TokenSpeedConfigError")<{
  readonly message: string;
}> {}

export type TokenSpeedError = TokenSpeedConfigError;
