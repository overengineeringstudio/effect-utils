/**
 * Error types for path operations with rich metadata.
 *
 * Each error captures contextual information useful for debugging and error handling.
 * All errors extend Schema.TaggedError for Effect integration.
 */

import { Schema } from 'effect'

// ═══════════════════════════════════════════════════════════════════════════
// Invalid Path Error
// ═══════════════════════════════════════════════════════════════════════════

/** Reason why a path string is invalid */
export const InvalidPathReason = Schema.Literal(
  'empty',
  'null_byte',
  'invalid_characters',
  'reserved_name',
  'too_long',
)
export type InvalidPathReason = typeof InvalidPathReason.Type

/** Path string is malformed or contains invalid characters */
export class InvalidPathError extends Schema.TaggedError<InvalidPathError>()('InvalidPathError', {
  /** The path that caused the error */
  path: Schema.String,
  /** Human-readable error message */
  message: Schema.String,
  /** Specific reason for invalidity */
  reason: InvalidPathReason,
  /** Position in path where error was detected (if applicable) */
  position: Schema.UndefinedOr(Schema.Number),
}) {}

// ═══════════════════════════════════════════════════════════════════════════
// Absolute/Relative Errors
// ═══════════════════════════════════════════════════════════════════════════

/** Expected absolute path but got relative */
export class NotAbsoluteError extends Schema.TaggedError<NotAbsoluteError>()('NotAbsoluteError', {
  /** The path that caused the error */
  path: Schema.String,
  /** Human-readable error message */
  message: Schema.String,
  /** Suggestion: resolved absolute path if we can compute it */
  suggestedAbsolute: Schema.UndefinedOr(Schema.String),
}) {}

/** Expected relative path but got absolute */
export class NotRelativeError extends Schema.TaggedError<NotRelativeError>()('NotRelativeError', {
  /** The path that caused the error */
  path: Schema.String,
  /** Human-readable error message */
  message: Schema.String,
  /** The absolute prefix that was found (e.g., "/" or "C:\") */
  absolutePrefix: Schema.String,
}) {}

// ═══════════════════════════════════════════════════════════════════════════
// File/Directory Errors
// ═══════════════════════════════════════════════════════════════════════════

/** Expected a file but found a directory */
export class NotAFileError extends Schema.TaggedError<NotAFileError>()('NotAFileError', {
  /** The path that caused the error */
  path: Schema.String,
  /** Human-readable error message */
  message: Schema.String,
  /** Actual type found */
  actualType: Schema.Literal('directory'),
}) {}

/** Expected a directory but found a file */
export class NotADirectoryError extends Schema.TaggedError<NotADirectoryError>()(
  'NotADirectoryError',
  {
    /** The path that caused the error */
    path: Schema.String,
    /** Human-readable error message */
    message: Schema.String,
    /** Actual type found */
    actualType: Schema.Literal('file'),
  },
) {}

/** Path does not follow expected convention (trailing slash for dirs, no trailing for files) */
export class ConventionError extends Schema.TaggedError<ConventionError>()('ConventionError', {
  /** The path that caused the error */
  path: Schema.String,
  /** Human-readable error message */
  message: Schema.String,
  /** What was expected */
  expected: Schema.Literal('file', 'directory'),
  /** What convention violation was found */
  violation: Schema.Literal('trailing_slash_on_file', 'no_trailing_slash_on_directory'),
}) {}

// ═══════════════════════════════════════════════════════════════════════════
// Filesystem Errors
// ═══════════════════════════════════════════════════════════════════════════

/** Path does not exist on filesystem */
export class PathNotFoundError extends Schema.TaggedError<PathNotFoundError>()(
  'PathNotFoundError',
  {
    /** The path that was not found */
    path: Schema.String,
    /** Human-readable error message */
    message: Schema.String,
    /** The deepest existing ancestor path */
    nearestExisting: Schema.UndefinedOr(Schema.String),
    /** What was expected to exist */
    expectedType: Schema.UndefinedOr(Schema.Literal('file', 'directory', 'any')),
  },
) {}

/** Expected a symlink but path is not a symlink */
export class NotASymlinkError extends Schema.TaggedError<NotASymlinkError>()('NotASymlinkError', {
  /** The path that was expected to be a symlink */
  path: Schema.String,
  /** Human-readable error message */
  message: Schema.String,
  /** Actual type found */
  actualType: Schema.Literal('file', 'directory'),
}) {}

/** Circular symlink detected during resolution */
export class SymlinkLoopError extends Schema.TaggedError<SymlinkLoopError>()('SymlinkLoopError', {
  /** The path where the loop was detected */
  path: Schema.String,
  /** Human-readable error message */
  message: Schema.String,
  /** The symlink chain that was followed before loop detected */
  chain: Schema.Array(Schema.String),
  /** The symlink that points back to earlier in chain */
  loopingLink: Schema.String,
}) {}

// ═══════════════════════════════════════════════════════════════════════════
// Security Errors
// ═══════════════════════════════════════════════════════════════════════════

/** Path escapes sandbox/jail directory */
export class TraversalError extends Schema.TaggedError<TraversalError>()('TraversalError', {
  /** The path that attempted to escape */
  path: Schema.String,
  /** Human-readable error message */
  message: Schema.String,
  /** The sandbox root that was being enforced */
  sandboxRoot: Schema.String,
  /** The resolved path that escaped (if computable) */
  escapedTo: Schema.UndefinedOr(Schema.String),
  /** Segments that caused escape (e.g., too many ..) */
  escapingSegments: Schema.Array(Schema.String),
}) {}

/** Permission denied accessing path */
export class PermissionError extends Schema.TaggedError<PermissionError>()('PermissionError', {
  /** The path that could not be accessed */
  path: Schema.String,
  /** Human-readable error message */
  message: Schema.String,
  /** Operation that was attempted */
  operation: Schema.Literal('read', 'write', 'execute', 'stat'),
}) {}

// ═══════════════════════════════════════════════════════════════════════════
// Union Types
// ═══════════════════════════════════════════════════════════════════════════

/** Errors that can occur during pure parsing (no filesystem access) */
export type ParseError = InvalidPathError | NotAbsoluteError | NotRelativeError | ConventionError

/** Errors that can occur during filesystem verification */
export type VerifyError =
  | InvalidPathError
  | NotAbsoluteError
  | NotRelativeError
  | PathNotFoundError
  | NotAFileError
  | NotADirectoryError
  | PermissionError

/** Errors that can occur during symlink operations */
export type SymlinkError = PathNotFoundError | NotASymlinkError | SymlinkLoopError | PermissionError

/** Errors that can occur during sandbox operations */
export type SandboxError = TraversalError | PathNotFoundError | PermissionError

/** Any path-related error */
export type AnyPathError =
  | InvalidPathError
  | NotAbsoluteError
  | NotRelativeError
  | ConventionError
  | PathNotFoundError
  | NotAFileError
  | NotADirectoryError
  | NotASymlinkError
  | SymlinkLoopError
  | TraversalError
  | PermissionError
