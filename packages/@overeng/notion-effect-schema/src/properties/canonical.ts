/**
 * Canonical property-value shape and write-class taxonomy.
 *
 * The canonical union is the medium-independent normalization of any Notion
 * property value. It is the source of truth that downstream sync engines hash
 * for change detection, so its `JSON.stringify` byte layout (key order, optional
 * omission, `_tag` placement) is a hard contract — see `canonical-codec.ts`.
 *
 * Brands are deliberately stripped here (strategy A): this package holds plain
 * `Schema.String`/`NonEmptyTrimmedString` and the consuming package re-brands
 * id/name/hash fields at its own boundary. The hash *values* are computed by the
 * caller (the codec takes an injected `hash`), never by this package.
 *
 * @module
 */

import { Schema } from 'effect'

/** Opaque content-hash string (e.g. `sha256:…`). Computed by the caller, not here. */
export const CanonicalHash = Schema.String.annotations({ identifier: 'Notion.Canonical.Hash' })
export type CanonicalHash = typeof CanonicalHash.Type

/** Canonical select/multi-select/status option, normalized for stable hash comparison. */
export const CanonicalOptionValue = Schema.TaggedStruct('CanonicalOptionValue', {
  id: Schema.optional(Schema.String),
  name: Schema.NonEmptyTrimmedString,
  color: Schema.optional(Schema.NonEmptyTrimmedString),
}).annotations({ identifier: 'Notion.Canonical.OptionValue' })
export type CanonicalOptionValue = typeof CanonicalOptionValue.Type

/** Canonical file attachment: name plus a stable identity hash used for change detection. */
export const CanonicalFileValue = Schema.TaggedStruct('CanonicalFileValue', {
  name: Schema.NonEmptyTrimmedString,
  identityHash: CanonicalHash,
  externalUrl: Schema.optional(Schema.NonEmptyTrimmedString),
}).annotations({ identifier: 'Notion.Canonical.FileValue' })
export type CanonicalFileValue = typeof CanonicalFileValue.Type

/** Normalized representation of any Notion property value; the `_tag` discriminates the variant. Computed properties carry only their hash. */
export const CanonicalPropertyValue = Schema.Union(
  Schema.TaggedStruct('empty', {}),
  Schema.TaggedStruct('title', {
    plainText: Schema.String,
  }),
  Schema.TaggedStruct('rich_text', {
    plainText: Schema.String,
  }),
  Schema.TaggedStruct('number', {
    value: Schema.Number,
  }),
  Schema.TaggedStruct('checkbox', {
    checked: Schema.Boolean,
  }),
  Schema.TaggedStruct('date', {
    start: Schema.DateTimeUtc,
    end: Schema.NullOr(Schema.DateTimeUtc),
  }),
  Schema.TaggedStruct('select', {
    option: Schema.NullOr(CanonicalOptionValue),
  }),
  Schema.TaggedStruct('multi_select', {
    options: Schema.Array(CanonicalOptionValue),
  }),
  Schema.TaggedStruct('status', {
    option: Schema.NullOr(CanonicalOptionValue),
  }),
  Schema.TaggedStruct('relation', {
    pageIds: Schema.Array(Schema.String),
  }),
  Schema.TaggedStruct('people', {
    userIds: Schema.Array(Schema.NonEmptyTrimmedString),
  }),
  Schema.TaggedStruct('files', {
    files: Schema.Array(CanonicalFileValue),
  }),
  Schema.TaggedStruct('email', {
    value: Schema.NullOr(Schema.String),
  }),
  Schema.TaggedStruct('url', {
    value: Schema.NullOr(Schema.String),
  }),
  Schema.TaggedStruct('phone_number', {
    value: Schema.NullOr(Schema.String),
  }),
  Schema.TaggedStruct('computed', {
    valueHash: CanonicalHash,
  }),
).annotations({ identifier: 'Notion.Canonical.PropertyValue' })
export type CanonicalPropertyValue = typeof CanonicalPropertyValue.Type

/** Every Notion property *type* tag the API can return. */
export const NotionPropertyType = Schema.Literal(
  'title',
  'rich_text',
  'number',
  'checkbox',
  'date',
  'select',
  'multi_select',
  'status',
  'relation',
  'people',
  'files',
  'email',
  'url',
  'phone_number',
  'formula',
  'rollup',
  'created_time',
  'created_by',
  'last_edited_time',
  'last_edited_by',
  'unique_id',
  'verification',
  'button',
).annotations({ identifier: 'Notion.PropertyType' })
export type NotionPropertyType = typeof NotionPropertyType.Type

/** How a property value may be written back to Notion. */
export const PropertyWriteClass = Schema.Literal('writable', 'computed', 'unsupported').annotations(
  {
    identifier: 'Notion.PropertyWriteClass',
  },
)
export type PropertyWriteClass = typeof PropertyWriteClass.Type

/**
 * Classify a Notion property type by how it may be written back.
 *
 * Computed properties (audit, formula, rollup, unique_id, verification) cannot
 * be written; `button` and any unrecognized type are unsupported; everything
 * else is writable. Mirrors the change-detection contract exactly — do not
 * "fix" the partial coverage, it feeds canonical hashing downstream.
 */
export const propertyWriteClassFromType = (propertyType: string): PropertyWriteClass => {
  switch (propertyType) {
    case 'formula':
    case 'rollup':
    case 'created_time':
    case 'created_by':
    case 'last_edited_time':
    case 'last_edited_by':
    case 'unique_id':
    case 'verification':
      return 'computed'
    case 'title':
    case 'rich_text':
    case 'number':
    case 'checkbox':
    case 'date':
    case 'select':
    case 'multi_select':
    case 'status':
    case 'email':
    case 'url':
    case 'phone_number':
    case 'relation':
    case 'people':
    case 'files':
      return 'writable'
    default:
      return 'unsupported'
  }
}
