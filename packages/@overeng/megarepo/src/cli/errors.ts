/**
 * CLI Errors
 *
 * Centralized tagged error types for CLI commands.
 * All CLI errors should be defined here to avoid redundancy.
 */

import { Schema } from 'effect'

// =============================================================================
// Common Errors (used across multiple commands)
// =============================================================================

/** Error when not in a megarepo directory */
export class NotInMegarepoError extends Schema.TaggedError<NotInMegarepoError>()(
  'NotInMegarepoError',
  {
    message: Schema.String,
  },
) {}

/** Error when not in a git repository */
export class NotGitRepoError extends Schema.TaggedError<NotGitRepoError>()('NotGitRepoError', {
  message: Schema.String,
}) {}

/** Error when a member is not found */
export class MemberNotFoundError extends Schema.TaggedError<MemberNotFoundError>()(
  'MemberNotFoundError',
  {
    message: Schema.String,
    member: Schema.String,
  },
) {}

// =============================================================================
// Lock File Errors
// =============================================================================

/** Error when lock file is required but missing */
export class LockFileRequiredError extends Schema.TaggedError<LockFileRequiredError>()(
  'LockFileRequiredError',
  {
    message: Schema.String,
  },
) {}

/** Error when lock file is missing */
export class NoLockFileError extends Schema.TaggedError<NoLockFileError>()('NoLockFileError', {
  message: Schema.String,
}) {}

/** Error when lock file is stale */
export class StaleLockFileError extends Schema.TaggedError<StaleLockFileError>()(
  'StaleLockFileError',
  {
    message: Schema.String,
    addedMembers: Schema.Array(Schema.String),
    removedMembers: Schema.Array(Schema.String),
  },
) {}

// =============================================================================
// Source/URL Errors
// =============================================================================

/** Error when source string is invalid */
export class InvalidSourceError extends Schema.TaggedError<InvalidSourceError>()(
  'InvalidSourceError',
  {
    message: Schema.String,
    source: Schema.String,
  },
) {}

/** Error when trying to use local path where remote is required */
export class CannotUseLocalPathError extends Schema.TaggedError<CannotUseLocalPathError>()(
  'CannotUseLocalPathError',
  {
    message: Schema.String,
  },
) {}

/** Error when clone URL cannot be determined */
export class CannotGetCloneUrlError extends Schema.TaggedError<CannotGetCloneUrlError>()(
  'CannotGetCloneUrlError',
  {
    message: Schema.String,
  },
) {}

// =============================================================================
// Sync Errors
// =============================================================================

/** Error when member is not synced */
export class MemberNotSyncedError extends Schema.TaggedError<MemberNotSyncedError>()(
  'MemberNotSyncedError',
  {
    message: Schema.String,
    member: Schema.String,
  },
) {}

/** Error when sync operations fail */
export class SyncFailedError extends Schema.TaggedError<SyncFailedError>()('SyncFailedError', {
  message: Schema.String,
  errorCount: Schema.Number,
  failedMembers: Schema.Array(Schema.String),
}) {}

/** Error when invalid options are provided */
export class InvalidOptionsError extends Schema.TaggedError<InvalidOptionsError>()(
  'InvalidOptionsError',
  {
    message: Schema.String,
  },
) {}

// =============================================================================
// CLI Option Errors
// =============================================================================

/** Error when --cwd path is invalid (doesn't exist or not a directory) */
export class InvalidCwdError extends Schema.TaggedError<InvalidCwdError>()('InvalidCwdError', {
  message: Schema.String,
  path: Schema.String,
}) {}

// =============================================================================
// Command-Specific Errors
// =============================================================================

/** Error in add command */
export class AddCommandError extends Schema.TaggedError<AddCommandError>()('AddCommandError', {
  message: Schema.String,
}) {}

/** Error in exec command */
export class ExecCommandError extends Schema.TaggedError<ExecCommandError>()('ExecCommandError', {
  message: Schema.String,
}) {}

/** Error in generate command */
export class GenerateError extends Schema.TaggedError<GenerateError>()('GenerateError', {
  message: Schema.String,
}) {}

/** Error in store command */
export class StoreCommandError extends Schema.TaggedError<StoreCommandError>()(
  'StoreCommandError',
  {
    message: Schema.String,
  },
) {}
