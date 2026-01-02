import { Schema } from 'effect'
import { docsPath, NotionUUID, SelectColor } from './common.ts'

// -----------------------------------------------------------------------------
// Shared Configuration Types
// -----------------------------------------------------------------------------

/** Select/multi-select option in database schema */
export const SelectOptionConfig = Schema.Struct({
  id: NotionUUID,
  name: Schema.String,
  color: SelectColor,
  description: Schema.optional(Schema.NullOr(Schema.String)),
}).annotations({
  identifier: 'Notion.SelectOptionConfig',
})

export type SelectOptionConfig = typeof SelectOptionConfig.Type

/** Status group in database schema */
export const StatusGroupConfig = Schema.Struct({
  id: NotionUUID,
  name: Schema.String,
  color: SelectColor,
  option_ids: Schema.Array(NotionUUID),
}).annotations({
  identifier: 'Notion.StatusGroupConfig',
})

export type StatusGroupConfig = typeof StatusGroupConfig.Type

/** Number format options */
export const NumberFormat = Schema.Literal(
  'number',
  'number_with_commas',
  'percent',
  'dollar',
  'canadian_dollar',
  'euro',
  'pound',
  'yen',
  'ruble',
  'rupee',
  'won',
  'yuan',
  'real',
  'lira',
  'rupiah',
  'franc',
  'hong_kong_dollar',
  'new_zealand_dollar',
  'krona',
  'norwegian_krone',
  'mexican_peso',
  'rand',
  'new_taiwan_dollar',
  'danish_krone',
  'zloty',
  'baht',
  'forint',
  'koruna',
  'shekel',
  'chilean_peso',
  'philippine_peso',
  'dirham',
  'colombian_peso',
  'riyal',
  'ringgit',
  'leu',
  'argentine_peso',
  'uruguayan_peso',
  'singapore_dollar',
).annotations({
  identifier: 'Notion.NumberFormat',
})

export type NumberFormat = typeof NumberFormat.Type

/** Rollup function options */
export const RollupFunction = Schema.Literal(
  'count',
  'count_values',
  'empty',
  'not_empty',
  'unique',
  'show_unique',
  'percent_empty',
  'percent_not_empty',
  'sum',
  'average',
  'median',
  'min',
  'max',
  'range',
  'earliest_date',
  'latest_date',
  'date_range',
  'checked',
  'unchecked',
  'percent_checked',
  'percent_unchecked',
  'show_original',
).annotations({
  identifier: 'Notion.RollupFunction',
})

export type RollupFunction = typeof RollupFunction.Type

// -----------------------------------------------------------------------------
// Property Schema Base
// -----------------------------------------------------------------------------

const PropertySchemaBase = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.optional(Schema.NullOr(Schema.String)),
})

// -----------------------------------------------------------------------------
// Property Schema Variants
// -----------------------------------------------------------------------------

/** Title property schema */
export const TitlePropertySchema = Schema.extend(
  PropertySchemaBase,
  Schema.TaggedStruct('title', {}),
).annotations({
  identifier: 'Notion.TitlePropertySchema',
  [docsPath]: 'database-property#title',
})

export type TitlePropertySchema = typeof TitlePropertySchema.Type

/** Rich text property schema */
export const RichTextPropertySchema = Schema.extend(
  PropertySchemaBase,
  Schema.TaggedStruct('rich_text', {}),
).annotations({
  identifier: 'Notion.RichTextPropertySchema',
  [docsPath]: 'database-property#rich-text',
})

export type RichTextPropertySchema = typeof RichTextPropertySchema.Type

/** Number property schema */
export const NumberPropertySchema = Schema.extend(
  PropertySchemaBase,
  Schema.TaggedStruct('number', {
    number: Schema.Struct({
      format: NumberFormat,
    }),
  }),
).annotations({
  identifier: 'Notion.NumberPropertySchema',
  [docsPath]: 'database-property#number',
})

export type NumberPropertySchema = typeof NumberPropertySchema.Type

/** Select property schema */
export const SelectPropertySchema = Schema.extend(
  PropertySchemaBase,
  Schema.TaggedStruct('select', {
    select: Schema.Struct({
      options: Schema.Array(SelectOptionConfig),
    }),
  }),
).annotations({
  identifier: 'Notion.SelectPropertySchema',
  [docsPath]: 'database-property#select',
})

export type SelectPropertySchema = typeof SelectPropertySchema.Type

/** Multi-select property schema */
export const MultiSelectPropertySchema = Schema.extend(
  PropertySchemaBase,
  Schema.TaggedStruct('multi_select', {
    multi_select: Schema.Struct({
      options: Schema.Array(SelectOptionConfig),
    }),
  }),
).annotations({
  identifier: 'Notion.MultiSelectPropertySchema',
  [docsPath]: 'database-property#multi-select',
})

export type MultiSelectPropertySchema = typeof MultiSelectPropertySchema.Type

/** Status property schema */
export const StatusPropertySchema = Schema.extend(
  PropertySchemaBase,
  Schema.TaggedStruct('status', {
    status: Schema.Struct({
      options: Schema.Array(SelectOptionConfig),
      groups: Schema.Array(StatusGroupConfig),
    }),
  }),
).annotations({
  identifier: 'Notion.StatusPropertySchema',
  [docsPath]: 'database-property#status',
})

export type StatusPropertySchema = typeof StatusPropertySchema.Type

/** Date property schema */
export const DatePropertySchema = Schema.extend(
  PropertySchemaBase,
  Schema.TaggedStruct('date', {}),
).annotations({
  identifier: 'Notion.DatePropertySchema',
  [docsPath]: 'database-property#date',
})

export type DatePropertySchema = typeof DatePropertySchema.Type

/** People property schema */
export const PeoplePropertySchema = Schema.extend(
  PropertySchemaBase,
  Schema.TaggedStruct('people', {}),
).annotations({
  identifier: 'Notion.PeoplePropertySchema',
  [docsPath]: 'database-property#people',
})

export type PeoplePropertySchema = typeof PeoplePropertySchema.Type

/** Files property schema */
export const FilesPropertySchema = Schema.extend(
  PropertySchemaBase,
  Schema.TaggedStruct('files', {}),
).annotations({
  identifier: 'Notion.FilesPropertySchema',
  [docsPath]: 'database-property#files',
})

export type FilesPropertySchema = typeof FilesPropertySchema.Type

/** Checkbox property schema */
export const CheckboxPropertySchema = Schema.extend(
  PropertySchemaBase,
  Schema.TaggedStruct('checkbox', {}),
).annotations({
  identifier: 'Notion.CheckboxPropertySchema',
  [docsPath]: 'database-property#checkbox',
})

export type CheckboxPropertySchema = typeof CheckboxPropertySchema.Type

/** URL property schema */
export const UrlPropertySchema = Schema.extend(
  PropertySchemaBase,
  Schema.TaggedStruct('url', {}),
).annotations({
  identifier: 'Notion.UrlPropertySchema',
  [docsPath]: 'database-property#url',
})

export type UrlPropertySchema = typeof UrlPropertySchema.Type

/** Email property schema */
export const EmailPropertySchema = Schema.extend(
  PropertySchemaBase,
  Schema.TaggedStruct('email', {}),
).annotations({
  identifier: 'Notion.EmailPropertySchema',
  [docsPath]: 'database-property#email',
})

export type EmailPropertySchema = typeof EmailPropertySchema.Type

/** Phone number property schema */
export const PhoneNumberPropertySchema = Schema.extend(
  PropertySchemaBase,
  Schema.TaggedStruct('phone_number', {}),
).annotations({
  identifier: 'Notion.PhoneNumberPropertySchema',
  [docsPath]: 'database-property#phone-number',
})

export type PhoneNumberPropertySchema = typeof PhoneNumberPropertySchema.Type

/** Formula property schema */
export const FormulaPropertySchema = Schema.extend(
  PropertySchemaBase,
  Schema.TaggedStruct('formula', {
    formula: Schema.Struct({
      expression: Schema.String,
    }),
  }),
).annotations({
  identifier: 'Notion.FormulaPropertySchema',
  [docsPath]: 'database-property#formula',
})

export type FormulaPropertySchema = typeof FormulaPropertySchema.Type

/** Relation property schema */
export const RelationPropertySchema = Schema.extend(
  PropertySchemaBase,
  Schema.TaggedStruct('relation', {
    relation: Schema.Struct({
      database_id: NotionUUID,
      type: Schema.Literal('single_property', 'dual_property'),
      single_property: Schema.optional(Schema.Struct({})),
      dual_property: Schema.optional(
        Schema.Struct({
          synced_property_id: Schema.String,
          synced_property_name: Schema.String,
        }),
      ),
    }),
  }),
).annotations({
  identifier: 'Notion.RelationPropertySchema',
  [docsPath]: 'database-property#relation',
})

export type RelationPropertySchema = typeof RelationPropertySchema.Type

/** Rollup property schema */
export const RollupPropertySchema = Schema.extend(
  PropertySchemaBase,
  Schema.TaggedStruct('rollup', {
    rollup: Schema.Struct({
      relation_property_name: Schema.String,
      relation_property_id: Schema.String,
      rollup_property_name: Schema.String,
      rollup_property_id: Schema.String,
      function: RollupFunction,
    }),
  }),
).annotations({
  identifier: 'Notion.RollupPropertySchema',
  [docsPath]: 'database-property#rollup',
})

export type RollupPropertySchema = typeof RollupPropertySchema.Type

/** Created time property schema (read-only) */
export const CreatedTimePropertySchema = Schema.extend(
  PropertySchemaBase,
  Schema.TaggedStruct('created_time', {}),
).annotations({
  identifier: 'Notion.CreatedTimePropertySchema',
  [docsPath]: 'database-property#created-time',
})

export type CreatedTimePropertySchema = typeof CreatedTimePropertySchema.Type

/** Created by property schema (read-only) */
export const CreatedByPropertySchema = Schema.extend(
  PropertySchemaBase,
  Schema.TaggedStruct('created_by', {}),
).annotations({
  identifier: 'Notion.CreatedByPropertySchema',
  [docsPath]: 'database-property#created-by',
})

export type CreatedByPropertySchema = typeof CreatedByPropertySchema.Type

/** Last edited time property schema (read-only) */
export const LastEditedTimePropertySchema = Schema.extend(
  PropertySchemaBase,
  Schema.TaggedStruct('last_edited_time', {}),
).annotations({
  identifier: 'Notion.LastEditedTimePropertySchema',
  [docsPath]: 'database-property#last-edited-time',
})

export type LastEditedTimePropertySchema = typeof LastEditedTimePropertySchema.Type

/** Last edited by property schema (read-only) */
export const LastEditedByPropertySchema = Schema.extend(
  PropertySchemaBase,
  Schema.TaggedStruct('last_edited_by', {}),
).annotations({
  identifier: 'Notion.LastEditedByPropertySchema',
  [docsPath]: 'database-property#last-edited-by',
})

export type LastEditedByPropertySchema = typeof LastEditedByPropertySchema.Type

/** Unique ID property schema (read-only) */
export const UniqueIdPropertySchema = Schema.extend(
  PropertySchemaBase,
  Schema.TaggedStruct('unique_id', {
    unique_id: Schema.Struct({
      prefix: Schema.NullOr(Schema.String),
    }),
  }),
).annotations({
  identifier: 'Notion.UniqueIdPropertySchema',
  [docsPath]: 'database-property#unique-id',
})

export type UniqueIdPropertySchema = typeof UniqueIdPropertySchema.Type

/** Verification property schema */
export const VerificationPropertySchema = Schema.extend(
  PropertySchemaBase,
  Schema.TaggedStruct('verification', {}),
).annotations({
  identifier: 'Notion.VerificationPropertySchema',
})

export type VerificationPropertySchema = typeof VerificationPropertySchema.Type

/** Button property schema */
export const ButtonPropertySchema = Schema.extend(
  PropertySchemaBase,
  Schema.TaggedStruct('button', {}),
).annotations({
  identifier: 'Notion.ButtonPropertySchema',
})

export type ButtonPropertySchema = typeof ButtonPropertySchema.Type

// -----------------------------------------------------------------------------
// Property Schema Union
// -----------------------------------------------------------------------------

/**
 * Union of all database property schema configurations.
 * Discriminated by the `_tag` field (property type).
 */
export const PropertySchema = Schema.Union(
  TitlePropertySchema,
  RichTextPropertySchema,
  NumberPropertySchema,
  SelectPropertySchema,
  MultiSelectPropertySchema,
  StatusPropertySchema,
  DatePropertySchema,
  PeoplePropertySchema,
  FilesPropertySchema,
  CheckboxPropertySchema,
  UrlPropertySchema,
  EmailPropertySchema,
  PhoneNumberPropertySchema,
  FormulaPropertySchema,
  RelationPropertySchema,
  RollupPropertySchema,
  CreatedTimePropertySchema,
  CreatedByPropertySchema,
  LastEditedTimePropertySchema,
  LastEditedByPropertySchema,
  UniqueIdPropertySchema,
  VerificationPropertySchema,
  ButtonPropertySchema,
).annotations({
  identifier: 'Notion.PropertySchema',
  description: 'Database property schema configuration (discriminated union)',
})

export type PropertySchema = typeof PropertySchema.Type

/** All property type tags */
export type PropertySchemaTag = PropertySchema['_tag']
