import { Schema } from 'effect'

import { GenieFile } from './schema.ts'

/**
 * Error when importing a .genie.ts file fails.
 *
 * The `cause` field preserves the original error for TDZ (Temporal Dead Zone) detection.
 * When a shared module throws during ESM initialization, dependent modules receive confusing
 * TDZ errors like "Cannot access 'X' before initialization" instead of the actual error.
 * By preserving the original cause, we can detect TDZ errors and trace back to the root cause.
 *
 * @see {@link ./generation.ts#isTdzError} for TDZ detection logic
 */
export class GenieImportError extends Schema.TaggedError<GenieImportError>()('GenieImportError', {
  genieFilePath: Schema.String,
  message: Schema.String,
  /** The original error - preserved for TDZ detection and root cause analysis */
  cause: Schema.Defect,
}) {}

/** Error when generated file content doesn't match (in check mode) */
export class GenieCheckError extends Schema.TaggedError<GenieCheckError>()('GenieCheckError', {
  targetFilePath: Schema.String,
  message: Schema.String,
}) {}

/** Error when one or more files failed to generate */
export class GenieGenerationFailedError extends Schema.TaggedError<GenieGenerationFailedError>()(
  'GenieGenerationFailedError',
  {
    failedCount: Schema.Number,
    message: Schema.String,
    /** Per-file details including error messages for failed files */
    files: Schema.Array(GenieFile),
  },
) {}

/**
 * Error when a single file fails to generate.
 *
 * The `cause` field preserves the original error for TDZ (Temporal Dead Zone) detection.
 * When multiple genie files import from a shared module that throws, the parallel generation
 * produces a mix of the original error (in one file) and TDZ errors (in dependent files).
 * Preserving the cause allows re-validation to identify which file contains the root cause
 * versus which files failed due to cascading TDZ errors.
 *
 * @see {@link ./generation.ts#errorOriginatesInFile} for root cause attribution
 */
export class GenieFileError extends Schema.TaggedError<GenieFileError>()('GenieFileError', {
  targetFilePath: Schema.String,
  message: Schema.String,
  /** The original error - preserved for TDZ detection and root cause analysis */
  cause: Schema.Defect,
}) {}

/** Error when genie validation fails */
export class GenieValidationError extends Schema.TaggedError<GenieValidationError>()(
  'GenieValidationError',
  {
    message: Schema.String,
  },
) {}

/** Error when a feature is not yet implemented */
export class GenieNotImplementedError extends Schema.TaggedError<GenieNotImplementedError>()(
  'GenieNotImplementedError',
  {
    message: Schema.String,
  },
) {}
