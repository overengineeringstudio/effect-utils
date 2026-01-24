/**
 * CLI Errors
 *
 * Tagged error types for CLI commands.
 */

import { Schema } from 'effect'

// =============================================================================
// CLI Errors
// =============================================================================

/** Error when not in a megarepo */
export class NotInMegarepoError extends Schema.TaggedError<NotInMegarepoError>()(
  'NotInMegarepoError',
  {
    message: Schema.String,
  },
) {}

/** Error when lock file is required but missing */
export class LockFileRequiredError extends Schema.TaggedError<LockFileRequiredError>()(
  'LockFileRequiredError',
  {
    message: Schema.String,
  },
) {}

/** Error when lock file is stale */
export class StaleLockFileError extends Schema.TaggedError<StaleLockFileError>()(
  'StaleLockFileError',
  {
    message: Schema.String,
    addedMembers: Schema.Array(Schema.String),
    removedMembers: Schema.Array(Schema.String),
  },
) {}
