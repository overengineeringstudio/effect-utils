/**
 * Canonical property-value shape and write-class taxonomy.
 *
 * The canonical union is the medium-independent normalization of any Notion
 * property value. It is the source of truth that downstream sync engines hash
 * for change detection, so its `JSON.stringify` byte layout (key order, optional
 * omission, `_tag` placement) is a hard contract — see `canonical-codec.ts`.
 *
 * The Notion-identity brands (`PropertyId`/`PageId`/`PropertyName`) are owned
 * here (strategy B): the canonical union carries them directly and the consuming
 * sync package aliases them, so there is no re-brand mirror layer. Brands erase
 * at runtime, so the `JSON.stringify` byte layout is unaffected.
 *
 * Hashing stays out of this package: `CanonicalHash` is an unbranded string and
 * the hash *values* are computed by the caller (the codec takes an injected
 * `hash`), never here. The consuming package keeps its own `sha256:`-validating
 * `Hash` brand for store/projection digests; the canonical hash fields stay
 * unbranded because no consumer reads them as a typed hash.
 *
 * @module
 */

import { Schema } from 'effect'

import {
  NOTION_PROPERTY_TYPES,
  PROPERTY_WRITE_CLASSES,
  propertyWriteClassFromType as propertyWriteClassFromTypeCore,
} from '@overeng/notion-core'

/** Branded Notion property ID (stable identifier within a database schema). */
export const PropertyId = Schema.NonEmptyTrimmedString.pipe(
  Schema.brand('Notion.PropertyId'),
  Schema.annotations({ identifier: 'Notion.PropertyId' }),
)
export type PropertyId = typeof PropertyId.Type

/** Branded human-readable Notion property name (mutable; distinct from the stable `PropertyId`). */
export const PropertyName = Schema.NonEmptyTrimmedString.pipe(
  Schema.brand('Notion.PropertyName'),
  Schema.annotations({ identifier: 'Notion.PropertyName' }),
)
export type PropertyName = typeof PropertyName.Type

/** Branded Notion page ID. */
export const PageId = Schema.NonEmptyTrimmedString.pipe(
  Schema.brand('Notion.PageId'),
  Schema.annotations({ identifier: 'Notion.PageId' }),
)
export type PageId = typeof PageId.Type

/** Opaque content-hash string (e.g. `sha256:…`). Computed by the caller, not here. */
export const CanonicalHash = Schema.String.annotations({ identifier: 'Notion.Canonical.Hash' })
export type CanonicalHash = typeof CanonicalHash.Type

/** Canonical select/multi-select/status option, normalized for stable hash comparison. */
export const CanonicalOptionValue = Schema.TaggedStruct('CanonicalOptionValue', {
  id: Schema.optional(PropertyId),
  name: PropertyName,
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
    pageIds: Schema.Array(PageId),
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
  ...NOTION_PROPERTY_TYPES,
).annotations({ identifier: 'Notion.PropertyType' })
export type NotionPropertyType = typeof NotionPropertyType.Type

/** How a property value may be written back to Notion. */
export const PropertyWriteClass = Schema.Literal(...PROPERTY_WRITE_CLASSES).annotations({
  identifier: 'Notion.PropertyWriteClass',
})
export type PropertyWriteClass = typeof PropertyWriteClass.Type

/**
 * Classify a Notion property type by how it may be written back.
 *
 * Computed properties (audit, formula, rollup, unique_id, verification) cannot
 * be written; `button` and any unrecognized type are unsupported; everything
 * else is writable. Mirrors the change-detection contract exactly — do not
 * "fix" the partial coverage, it feeds canonical hashing downstream.
 */
export const propertyWriteClassFromType = (propertyType: string): PropertyWriteClass =>
  propertyWriteClassFromTypeCore(propertyType)
