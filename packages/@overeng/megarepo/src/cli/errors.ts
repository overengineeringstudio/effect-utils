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
export class NotInMegarepoError extends Schema.TaggedErrorClass<NotInMegarepoError>()(
  'NotInMegarepoError',
  {
    message: Schema.String,
  },
) {}

/** Error when not in a git repository */
export class NotGitRepoError extends Schema.TaggedErrorClass<NotGitRepoError>()('NotGitRepoError', {
  message: Schema.String,
}) {}

/** Error when a member is not found */
export class MemberNotFoundError extends Schema.TaggedErrorClass<MemberNotFoundError>()(
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
export class LockFileRequiredError extends Schema.TaggedErrorClass<LockFileRequiredError>()(
  'LockFileRequiredError',
  {
    message: Schema.String,
  },
) {}

/** Error when lock file is missing */
export class NoLockFileError extends Schema.TaggedErrorClass<NoLockFileError>()('NoLockFileError', {
  message: Schema.String,
}) {}

/** Error when lock file is stale */
export class StaleLockFileError extends Schema.TaggedErrorClass<StaleLockFileError>()(
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
export class InvalidSourceError extends Schema.TaggedErrorClass<InvalidSourceError>()(
  'InvalidSourceError',
  {
    message: Schema.String,
    source: Schema.String,
  },
) {}

/** Error when trying to use local path where remote is required */
export class CannotUseLocalPathError extends Schema.TaggedErrorClass<CannotUseLocalPathError>()(
  'CannotUseLocalPathError',
  {
    message: Schema.String,
  },
) {}

/** Error when clone URL cannot be determined */
export class CannotGetCloneUrlError extends Schema.TaggedErrorClass<CannotGetCloneUrlError>()(
  'CannotGetCloneUrlError',
  {
    message: Schema.String,
  },
) {}

// =============================================================================
// Sync Errors
// =============================================================================

/** Error when member is not synced */
export class MemberNotSyncedError extends Schema.TaggedErrorClass<MemberNotSyncedError>()(
  'MemberNotSyncedError',
  {
    message: Schema.String,
    member: Schema.String,
  },
) {}

/** Error when sync operations fail */
export class SyncFailedError extends Schema.TaggedErrorClass<SyncFailedError>()('SyncFailedError', {
  message: Schema.String,
  errorCount: Schema.Number,
  failedMembers: Schema.Array(Schema.String),
}) {}

/** Error when invalid options are provided */
export class InvalidOptionsError extends Schema.TaggedErrorClass<InvalidOptionsError>()(
  'InvalidOptionsError',
  {
    message: Schema.String,
  },
) {}

// =============================================================================
// CLI Option Errors
// =============================================================================

/** Error when --cwd path is invalid (doesn't exist or not a directory) */
export class InvalidCwdError extends Schema.TaggedErrorClass<InvalidCwdError>()('InvalidCwdError', {
  message: Schema.String,
  path: Schema.String,
}) {}

// =============================================================================
// Command-Specific Errors
// =============================================================================

/** Error in add command */
export class AddCommandError extends Schema.TaggedErrorClass<AddCommandError>()('AddCommandError', {
  message: Schema.String,
}) {}

/** Error in exec command */
export class ExecCommandError extends Schema.TaggedErrorClass<ExecCommandError>()(
  'ExecCommandError',
  {
    message: Schema.String,
  },
) {}

/** Error in generate command */
export class GenerateError extends Schema.TaggedErrorClass<GenerateError>()('GenerateError', {
  message: Schema.String,
}) {}

/** Error in store command */
export class StoreCommandError extends Schema.TaggedErrorClass<StoreCommandError>()(
  'StoreCommandError',
  {
    message: Schema.String,
  },
) {}

/** Error when megarepo structural checks fail */
export class CheckCommandError extends Schema.TaggedErrorClass<CheckCommandError>()(
  'CheckCommandError',
  {
    message: Schema.String,
    violationCount: Schema.Number,
  },
) {}
