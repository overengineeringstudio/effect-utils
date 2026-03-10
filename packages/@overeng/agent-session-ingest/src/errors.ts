import { Schema } from 'effect'

export class SessionArtifactReadError extends Schema.TaggedError<SessionArtifactReadError>()(
  'SessionArtifactReadError',
  {
    message: Schema.String,
    path: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

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

export class SessionCheckpointDecodeError extends Schema.TaggedError<SessionCheckpointDecodeError>()(
  'SessionCheckpointDecodeError',
  {
    message: Schema.String,
    path: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export class SessionCheckpointWriteError extends Schema.TaggedError<SessionCheckpointWriteError>()(
  'SessionCheckpointWriteError',
  {
    message: Schema.String,
    path: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export class SessionSourceDiscoveryError extends Schema.TaggedError<SessionSourceDiscoveryError>()(
  'SessionSourceDiscoveryError',
  {
    message: Schema.String,
    sourceId: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export type SessionIngestError =
  | SessionArtifactDecodeError
  | SessionArtifactReadError
  | SessionCheckpointDecodeError
  | SessionCheckpointWriteError
  | SessionSourceDiscoveryError
