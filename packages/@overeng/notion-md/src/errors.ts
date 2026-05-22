import { Schema } from 'effect'

/** Raised when a local `.nmd` file is missing or has malformed frontmatter. */
export class NmdFrontmatterError extends Schema.TaggedError<NmdFrontmatterError>()(
  'NmdFrontmatterError',
  {
    path: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

/** Raised when `.nmd` frontmatter points at an invalid or missing sidecar. */
export class NmdSidecarError extends Schema.TaggedError<NmdSidecarError>()('NmdSidecarError', {
  path: Schema.String,
  sidecar_path: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

/** Raised when local and remote edits cannot be reconciled automatically. */
export class NmdConflictError extends Schema.TaggedError<NmdConflictError>()('NmdConflictError', {
  path: Schema.String,
  page_id: Schema.String,
  message: Schema.String,
  local_changed: Schema.Boolean,
  remote_changed: Schema.Boolean,
  conflict_path: Schema.optional(Schema.String),
}) {}

/** Raised when a command needs a Notion token and none was supplied. */
export class NmdTokenMissingError extends Schema.TaggedError<NmdTokenMissingError>()(
  'NmdTokenMissingError',
  {
    message: Schema.String,
  },
) {}

/** Raised for invalid command-line arguments. */
export class NmdCliError extends Schema.TaggedError<NmdCliError>()('NmdCliError', {
  message: Schema.String,
}) {}
