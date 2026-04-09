import { Schema } from 'effect'

import { docsPath, ISO8601DateTime, NoticonColor, NotionUUID } from './common.ts'
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
    type: Schema.Literal('data_source_id'),
    data_source_id: NotionUUID,
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

/** Native Notion icon (noticon) with name and color */
export const NamedIcon = Schema.Struct({
  type: Schema.Literal('icon'),
  icon: Schema.Struct({
    name: Schema.String,
    color: NoticonColor,
  }),
}).annotations({
  identifier: 'Notion.NamedIcon',
  [docsPath]: 'icon-object',
})

export type NamedIcon = typeof NamedIcon.Type

/** Icon (emoji, custom emoji, named icon, external file, or Notion file) */
export const Icon = Schema.Union(
  EmojiIcon,
  CustomEmojiIcon,
  NamedIcon,
  ExternalFile,
  NotionFile,
).annotations({
  identifier: 'Notion.Icon',
})

export type Icon = typeof Icon.Type

// -----------------------------------------------------------------------------
// Database Object
// -----------------------------------------------------------------------------

/** Lightweight data source reference (used in DatabaseSchema.data_sources array) */
export const DataSourceRef = Schema.Struct({
  id: NotionUUID,
  name: Schema.optional(Schema.String),
}).annotations({
  identifier: 'Notion.DataSourceRef',
  [docsPath]: 'data-source',
})

export type DataSourceRef = typeof DataSourceRef.Type

/** Data source parent (which database owns this data source) */
export const DataSourceParent = Schema.Struct({
  type: Schema.Literal('database_id'),
  database_id: NotionUUID,
}).annotations({
  identifier: 'Notion.DataSourceParent',
})

export type DataSourceParent = typeof DataSourceParent.Type

/**
 * Full Notion Data Source object.
 * In API 2026-03-11, properties/schema definitions live here instead of on the database.
 *
 * @see https://developers.notion.com/reference/data-source
 */
export const DataSourceSchema = Schema.Struct({
  object: Schema.Literal('data_source'),
  id: NotionUUID,
  title: RichTextArray,
  description: RichTextArray,
  icon: Schema.NullOr(Icon),
  cover: Schema.NullOr(FileObject),
  parent: DataSourceParent,
  /** The top-level parent of the owning database (page, block, or workspace) */
  database_parent: DatabaseParent,
  /** Property schema definitions */
  properties: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  is_inline: Schema.Boolean,
  in_trash: Schema.Boolean,
  url: Schema.String,
  public_url: Schema.NullOr(Schema.String),
  created_time: ISO8601DateTime,
  created_by: PartialUser,
  last_edited_time: ISO8601DateTime,
  last_edited_by: PartialUser,
}).annotations({
  identifier: 'Notion.DataSourceSchema',
  [docsPath]: 'data-source',
})

export type DataSourceSchema = typeof DataSourceSchema.Type

/**
 * Notion Database schema/metadata object.
 * Represents the structure and configuration of a database, not its contents.
 *
 * @see https://developers.notion.com/reference/database
 */
export const DatabaseSchema = Schema.Struct({
  object: Schema.Literal('database'),
  id: NotionUUID,
  created_time: ISO8601DateTime,
  created_by: Schema.optional(PartialUser),
  last_edited_time: ISO8601DateTime,
  last_edited_by: Schema.optional(PartialUser),
  title: RichTextArray,
  description: RichTextArray,
  icon: Schema.NullOr(Icon),
  cover: Schema.NullOr(FileObject),
  parent: DatabaseParent,
  url: Schema.String,
  in_trash: Schema.Boolean,
  is_inline: Schema.Boolean,
  is_locked: Schema.optional(Schema.Boolean),
  public_url: Schema.NullOr(Schema.String),
  /** Data sources (collections) within the database */
  data_sources: Schema.optional(Schema.Array(DataSourceRef)),
  /** Property schema definitions - moved to data source level but may still appear */
  properties: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
}).annotations({
  identifier: 'Notion.DatabaseSchema',
  [docsPath]: 'database',
})

export type DatabaseSchema = typeof DatabaseSchema.Type

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
  in_trash: Schema.Boolean,
  is_locked: Schema.optional(Schema.Boolean),
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
  'heading_4',
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
  'tab',
  // Advanced
  'synced_block',
  'child_page',
  'child_database',
  'equation',
  'template',
  'link_preview',
  'link_to_page',
  'meeting_notes',
  // System
  'unsupported',
).annotations({
  identifier: 'Notion.BlockType',
  [docsPath]: 'block#block-types',
})

export type BlockType = typeof BlockType.Type

/** Base block fields shared by all block types */
const BlockBase = Schema.Struct({
  object: Schema.Literal('block'),
  id: NotionUUID,
  parent: BlockParent,
  type: BlockType,
  created_time: ISO8601DateTime,
  created_by: PartialUser,
  last_edited_time: ISO8601DateTime,
  last_edited_by: PartialUser,
  has_children: Schema.Boolean,
  in_trash: Schema.Boolean,
})

/**
 * Notion Block object.
 *
 * Contains common properties shared by all block types.
 * Block-type-specific content is available via the property matching the `type` field
 * (e.g., `block.paragraph`, `block.heading_1`, etc.).
 *
 * The schema preserves additional properties to retain block-type-specific data.
 *
 * @see https://developers.notion.com/reference/block
 */
export const Block = Schema.extend(
  BlockBase,
  Schema.Record({ key: Schema.String, value: Schema.Unknown }),
).annotations({
  identifier: 'Notion.Block',
  [docsPath]: 'block',
})

export type Block = typeof Block.Type

// -----------------------------------------------------------------------------
// Page Markdown
// -----------------------------------------------------------------------------

/**
 * Server-side markdown representation of a page.
 *
 * @see https://developers.notion.com/reference/get-page-markdown
 */
export const PageMarkdown = Schema.Struct({
  object: Schema.Literal('page_markdown'),
  markdown: Schema.String,
  truncated: Schema.Boolean,
  unknown_block_ids: Schema.Array(Schema.String),
}).annotations({
  identifier: 'Notion.PageMarkdown',
})

export type PageMarkdown = typeof PageMarkdown.Type

// -----------------------------------------------------------------------------
// Comment
// -----------------------------------------------------------------------------

/** Parent reference for a comment */
export const CommentParent = Schema.Union(
  Schema.Struct({
    type: Schema.Literal('page_id'),
    page_id: NotionUUID,
  }),
  Schema.Struct({
    type: Schema.Literal('block_id'),
    block_id: NotionUUID,
  }),
).annotations({
  identifier: 'Notion.CommentParent',
})

export type CommentParent = typeof CommentParent.Type

/**
 * Notion Comment object.
 *
 * @see https://developers.notion.com/reference/comment-object
 */
export const Comment = Schema.Struct({
  object: Schema.Literal('comment'),
  id: NotionUUID,
  parent: CommentParent,
  discussion_id: NotionUUID,
  rich_text: RichTextArray,
  created_time: ISO8601DateTime,
  created_by: PartialUser,
  last_edited_time: ISO8601DateTime,
}).annotations({
  identifier: 'Notion.Comment',
  [docsPath]: 'comment-object',
})

export type Comment = typeof Comment.Type

// -----------------------------------------------------------------------------
// View
// -----------------------------------------------------------------------------

/** Database view types */
export const ViewType = Schema.Literal(
  'table',
  'board',
  'list',
  'calendar',
  'timeline',
  'gallery',
  'form',
  'chart',
).annotations({
  identifier: 'Notion.ViewType',
})

export type ViewType = typeof ViewType.Type

/**
 * Notion database View object.
 *
 * Configuration details (filter, sorts, type-specific settings) are preserved
 * as unknown values since they vary by view type.
 *
 * @see https://developers.notion.com/reference/view-object
 */
export const View = Schema.Struct({
  object: Schema.Literal('view'),
  id: NotionUUID,
  parent: Schema.Struct({
    type: Schema.Literal('database_id'),
    database_id: NotionUUID,
  }),
  data_source_id: NotionUUID,
  name: Schema.String,
  type: ViewType,
  created_time: Schema.NullOr(ISO8601DateTime),
  created_by: Schema.NullOr(PartialUser),
  last_edited_time: Schema.NullOr(ISO8601DateTime),
  last_edited_by: Schema.NullOr(PartialUser),
  url: Schema.String,
  filter: Schema.NullOr(Schema.Unknown),
  sorts: Schema.NullOr(Schema.Unknown),
  quick_filters: Schema.NullOr(Schema.Unknown),
  configuration: Schema.Unknown,
}).annotations({
  identifier: 'Notion.View',
  [docsPath]: 'view-object',
})

export type View = typeof View.Type
