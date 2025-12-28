import { Schema } from 'effect'
import { docsPath, ISO8601DateTime, NotionUUID } from './common.ts'
import { RichTextArray } from './rich-text.ts'
import { PartialUser } from './users.ts'

// -----------------------------------------------------------------------------
// Parent Types
// -----------------------------------------------------------------------------

/** Parent reference for a database */
export const DatabaseParent = Schema.Union(
  Schema.Struct({
    type: Schema.Literal('page_id'),
    page_id: NotionUUID,
  }),
  Schema.Struct({
    type: Schema.Literal('block_id'),
    block_id: NotionUUID,
  }),
  Schema.Struct({
    type: Schema.Literal('workspace'),
    workspace: Schema.Literal(true),
  }),
).annotations({
  identifier: 'Notion.DatabaseParent',
  [docsPath]: 'database#database-parent',
})

export type DatabaseParent = typeof DatabaseParent.Type

/** Parent reference for a page */
export const PageParent = Schema.Union(
  Schema.Struct({
    type: Schema.Literal('database_id'),
    database_id: NotionUUID,
  }),
  Schema.Struct({
    type: Schema.Literal('page_id'),
    page_id: NotionUUID,
  }),
  Schema.Struct({
    type: Schema.Literal('block_id'),
    block_id: NotionUUID,
  }),
  Schema.Struct({
    type: Schema.Literal('workspace'),
    workspace: Schema.Literal(true),
  }),
).annotations({
  identifier: 'Notion.PageParent',
  [docsPath]: 'page#page-parent',
})

export type PageParent = typeof PageParent.Type

/** Parent reference for a block */
export const BlockParent = Schema.Union(
  Schema.Struct({
    type: Schema.Literal('database_id'),
    database_id: NotionUUID,
  }),
  Schema.Struct({
    type: Schema.Literal('page_id'),
    page_id: NotionUUID,
  }),
  Schema.Struct({
    type: Schema.Literal('block_id'),
    block_id: NotionUUID,
  }),
  Schema.Struct({
    type: Schema.Literal('workspace'),
    workspace: Schema.Literal(true),
  }),
).annotations({
  identifier: 'Notion.BlockParent',
  [docsPath]: 'block#block-parent',
})

export type BlockParent = typeof BlockParent.Type

// -----------------------------------------------------------------------------
// Icon & Cover Types
// -----------------------------------------------------------------------------

/** External file reference */
export const ExternalFile = Schema.Struct({
  type: Schema.Literal('external'),
  external: Schema.Struct({
    url: Schema.String,
  }),
}).annotations({
  identifier: 'Notion.ExternalFile',
  [docsPath]: 'file-object',
})

export type ExternalFile = typeof ExternalFile.Type

/** Notion-hosted file reference */
export const NotionFile = Schema.Struct({
  type: Schema.Literal('file'),
  file: Schema.Struct({
    url: Schema.String,
    expiry_time: ISO8601DateTime,
  }),
}).annotations({
  identifier: 'Notion.NotionFile',
  [docsPath]: 'file-object',
})

export type NotionFile = typeof NotionFile.Type

/** File object (external or Notion-hosted) */
export const FileObject = Schema.Union(ExternalFile, NotionFile).annotations({
  identifier: 'Notion.FileObject',
  [docsPath]: 'file-object',
})

export type FileObject = typeof FileObject.Type

/** Emoji icon */
export const EmojiIcon = Schema.Struct({
  type: Schema.Literal('emoji'),
  emoji: Schema.String,
}).annotations({
  identifier: 'Notion.EmojiIcon',
  [docsPath]: 'emoji-object',
})

export type EmojiIcon = typeof EmojiIcon.Type

/** Custom emoji icon */
export const CustomEmojiIcon = Schema.Struct({
  type: Schema.Literal('custom_emoji'),
  custom_emoji: Schema.Struct({
    id: NotionUUID,
    name: Schema.optional(Schema.String),
    url: Schema.optional(Schema.String),
  }),
}).annotations({
  identifier: 'Notion.CustomEmojiIcon',
})

export type CustomEmojiIcon = typeof CustomEmojiIcon.Type

/** Icon (emoji, custom emoji, external file, or Notion file) */
export const Icon = Schema.Union(EmojiIcon, CustomEmojiIcon, ExternalFile, NotionFile).annotations({
  identifier: 'Notion.Icon',
})

export type Icon = typeof Icon.Type

// -----------------------------------------------------------------------------
// Database Object
// -----------------------------------------------------------------------------

/** Data source within a database */
export const DataSource = Schema.Struct({
  id: NotionUUID,
  name: Schema.optional(Schema.String),
}).annotations({
  identifier: 'Notion.DataSource',
  [docsPath]: 'data-source',
})

export type DataSource = typeof DataSource.Type

/**
 * Notion Database object.
 *
 * @see https://developers.notion.com/reference/database
 */
export const Database = Schema.Struct({
  object: Schema.Literal('database'),
  id: NotionUUID,
  created_time: ISO8601DateTime,
  created_by: PartialUser,
  last_edited_time: ISO8601DateTime,
  last_edited_by: PartialUser,
  title: RichTextArray,
  description: RichTextArray,
  icon: Schema.NullOr(Icon),
  cover: Schema.NullOr(FileObject),
  parent: DatabaseParent,
  url: Schema.String,
  archived: Schema.Boolean,
  in_trash: Schema.Boolean,
  is_inline: Schema.Boolean,
  public_url: Schema.NullOr(Schema.String),
  /** Data sources (collections) within the database */
  data_sources: Schema.optional(Schema.Array(DataSource)),
  /** Property schema definitions - moved to data source level but may still appear */
  properties: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
}).annotations({
  identifier: 'Notion.Database',
  [docsPath]: 'database',
})

export type Database = typeof Database.Type

// -----------------------------------------------------------------------------
// Page Object
// -----------------------------------------------------------------------------

/**
 * Notion Page object.
 *
 * @see https://developers.notion.com/reference/page
 */
export const Page = Schema.Struct({
  object: Schema.Literal('page'),
  id: NotionUUID,
  created_time: ISO8601DateTime,
  created_by: PartialUser,
  last_edited_time: ISO8601DateTime,
  last_edited_by: PartialUser,
  icon: Schema.NullOr(Icon),
  cover: Schema.NullOr(FileObject),
  parent: PageParent,
  archived: Schema.Boolean,
  in_trash: Schema.Boolean,
  url: Schema.String,
  public_url: Schema.NullOr(Schema.String),
  /** Page properties - structure depends on parent type */
  properties: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
}).annotations({
  identifier: 'Notion.Page',
  [docsPath]: 'page',
})

export type Page = typeof Page.Type

// -----------------------------------------------------------------------------
// Block Types
// -----------------------------------------------------------------------------

/** All supported block types */
export const BlockType = Schema.Literal(
  // Text & Content
  'paragraph',
  'heading_1',
  'heading_2',
  'heading_3',
  'quote',
  'callout',
  'code',
  // Lists
  'bulleted_list_item',
  'numbered_list_item',
  'to_do',
  'toggle',
  // Media
  'image',
  'video',
  'audio',
  'file',
  'pdf',
  'embed',
  'bookmark',
  // Organization
  'table',
  'table_row',
  'column_list',
  'column',
  'divider',
  'table_of_contents',
  'breadcrumb',
  // Advanced
  'synced_block',
  'child_page',
  'child_database',
  'equation',
  'template',
  'link_preview',
  'link_to_page',
  // System
  'unsupported',
).annotations({
  identifier: 'Notion.BlockType',
  [docsPath]: 'block#block-types',
})

export type BlockType = typeof BlockType.Type

/**
 * Notion Block object.
 *
 * Contains common properties shared by all block types.
 * Block-type-specific content is available via the property matching the `type` field.
 *
 * @see https://developers.notion.com/reference/block
 */
export const Block = Schema.Struct({
  object: Schema.Literal('block'),
  id: NotionUUID,
  parent: BlockParent,
  type: BlockType,
  created_time: ISO8601DateTime,
  created_by: PartialUser,
  last_edited_time: ISO8601DateTime,
  last_edited_by: PartialUser,
  has_children: Schema.Boolean,
  archived: Schema.Boolean,
  in_trash: Schema.Boolean,
}).annotations({
  identifier: 'Notion.Block',
  [docsPath]: 'block',
})

export type Block = typeof Block.Type
