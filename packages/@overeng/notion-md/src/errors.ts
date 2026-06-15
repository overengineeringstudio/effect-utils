import { Schema } from 'effect'

import { PropertyWriteGuardName } from '@overeng/notion-property-write'

import { NonBodyGuardName } from './non-body-guards.ts'

/** Raised when a local `.nmd` file is missing or has malformed frontmatter. */
export class NmdFrontmatterError extends Schema.TaggedError<NmdFrontmatterError>()(
  'NmdFrontmatterError',
  {
    path: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

/** Raised when `.nmd` frontmatter points at an invalid local object-store entry. */
export class NmdObjectStoreError extends Schema.TaggedError<NmdObjectStoreError>()(
  'NmdObjectStoreError',
  {
    path: Schema.String,
    object_path: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

/** Raised when local and remote edits cannot be reconciled automatically. */
export class NmdConflictError extends Schema.TaggedError<NmdConflictError>()('NmdConflictError', {
  path: Schema.String,
  page_id: Schema.String,
  message: Schema.String,
  local_changed: Schema.Boolean,
  remote_changed: Schema.Boolean,
  conflict_path: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect),
}) {}

/** Raised when local filesystem IO fails while reading or writing sync state. */
export class NmdFileSystemError extends Schema.TaggedError<NmdFileSystemError>()(
  'NmdFileSystemError',
  {
    operation: Schema.String,
    path: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

/** Raised when a Notion gateway operation fails at the API boundary. */
export class NmdGatewayError extends Schema.TaggedError<NmdGatewayError>()('NmdGatewayError', {
  operation: Schema.String,
  page_id: Schema.optional(Schema.String),
  block_id: Schema.optional(Schema.String),
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

/** Raised when remote Markdown cannot safely become a clean body base. */
export class NmdRemoteBodyLossyError extends Schema.TaggedError<NmdRemoteBodyLossyError>()(
  'NmdRemoteBodyLossyError',
  {
    operation: Schema.String,
    page_id: Schema.String,
    path: Schema.optional(Schema.String),
    reasons: Schema.Array(Schema.String),
    message: Schema.String,
  },
) {}

/**
 * Raised when the shared property-write core refuses a datasource-scoped
 * property write. Carries the violated guard name and the page/property it
 * blocked so the refusal is observable rather than a silent drop.
 *
 * Also raised when a `source: 'remote'` page (Notion authoritative) attempts a
 * local property mutation: the standalone proof provider refuses to mint a
 * proof, since a local write against a Notion-authoritative page is drift.
 */
export class NmdPropertyWriteBlockedError extends Schema.TaggedError<NmdPropertyWriteBlockedError>()(
  'NmdPropertyWriteBlockedError',
  {
    page_id: Schema.String,
    property_name: Schema.String,
    /**
     * The violated property-write guard name. Drawn from the shared
     * {@link PropertyWriteGuardName} vocabulary, including the provider-emitted
     * `RemoteAuthoritativeDrift` used for the `source: 'remote'` refusal.
     */
    guard: PropertyWriteGuardName,
    message: Schema.String,
  },
) {}

/**
 * Raised when a non-body write boundary (files/media this phase) refuses a
 * write that would carry a payload notion-md cannot durably transfer yet.
 * Carries the violated {@link NonBodyGuardName} and the offending file ids so
 * the refusal is observable rather than a silent drop (R13).
 */
export class NmdNonBodyWriteBlockedError extends Schema.TaggedError<NmdNonBodyWriteBlockedError>()(
  'NmdNonBodyWriteBlockedError',
  {
    page_id: Schema.String,
    /** The violated non-body guard name identifying the missing invariant. */
    guard: NonBodyGuardName,
    message: Schema.String,
    /** Ids of the file units that triggered the block. */
    fileIds: Schema.Array(Schema.String),
  },
) {}

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

/** Expected failures surfaced by the notion-md sync engine. */
export type NmdError =
  | NmdFrontmatterError
  | NmdObjectStoreError
  | NmdConflictError
  | NmdFileSystemError
  | NmdGatewayError
  | NmdRemoteBodyLossyError
  | NmdPropertyWriteBlockedError
  | NmdNonBodyWriteBlockedError
  | NmdCliError
