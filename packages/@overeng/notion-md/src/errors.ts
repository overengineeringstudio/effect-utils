import { Schema } from 'effect'

import { PropertyWriteGuardName } from '@overeng/notion-property-write'

import { DestructiveBodyGuardName, NonBodyGuardName } from './non-body-guards.ts'

/** Raised when a local `.nmd` file is missing or has malformed frontmatter. */
export class NmdFrontmatterError extends Schema.TaggedError<NmdFrontmatterError>()(
  'NmdFrontmatterError',
  {
    path: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/** Raised when `.nmd` frontmatter points at an invalid local object-store entry. */
export class NmdObjectStoreError extends Schema.TaggedError<NmdObjectStoreError>()(
  'NmdObjectStoreError',
  {
    path: Schema.String,
    object_path: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
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
  cause: Schema.optional(Schema.Defect()),
}) {}

/** Raised when local filesystem IO fails while reading or writing sync state. */
export class NmdFileSystemError extends Schema.TaggedError<NmdFileSystemError>()(
  'NmdFileSystemError',
  {
    operation: Schema.String,
    path: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/** Raised when a Notion gateway operation fails at the API boundary. */
export class NmdGatewayError extends Schema.TaggedError<NmdGatewayError>()('NmdGatewayError', {
  operation: Schema.String,
  page_id: Schema.optional(Schema.String),
  block_id: Schema.optional(Schema.String),
  /** Log-safe fingerprint of the active Notion integration token (see `notionTokenFingerprint`). */
  token_fingerprint: Schema.optional(Schema.String),
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
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
 * Raised when a data-source-backed page's writable property schema changed
 * since the clean pull and a property write was attempted (`edit --frontmatter`
 * / file `sync`; exit 6, R14, decision 0017). Distinct from the exit-7
 * value/body conflict and **not** `--force`-able — resolve by re-pulling.
 */
export class NmdSchemaDriftError extends Schema.TaggedError<NmdSchemaDriftError>()(
  'NmdSchemaDriftError',
  {
    page_id: Schema.String,
    data_source_id: Schema.String,
    path: Schema.optional(Schema.String),
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
 * Raised when a non-body write boundary (files/media, comments) refuses a write
 * that would carry a payload or mutation notion-md cannot perform yet. Carries
 * the violated {@link NonBodyGuardName} and the offending unit ids so the
 * refusal is observable rather than a silent drop (R13).
 */
export class NmdNonBodyWriteBlockedError extends Schema.TaggedError<NmdNonBodyWriteBlockedError>()(
  'NmdNonBodyWriteBlockedError',
  {
    page_id: Schema.String,
    /** The violated non-body guard name identifying the missing invariant. */
    guard: NonBodyGuardName,
    message: Schema.String,
    /**
     * Ids of the units that triggered the block — file unit ids for the
     * `DurableFile*` guards, comment unit ids for `CommentWriteUnsupported`.
     * Discriminate by {@link guard}. (Field name predates the comment boundary
     * and is kept stable for the SM6.1 media call sites.)
     */
    fileIds: Schema.Array(Schema.String),
  },
) {}

/**
 * Raised when a destructive body write gate blocks because the required allow
 * flag was not passed. Carries the named guard identifying which invariant was
 * violated and the flag that would unblock it, so the refusal is observable in
 * OTEL, dry-run plans, and JSON output (R13).
 *
 * This error is distinct from {@link NmdConflictError} (genuine 3-way edit
 * conflicts) and {@link NmdNonBodyWriteBlockedError} (files/media/comment write
 * boundaries): destructive body gates are a separate invariant family, opt-in
 * via explicit allow flags.
 */
export class NmdDestructiveBodyBlockedError extends Schema.TaggedError<NmdDestructiveBodyBlockedError>()(
  'NmdDestructiveBodyBlockedError',
  {
    page_id: Schema.String,
    /** The violated destructive body guard name. */
    guard: DestructiveBodyGuardName,
    message: Schema.String,
    /** The CLI flag that would unblock this gate. */
    allowFlag: Schema.String,
  },
) {}

/** Raised when a command needs a Notion token and none was supplied. */
export class NmdTokenMissingError extends Schema.TaggedError<NmdTokenMissingError>()(
  'NmdTokenMissingError',
  {
    message: Schema.String,
  },
) {}

/**
 * Raised when `<page>` is not a valid Notion id/URL, or the page does not exist
 * (editor surfaces `cat`/`put`/`edit`; exit 4).
 */
export class NmdUnresolvablePageError extends Schema.TaggedError<NmdUnresolvablePageError>()(
  'NmdUnresolvablePageError',
  {
    page: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/**
 * Raised when a default-mode editor buffer is missing its leading title H1, or a
 * `--frontmatter` envelope is malformed (editor surfaces; exit 5).
 */
export class NmdInvalidDocumentError extends Schema.TaggedError<NmdInvalidDocumentError>()(
  'NmdInvalidDocumentError',
  {
    page_id: Schema.optional(Schema.String),
    message: Schema.String,
  },
) {}

/** Raised when `$EDITOR` exits non-zero during `edit`; nothing is pushed (exit 8). */
export class NmdEditorAbortedError extends Schema.TaggedError<NmdEditorAbortedError>()(
  'NmdEditorAbortedError',
  {
    page_id: Schema.String,
    editor: Schema.String,
    exit_code: Schema.Number,
    message: Schema.String,
  },
) {}

/**
 * Raised when the post-push `semanticEquivalent` gate rejects a `put` result
 * (the remote may be mutated; re-`cat`; exit 9).
 */
export class NmdPostPushGateError extends Schema.TaggedError<NmdPostPushGateError>()(
  'NmdPostPushGateError',
  {
    page_id: Schema.String,
    message: Schema.String,
  },
) {}

/**
 * Raised when one of a `put`'s two writes (body, title) landed and the other
 * failed; the page is in a mixed state (decision 0012; exit 10).
 */
export class NmdPartialWriteError extends Schema.TaggedError<NmdPartialWriteError>()(
  'NmdPartialWriteError',
  {
    page_id: Schema.String,
    body_written: Schema.Boolean,
    title_written: Schema.Boolean,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
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
  | NmdSchemaDriftError
  | NmdPropertyWriteBlockedError
  | NmdNonBodyWriteBlockedError
  | NmdDestructiveBodyBlockedError
  | NmdCliError
