import { Schema } from 'effect'

/** Error when importing a .genie.ts file fails */
export class GenieImportError extends Schema.TaggedError<GenieImportError>()('GenieImportError', {
  genieFilePath: Schema.String,
  message: Schema.String,
  /** The original error that caused the import to fail (for TDZ detection) */
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
  },
) {}

/** Error when a single file fails to generate */
export class GenieFileError extends Schema.TaggedError<GenieFileError>()('GenieFileError', {
  targetFilePath: Schema.String,
  message: Schema.String,
  /** The original error that caused the failure (for TDZ detection) */
  cause: Schema.Defect,
}) {}
