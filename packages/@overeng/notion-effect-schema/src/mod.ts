/**
 * Effect schemas for the Notion API.
 *
 * @see https://developers.notion.com/reference
 * @module
 */

import type { Schema } from 'effect'

import { Required, asName, asNames, asNullable } from './common.ts'
import {
  Checkbox,
  CreatedBy,
  CreatedTime,
  DateProp,
  Email,
  Files,
  Formula,
  LastEditedBy,
  LastEditedTime,
  MultiSelect,
  Num,
  People,
  PhoneNumber,
  Relation,
  RichTextProp,
  Rollup,
  Select,
  Status,
  Title,
  UniqueId,
  Url,
} from './properties/mod.ts'

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

// Property schemas (database property definitions)
export * from './property-schema.ts'

export type { DateValue } from './properties/date.ts'

/**
 * Select property values as Option<SelectOption>.
 *
 * Pass a typed option schema to enforce allowed names.
 */
function select(): typeof Select.asOption
function select<TName extends string>(
  nameSchema: Schema.Schema<TName>,
): ReturnType<typeof Select.asOptionNamed<TName>>
function select<TName extends string>(nameSchema?: Schema.Schema<TName>) {
  return nameSchema !== undefined ? Select.asOptionNamed(nameSchema) : Select.asOption
}

/**
 * Status property values as Option<SelectOption>.
 *
 * Pass a typed option schema to enforce allowed names.
 */
function status(): typeof Status.asOption
function status<TName extends string>(
  nameSchema: Schema.Schema<TName>,
): ReturnType<typeof Status.asOptionNamed<TName>>
function status<TName extends string>(nameSchema?: Schema.Schema<TName>) {
  return nameSchema !== undefined ? Status.asOptionNamed(nameSchema) : Status.asOption
}

/**
 * Multi-select property values as arrays of SelectOptions.
 *
 * Pass a typed option schema to enforce allowed names.
 */
function multiSelect(): typeof MultiSelect.raw
function multiSelect<TName extends string>(
  nameSchema: Schema.Schema<TName>,
): ReturnType<typeof MultiSelect.asOptionsNamed<TName>>
function multiSelect<TName extends string>(nameSchema?: Schema.Schema<TName>) {
  return nameSchema !== undefined ? MultiSelect.asOptionsNamed(nameSchema) : MultiSelect.raw
}

/** Collection of Effect schemas for Notion property types */
export const NotionSchema = {
  number: Num.asNumber,
  numberOption: Num.asOption,
  numberRaw: Num.raw,
  checkbox: Checkbox.asBoolean,
  checkboxRaw: Checkbox.raw,
  title: Title.asString,
  titleRaw: Title.raw,
  richTextString: RichTextProp.asString,
  richTextNonEmpty: RichTextProp.asNonEmptyString,
  richTextOption: RichTextProp.asOption,
  richTextRaw: RichTextProp.raw,
  dateOption: DateProp.asOption,
  dateDate: DateProp.asDate,
  dateRaw: DateProp.raw,
  select,
  status,
  multiSelect,
  asName,
  asNames,
  asNullable,
  relationIds: Relation.asIds,
  relationSingle: Relation.asSingle,
  relationSingleId: Relation.asSingleId,
  relationSingleOption: Relation.asSingleOption,
  relationSingleIdOption: Relation.asSingleIdOption,
  relationProperty: Relation.Property,
  peopleIds: People.asIds,
  peopleRaw: People.raw,
  filesUrls: Files.asUrls,
  filesRaw: Files.raw,
  urlString: Url.asString,
  urlOption: Url.asOption,
  urlRaw: Url.raw,
  emailString: Email.asString,
  emailOption: Email.asOption,
  emailRaw: Email.raw,
  phoneNumberString: PhoneNumber.asString,
  phoneNumberOption: PhoneNumber.asOption,
  phoneNumberRaw: PhoneNumber.raw,
  formulaRaw: Formula.raw,
  formulaNumber: Formula.asNumber,
  formulaString: Formula.asString,
  formulaBoolean: Formula.asBoolean,
  formulaDate: Formula.asDate,
  rollupRaw: Rollup.raw,
  rollupNumber: Rollup.asNumber,
  rollupString: Rollup.asString,
  rollupBoolean: Rollup.asBoolean,
  rollupDate: Rollup.asDate,
  rollupArray: Rollup.asArray,
  createdTimeRaw: CreatedTime.raw,
  createdTimeDate: CreatedTime.asDate,
  createdByRaw: CreatedBy.raw,
  createdById: CreatedBy.asId,
  lastEditedTimeRaw: LastEditedTime.raw,
  lastEditedTimeDate: LastEditedTime.asDate,
  lastEditedByRaw: LastEditedBy.raw,
  lastEditedById: LastEditedBy.asId,
  uniqueIdString: UniqueId.asString,
  uniqueIdNumber: UniqueId.asNumber,
  uniqueIdProperty: UniqueId.Property,
  titleWrite: Title.Write.Schema,
  titleWriteFromString: Title.Write.fromString,
  richTextWrite: RichTextProp.Write.Schema,
  richTextWriteFromString: RichTextProp.Write.fromString,
  numberWrite: Num.Write.Schema,
  numberWriteFromNumber: Num.Write.fromNumber,
  checkboxWrite: Checkbox.Write.Schema,
  checkboxWriteFromBoolean: Checkbox.Write.fromBoolean,
  selectWrite: Select.Write.Schema,
  selectWriteFromName: Select.Write.fromName,
  multiSelectWrite: MultiSelect.Write.Schema,
  multiSelectWriteFromNames: MultiSelect.Write.fromNames,
  statusWrite: Status.Write.Schema,
  statusWriteFromName: Status.Write.fromName,
  dateWrite: DateProp.Write.Schema,
  dateWriteFromStart: DateProp.Write.fromStart,
  peopleWrite: People.Write.Schema,
  peopleWriteFromIds: People.Write.fromIds,
  filesWrite: Files.Write.Schema,
  filesWriteFromUrls: Files.Write.fromUrls,
  urlWrite: Url.Write.Schema,
  urlWriteFromString: Url.Write.fromString,
  emailWrite: Email.Write.Schema,
  emailWriteFromString: Email.Write.fromString,
  phoneNumberWrite: PhoneNumber.Write.Schema,
  phoneNumberWriteFromString: PhoneNumber.Write.fromString,
  relationWrite: Relation.Write.Schema,
  relationWriteFromIds: Relation.Write.fromIds,
  required: Required.some(),
  requiredMessage: Required.some,
  nullable: Required.nullable,
} as const

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
