/**
 * Custom error types for Claude CLI operations
 *
 * These errors allow consumers to pattern match on specific failure scenarios
 * and handle them appropriately (e.g., prompt user to login, retry with backoff).
 */
import { Schema } from 'effect'

/** Claude CLI binary not found or not executable */
export class ClaudeCliNotFoundError extends Schema.TaggedError<ClaudeCliNotFoundError>()(
  'ClaudeCliNotFoundError',
  {
    message: Schema.String,
    cause: Schema.Defect,
  },
) {}

/** User not logged in to Claude CLI */
export class ClaudeCliNotLoggedInError extends Schema.TaggedError<ClaudeCliNotLoggedInError>()(
  'ClaudeCliNotLoggedInError',
  {
    message: Schema.String,
  },
) {}

/** Authentication expired or invalid */
export class ClaudeCliAuthError extends Schema.TaggedError<ClaudeCliAuthError>()(
  'ClaudeCliAuthError',
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

/** CLI exited with non-zero code (fallback for unrecognized errors) */
export class ClaudeCliExitError extends Schema.TaggedError<ClaudeCliExitError>()(
  'ClaudeCliExitError',
  {
    message: Schema.String,
    exitCode: Schema.Number,
    stderr: Schema.String,
    stdout: Schema.String,
    command: Schema.String,
  },
) {}

/** Failed to parse JSON response from CLI */
export class ClaudeCliParseError extends Schema.TaggedError<ClaudeCliParseError>()(
  'ClaudeCliParseError',
  {
    message: Schema.String,
    rawOutput: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

/** Rate limited by Claude API */
export class ClaudeCliRateLimitError extends Schema.TaggedError<ClaudeCliRateLimitError>()(
  'ClaudeCliRateLimitError',
  {
    message: Schema.String,
  },
) {}

/** Union type for pattern matching on all Claude CLI errors */
export type ClaudeCliError =
  | ClaudeCliNotFoundError
  | ClaudeCliNotLoggedInError
  | ClaudeCliAuthError
  | ClaudeCliExitError
  | ClaudeCliParseError
  | ClaudeCliRateLimitError
