import { Schema } from 'effect'

/** Never attach HTTP responses, request objects, conversion codes, or crypto causes. */
export class AppError extends Schema.TaggedError<AppError>()('GitHubAppResourceError', {
  operation: Schema.String,
  message: Schema.String,
}) {}

export class AppManifestDriftError extends Schema.TaggedError<AppManifestDriftError>()('AppManifestDriftError', {
  permissions: Schema.Array(Schema.Struct({
    permission: Schema.String,
    desired: Schema.optional(Schema.String),
    observed: Schema.optional(Schema.String),
  })),
  events: Schema.optional(Schema.Struct({ desired: Schema.Array(Schema.String), observed: Schema.Array(Schema.String) })),
  remedy: Schema.String,
}) {}

/** Conversion is not transactional with Actions. Do not retry the one-use code automatically. */
export class AppConversionRecoveryError extends Schema.TaggedError<AppConversionRecoveryError>()('AppConversionRecoveryError', {
  message: Schema.String,
}) {}
