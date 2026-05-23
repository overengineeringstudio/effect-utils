import { Schema } from 'effect'

import {
  IconSchema as NotionIcon,
  ISO8601DateTimeSchema as ISO8601DateTime,
  NotionUUIDSchema as NotionUUID,
} from '@overeng/notion-effect-schema'

/** SHA-256 digest string used for canonical body and file content identity. */
export const Sha256Digest = Schema.String.pipe(
  Schema.pattern(/^sha256:[a-f0-9]{64}$/i),
).annotations({
  identifier: 'NotionMd.Sha256Digest',
})

export type Sha256Digest = typeof Sha256Digest.Type

/** Relative path inside the local workspace. */
export const RelativePath = Schema.String.pipe(
  Schema.filter(
    (value) => {
      if (value.length === 0 || value.startsWith('/') === true) return false
      const segments = value.split(/[\\/]+/u)
      return segments.every((segment) => segment !== '..')
    },
    {
      message: () => 'Expected a non-empty relative path without parent traversal',
    },
  ),
).annotations({
  identifier: 'NotionMd.RelativePath',
})

export type RelativePath = typeof RelativePath.Type

/** Role of a content-addressed local object referenced by `.nmd` frontmatter. */
export const NmdObjectRole = Schema.Literal(
  'base_snapshot',
  'storage_payload',
  'file_payload',
  'comment_payload',
).annotations({
  identifier: 'NotionMd.ObjectRole',
})

export type NmdObjectRole = typeof NmdObjectRole.Type

/** Strict reference to a local content-addressed object. */
export const NmdObjectRef = Schema.TaggedStruct('object_ref', {
  role: NmdObjectRole,
  hash: Sha256Digest,
  path: RelativePath,
  media_type: Schema.String,
  byte_length: Schema.NonNegativeInt,
}).annotations({
  identifier: 'NotionMd.ObjectRef',
})

export type NmdObjectRef = typeof NmdObjectRef.Type

/** Parent location of a synced Notion page. */
export const NmdParentRef = Schema.Union(
  Schema.TaggedStruct('page', {
    id: NotionUUID,
  }),
  Schema.TaggedStruct('data_source', {
    id: NotionUUID,
    database_id: Schema.optional(NotionUUID),
  }),
  Schema.TaggedStruct('database', {
    id: NotionUUID,
  }),
  Schema.TaggedStruct('block', {
    id: NotionUUID,
  }),
  Schema.TaggedStruct('workspace', {}),
  Schema.TaggedStruct('unknown', {
    raw: Schema.Unknown,
  }),
).annotations({
  identifier: 'NotionMd.ParentRef',
})

export type NmdParentRef = typeof NmdParentRef.Type

/** Canonicalized Notion enhanced Markdown body state. */
export const NmdBodyState = Schema.Struct({
  format: Schema.Literal('notion-enhanced-markdown'),
  hash: Sha256Digest,
  base: NmdObjectRef,
  last_pulled_at: ISO8601DateTime,
  remote_last_edited_time: ISO8601DateTime,
  truncated: Schema.Boolean,
  unknown_block_ids: Schema.Array(NotionUUID),
}).annotations({
  identifier: 'NotionMd.BodyState',
})

export type NmdBodyState = typeof NmdBodyState.Type

/** Page icon state preserved outside the Markdown body. */
export const NmdPageIcon = Schema.NullOr(NotionIcon).annotations({
  identifier: 'NotionMd.PageIcon',
})

export type NmdPageIcon = typeof NmdPageIcon.Type

/** Page cover backed by an external URL. */
export const NmdExternalFile = Schema.Struct({
  type: Schema.Literal('external'),
  external: Schema.Struct({
    url: Schema.String,
  }),
}).annotations({
  identifier: 'NotionMd.ExternalFile',
})

export type NmdExternalFile = typeof NmdExternalFile.Type

/** Page cover backed by an expiring Notion-hosted URL. */
export const NmdNotionFile = Schema.Struct({
  type: Schema.Literal('file'),
  file: Schema.Struct({
    url: Schema.String,
    expiry_time: ISO8601DateTime,
  }),
}).annotations({
  identifier: 'NotionMd.NotionFile',
})

export type NmdNotionFile = typeof NmdNotionFile.Type

/** Page cover state preserved outside the Markdown body. */
export const NmdPageCover = Schema.NullOr(Schema.Union(NmdExternalFile, NmdNotionFile)).annotations(
  {
    identifier: 'NotionMd.PageCover',
  },
)

export type NmdPageCover = typeof NmdPageCover.Type

/** Page-level state that lives outside the Markdown body. */
export const NmdPageState = Schema.Struct({
  title: Schema.String,
  icon: NmdPageIcon,
  cover: NmdPageCover,
  in_trash: Schema.Boolean,
  is_locked: Schema.Boolean,
}).annotations({
  identifier: 'NotionMd.PageState',
})

export type NmdPageState = typeof NmdPageState.Type

/** Date value used by typed page-property frontmatter. */
export const NmdDateValue = Schema.Struct({
  start: Schema.String,
  end: Schema.NullOr(Schema.String),
  time_zone: Schema.NullOr(Schema.String),
}).annotations({
  identifier: 'NotionMd.DateValue',
})

export type NmdDateValue = typeof NmdDateValue.Type

/** File reference used by typed file properties. */
export const NmdPropertyFileRef = Schema.Union(
  Schema.TaggedStruct('local_file', {
    path: RelativePath,
    content_hash: Schema.optional(Sha256Digest),
  }),
  Schema.TaggedStruct('notion_file', {
    block_id: Schema.optional(NotionUUID),
    file_upload_id: Schema.optional(NotionUUID),
    filename: Schema.String,
    content_type: Schema.optional(Schema.String),
    content_length: Schema.optional(Schema.Number),
  }),
  Schema.TaggedStruct('external_url', {
    url: Schema.String,
  }),
).annotations({
  identifier: 'NotionMd.PropertyFileRef',
})

export type NmdPropertyFileRef = typeof NmdPropertyFileRef.Type

/** Place value used by typed page-property frontmatter. */
export const NmdPlaceValue = Schema.Struct({
  lat: Schema.Number,
  lon: Schema.Number,
  name: Schema.optional(Schema.NullOr(Schema.String)),
  address: Schema.optional(Schema.NullOr(Schema.String)),
  google_place_id: Schema.optional(Schema.NullOr(Schema.String)),
  aws_place_id: Schema.optional(Schema.NullOr(Schema.String)),
}).annotations({
  identifier: 'NotionMd.PlaceValue',
})

export type NmdPlaceValue = typeof NmdPlaceValue.Type

/** Verification value used by typed page-property frontmatter. */
export const NmdVerificationValue = Schema.Union(
  Schema.Struct({
    state: Schema.Literal('verified'),
    date: Schema.optional(NmdDateValue),
  }),
  Schema.Struct({
    state: Schema.Literal('unverified'),
  }),
).annotations({
  identifier: 'NotionMd.VerificationValue',
})

export type NmdVerificationValue = typeof NmdVerificationValue.Type

/** Typed, human-editable page-property value stored in frontmatter. */
export const NmdPropertyValue = Schema.Union(
  Schema.TaggedStruct('title', { value: Schema.String }),
  Schema.TaggedStruct('rich_text', { value: Schema.NullOr(Schema.String) }),
  Schema.TaggedStruct('number', { value: Schema.NullOr(Schema.Number) }),
  Schema.TaggedStruct('select', { value: Schema.NullOr(Schema.String) }),
  Schema.TaggedStruct('multi_select', { value: Schema.Array(Schema.String) }),
  Schema.TaggedStruct('status', { value: Schema.NullOr(Schema.String) }),
  Schema.TaggedStruct('date', { value: Schema.NullOr(NmdDateValue) }),
  Schema.TaggedStruct('people', { value: Schema.Array(NotionUUID) }),
  Schema.TaggedStruct('files', { value: Schema.Array(NmdPropertyFileRef) }),
  Schema.TaggedStruct('checkbox', { value: Schema.Boolean }),
  Schema.TaggedStruct('url', { value: Schema.NullOr(Schema.String) }),
  Schema.TaggedStruct('email', { value: Schema.NullOr(Schema.String) }),
  Schema.TaggedStruct('phone_number', { value: Schema.NullOr(Schema.String) }),
  Schema.TaggedStruct('relation', { value: Schema.Array(NotionUUID) }),
  Schema.TaggedStruct('place', { value: Schema.NullOr(NmdPlaceValue) }),
  Schema.TaggedStruct('verification', { value: NmdVerificationValue }),
  Schema.TaggedStruct('read_only', {
    property_type: Schema.String,
    value: Schema.Unknown,
  }),
).annotations({
  identifier: 'NotionMd.PropertyValue',
})

export type NmdPropertyValue = typeof NmdPropertyValue.Type

/** Data-source binding used when a page is also a database/data-source row. */
export const NmdDataSourceBinding = Schema.Struct({
  database_id: NotionUUID,
  data_source_id: NotionUUID,
  schema_hash: Sha256Digest,
  title_property: Schema.String,
  property_ids: Schema.Record({ key: Schema.String, value: Schema.String }),
  read_only_properties: Schema.Array(Schema.String),
}).annotations({
  identifier: 'NotionMd.DataSourceBinding',
})

export type NmdDataSourceBinding = typeof NmdDataSourceBinding.Type

/** Compact block snapshot for unsupported Notion blocks kept in self-contained frontmatter. */
export const NmdUnsupportedBlockUnit = Schema.TaggedStruct('unsupported_block', {
  block_id: NotionUUID,
  block_type: Schema.String,
  placeholder: Schema.String,
  snapshot: Schema.Struct({
    object: Schema.Literal('block'),
    id: NotionUUID,
    type: Schema.String,
    has_children: Schema.Boolean,
    in_trash: Schema.Boolean,
    parent: Schema.Unknown,
    created_time: ISO8601DateTime,
    last_edited_time: ISO8601DateTime,
    payload: Schema.Unknown,
  }),
}).annotations({
  identifier: 'NotionMd.UnsupportedBlockUnit',
})

export type NmdUnsupportedBlockUnit = typeof NmdUnsupportedBlockUnit.Type

/** File/upload lifecycle unit small enough to keep in frontmatter. */
export const NmdFileUnit = Schema.TaggedStruct('file_unit', {
  id: Schema.String,
  role: Schema.Literal('property_file', 'block_file', 'block_image', 'upload'),
  filename: Schema.String,
  content_type: Schema.optional(Schema.String),
  content_length: Schema.optional(Schema.Number),
  local_path: Schema.optional(RelativePath),
  content_hash: Schema.optional(Sha256Digest),
  block_id: Schema.optional(NotionUUID),
  file_upload_id: Schema.optional(NotionUUID),
  status: Schema.optional(Schema.String),
}).annotations({
  identifier: 'NotionMd.FileUnit',
})

export type NmdFileUnit = typeof NmdFileUnit.Type

/** Optional local review bridge metadata for Roughdraft/Notion comments. */
export const NmdCommentUnit = Schema.TaggedStruct('comment_unit', {
  id: Schema.String,
  roughdraft_id: Schema.optional(Schema.String),
  notion_comment_id: Schema.optional(NotionUUID),
  notion_discussion_id: Schema.optional(NotionUUID),
  anchor_text: Schema.optional(Schema.String),
}).annotations({
  identifier: 'NotionMd.CommentUnit',
})

export type NmdCommentUnit = typeof NmdCommentUnit.Type

/** Storage strategy declared by a local `.nmd` file. */
export const NmdStorage = Schema.Union(
  Schema.TaggedStruct('self_contained', {
    unsupported_blocks: Schema.Array(NmdUnsupportedBlockUnit),
    files: Schema.Array(NmdFileUnit),
    comments: Schema.Array(NmdCommentUnit),
  }),
  Schema.TaggedStruct('object_store', {
    object: NmdObjectRef,
    unsupported_block_ids: Schema.Array(NotionUUID),
    file_ids: Schema.Array(Schema.String),
    comment_ids: Schema.Array(Schema.String),
  }),
).annotations({
  identifier: 'NotionMd.Storage',
})

export type NmdStorage = typeof NmdStorage.Type

/** Versioned local `.nmd` frontmatter envelope. */
export const NmdFrontmatterV1 = Schema.Struct({
  notion_md: Schema.Struct({
    version: Schema.Literal(1),
    api_version: Schema.Literal('2026-03-11'),
    object: Schema.Literal('page'),
    page_id: NotionUUID,
    url: Schema.optional(Schema.String),
    parent: NmdParentRef,
    body: NmdBodyState,
    page: NmdPageState,
    data_source: Schema.NullOr(NmdDataSourceBinding),
    properties: Schema.Record({ key: Schema.String, value: NmdPropertyValue }),
    storage: NmdStorage,
  }),
}).annotations({
  identifier: 'NotionMd.FrontmatterV1',
})

export type NmdFrontmatterV1 = typeof NmdFrontmatterV1.Type

/*
 * Writable subset of `NmdPropertyValue`, used by the V2 split: read-only
 * echoes move to the sidecar sync state, so the frontmatter only carries
 * the property tags a user can actually edit.
 */
export const NmdWritablePropertyValue = Schema.Union(
  Schema.TaggedStruct('title', { value: Schema.String }),
  Schema.TaggedStruct('rich_text', { value: Schema.NullOr(Schema.String) }),
  Schema.TaggedStruct('number', { value: Schema.NullOr(Schema.Number) }),
  Schema.TaggedStruct('select', { value: Schema.NullOr(Schema.String) }),
  Schema.TaggedStruct('multi_select', { value: Schema.Array(Schema.String) }),
  Schema.TaggedStruct('status', { value: Schema.NullOr(Schema.String) }),
  Schema.TaggedStruct('date', { value: Schema.NullOr(NmdDateValue) }),
  Schema.TaggedStruct('people', { value: Schema.Array(NotionUUID) }),
  Schema.TaggedStruct('files', { value: Schema.Array(NmdPropertyFileRef) }),
  Schema.TaggedStruct('checkbox', { value: Schema.Boolean }),
  Schema.TaggedStruct('url', { value: Schema.NullOr(Schema.String) }),
  Schema.TaggedStruct('email', { value: Schema.NullOr(Schema.String) }),
  Schema.TaggedStruct('phone_number', { value: Schema.NullOr(Schema.String) }),
  Schema.TaggedStruct('relation', { value: Schema.Array(NotionUUID) }),
  Schema.TaggedStruct('place', { value: Schema.NullOr(NmdPlaceValue) }),
  Schema.TaggedStruct('verification', { value: NmdVerificationValue }),
).annotations({ identifier: 'NotionMd.WritablePropertyValue' })

export type NmdWritablePropertyValue = typeof NmdWritablePropertyValue.Type

/*
 * V2 frontmatter — user-facing state only.
 *
 * Two-tier split from V1: derived sync bookkeeping (body hash, base
 * snapshot ref, last-pulled timestamps, unknown-block ids, storage
 * inventory, read-only property echoes, data-source binding) moves to
 * the sidecar `NmdSyncStateV1` at `.notion-md/sync/{page_id}.json`.
 *
 * `page_id` is nullable so a `.nmd` file can describe an unmaterialized
 * page (with `parent` set); `push` then creates the Notion page and
 * fills `page_id` on first sync. This is the "convention-driven create"
 * design — same artifact through the whole lifecycle, same `push` verb.
 */
export const NmdFrontmatterV2 = Schema.Struct({
  notion_md: Schema.Struct({
    version: Schema.Literal(2),
    api_version: Schema.Literal('2026-03-11'),
    object: Schema.Literal('page'),
    page_id: Schema.NullOr(NotionUUID),
    url: Schema.optional(Schema.String),
    parent: NmdParentRef,
    page: NmdPageState,
    properties: Schema.Record({ key: Schema.String, value: NmdWritablePropertyValue }),
  }),
}).annotations({ identifier: 'NotionMd.FrontmatterV2' })

export type NmdFrontmatterV2 = typeof NmdFrontmatterV2.Type

/*
 * Sidecar sync state — machine-managed bookkeeping that lives at
 * `.notion-md/sync/{page_id}.json`. Mirrors the `.git/` model: working
 * tree is human-facing, sidecar is machine state. Files survive `git mv`
 * since they're keyed by immutable `page_id`, not filename.
 */
export const NmdSyncStateV1 = Schema.Struct({
  version: Schema.Literal(1),
  page_id: NotionUUID,
  body: NmdBodyState,
  storage: NmdStorage,
  read_only_properties: Schema.Record({
    key: Schema.String,
    value: Schema.Struct({
      property_type: Schema.String,
      value: Schema.Unknown,
    }),
  }),
  data_source: Schema.NullOr(NmdDataSourceBinding),
}).annotations({ identifier: 'NotionMd.SyncStateV1' })

export type NmdSyncStateV1 = typeof NmdSyncStateV1.Type

/** Strict parse options for local sync metadata; extra keys are schema violations. */
export const nmdStrictParseOptions = {
  errors: 'all',
  onExcessProperty: 'error',
} as const

/** Decode `.nmd` frontmatter with strict excess-property checks. */
export const decodeNmdFrontmatterV1 = Schema.decodeUnknown(NmdFrontmatterV1, nmdStrictParseOptions)

/** Synchronous strict decoder for tests and CLI preflight paths. */
export const decodeNmdFrontmatterV1Sync = Schema.decodeUnknownSync(
  NmdFrontmatterV1,
  nmdStrictParseOptions,
)

/** Decode V2 frontmatter with strict excess-property checks. */
export const decodeNmdFrontmatterV2 = Schema.decodeUnknown(NmdFrontmatterV2, nmdStrictParseOptions)

/** Synchronous strict decoder for V2 frontmatter. */
export const decodeNmdFrontmatterV2Sync = Schema.decodeUnknownSync(
  NmdFrontmatterV2,
  nmdStrictParseOptions,
)

/** Decode sidecar sync state with strict excess-property checks. */
export const decodeNmdSyncStateV1 = Schema.decodeUnknown(NmdSyncStateV1, nmdStrictParseOptions)

/** Size class for deciding whether `.nmd` metadata can stay in frontmatter. */
export type NmdFrontmatterPayloadClass = 'small' | 'large' | 'too_large'

/** Byte thresholds for `.nmd` frontmatter storage classification. */
export interface ClassifyNmdFrontmatterPayloadOptions {
  readonly smallBytes?: number
  readonly largeBytes?: number
}

/** Classify whether frontmatter metadata should remain self-contained or move to object storage. */
// oxlint-disable-next-line overeng/named-args -- public helper already accepts value plus optional thresholds.
export const classifyNmdFrontmatterPayload = (
  value: NmdFrontmatterV1,
  options?: ClassifyNmdFrontmatterPayloadOptions,
): {
  readonly bytes: number
  readonly classification: NmdFrontmatterPayloadClass
} => {
  const smallBytes = options?.smallBytes ?? 8_192
  const largeBytes = options?.largeBytes ?? 65_536
  const bytes = new TextEncoder().encode(JSON.stringify(value.notion_md.storage)).byteLength

  if (bytes <= smallBytes) {
    return { bytes, classification: 'small' }
  }

  if (bytes <= largeBytes) {
    return { bytes, classification: 'large' }
  }

  return { bytes, classification: 'too_large' }
}
