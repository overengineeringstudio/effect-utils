import { Schema } from 'effect'

/** Raised when session artifact bytes cannot be read from disk. */
export class SessionArtifactReadError extends Schema.TaggedError<SessionArtifactReadError>()(
  'SessionArtifactReadError',
  {
    message: Schema.String,
    path: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

/** Raised when a source record cannot be decoded into its source-of-truth schema. */
export class SessionArtifactDecodeError extends Schema.TaggedError<SessionArtifactDecodeError>()(
  'SessionArtifactDecodeError',
  {
    message: Schema.String,
    sourceId: Schema.String,
    artifactId: Schema.String,
    rawRecord: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

/** Raised when persisted checkpoint state cannot be decoded back into structured data. */
export class SessionCheckpointDecodeError extends Schema.TaggedError<SessionCheckpointDecodeError>()(
  'SessionCheckpointDecodeError',
  {
    message: Schema.String,
    path: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

/** Raised when checkpoint state cannot be encoded or written back to disk. */
export class SessionCheckpointWriteError extends Schema.TaggedError<SessionCheckpointWriteError>()(
  'SessionCheckpointWriteError',
  {
    message: Schema.String,
    path: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

/** Raised when source artifact discovery fails before ingestion can begin. */
export class SessionSourceDiscoveryError extends Schema.TaggedError<SessionSourceDiscoveryError>()(
  'SessionSourceDiscoveryError',
  {
    message: Schema.String,
    sourceId: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

/** Union of all ingest-time failures emitted by the shared session ingestion core. */
export type SessionIngestError =
  | SessionArtifactDecodeError
  | SessionArtifactReadError
  | SessionCheckpointDecodeError
  | SessionCheckpointWriteError
  | SessionSourceDiscoveryError
