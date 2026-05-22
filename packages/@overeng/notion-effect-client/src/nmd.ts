import { Schema } from 'effect'

import {
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
  Schema.filter((value) => value.length > 0 && value.startsWith('/') === false, {
    message: () => 'Expected a non-empty relative path',
  }),
).annotations({
  identifier: 'NotionMd.RelativePath',
})

export type RelativePath = typeof RelativePath.Type

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
  last_pulled_at: ISO8601DateTime,
  remote_last_edited_time: ISO8601DateTime,
  truncated: Schema.Boolean,
  unknown_block_ids: Schema.Array(NotionUUID),
}).annotations({
  identifier: 'NotionMd.BodyState',
})

export type NmdBodyState = typeof NmdBodyState.Type

/** Page-level state that lives outside the Markdown body. */
export const NmdPageState = Schema.Struct({
  title: Schema.String,
  icon: Schema.Unknown,
  cover: Schema.Unknown,
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
  Schema.TaggedStruct('sidecar', {
    path: RelativePath,
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

export type NmdFrontmatterPayloadClass = 'small' | 'large' | 'too_large'

export interface ClassifyNmdFrontmatterPayloadOptions {
  readonly smallBytes?: number
  readonly largeBytes?: number
}

/** Classify whether frontmatter metadata should remain self-contained or move to sidecar. */
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
