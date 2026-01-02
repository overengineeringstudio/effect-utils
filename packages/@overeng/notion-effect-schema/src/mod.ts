/**
 * Effect schemas for the Notion API.
 *
 * @see https://developers.notion.com/reference
 * @module
 */

// Common utilities and primitives
export {
  docsPath,
  type ISO8601DateTime,
  ISO8601DateTime as ISO8601DateTimeSchema,
  NOTION_DOCS_BASE,
  type NotionColor,
  NotionColor as NotionColorSchema,
  type NotionUUID,
  NotionUUID as NotionUUIDSchema,
  resolveDocsUrl,
  type SelectColor,
  SelectColor as SelectColorSchema,
} from './common.ts'

// Object schemas (DatabaseSchema, Page, Block)
// NOTE: ExternalFile, FileObject, NotionFile are intentionally not re-exported
// from objects.ts as they conflict with properties/reference.ts exports
export {
  type Block,
  Block as BlockSchema,
  type BlockParent,
  BlockParent as BlockParentSchema,
  type BlockType,
  BlockType as BlockTypeSchema,
  type CustomEmojiIcon,
  CustomEmojiIcon as CustomEmojiIconSchema,
  type DatabaseParent,
  DatabaseParent as DatabaseParentSchema,
  DatabaseSchema,
  type DataSource,
  DataSource as DataSourceSchema,
  type EmojiIcon,
  EmojiIcon as EmojiIconSchema,
  type Icon,
  Icon as IconSchema,
  type Page,
  Page as PageSchema,
  type PageParent,
  PageParent as PageParentSchema,
} from './objects.ts'

// Property schemas (page property values)
export * from './properties/mod.ts'

// Property schemas (database property definitions)
export * from './property-schema.ts'

// Rich text schemas
export {
  type DatabaseMention,
  DatabaseMention as DatabaseMentionSchema,
  type DateMention,
  DateMention as DateMentionSchema,
  type EquationRichText,
  EquationRichText as EquationRichTextSchema,
  type LinkPreviewMention,
  LinkPreviewMention as LinkPreviewMentionSchema,
  type MentionContent,
  MentionContent as MentionContentSchema,
  type MentionRichText,
  MentionRichText as MentionRichTextSchema,
  type PageMention,
  PageMention as PageMentionSchema,
  type RichText,
  RichText as RichTextSchema,
  type RichTextArray,
  RichTextArray as RichTextArraySchema,
  RichTextArrayAsString,
  type TemplateMention,
  TemplateMention as TemplateMentionSchema,
  type TemplateMentionDate,
  TemplateMentionDate as TemplateMentionDateSchema,
  type TemplateMentionUser,
  TemplateMentionUser as TemplateMentionUserSchema,
  type TextAnnotations,
  TextAnnotations as TextAnnotationsSchema,
  type TextLink,
  TextLink as TextLinkSchema,
  type TextRichText,
  TextRichText as TextRichTextSchema,
  type UserMention,
  UserMention as UserMentionSchema,
} from './rich-text.ts'

// Rich text utilities
export { RichTextUtils, toHtml, toMarkdown, toPlainText } from './rich-text-utils.ts'

// User schemas
export {
  type Bot,
  Bot as BotSchema,
  type BotData,
  BotData as BotDataSchema,
  type BotOwner,
  BotOwner as BotOwnerSchema,
  type PartialUser,
  PartialUser as PartialUserSchema,
  type Person,
  Person as PersonSchema,
  type PersonData,
  PersonData as PersonDataSchema,
  type User,
  User as UserSchema,
} from './users.ts'
