import { Schema } from 'effect'

import { docsPath, shouldNeverHappen } from '../common.ts'
import { PartialUser } from '../users.ts'

// -----------------------------------------------------------------------------
// Created Time Property (Read-only)
// -----------------------------------------------------------------------------

/**
 * Created time property value from the Notion API (read-only).
 *
 * @see https://developers.notion.com/reference/property-value-object#created-time
 */
export const CreatedTimeProperty = Schema.Struct({
  id: Schema.String.annotations({
    description: 'Property identifier.',
  }),
  type: Schema.Literal('created_time').annotations({
    description: 'Property type identifier.',
  }),
  created_time: Schema.String.annotations({
    description: 'When the page was created (ISO 8601).',
    examples: ['2024-01-15T10:30:00.000Z'],
  }),
}).annotations({
  identifier: 'Notion.CreatedTimeProperty',
  title: 'Created Time Property',
  description: 'The creation timestamp (read-only).',
  [docsPath]: 'property-value-object#created-time',
})

export type CreatedTimeProperty = typeof CreatedTimeProperty.Type

/** Transforms for CreatedTime property. */
export const CreatedTime = {
  /** The raw CreatedTimeProperty schema. */
  Property: CreatedTimeProperty,

  /** Transform to raw ISO string. */
  raw: Schema.transform(CreatedTimeProperty, Schema.String, {
    strict: false,
    decode: (prop) => prop.created_time,
    encode: () =>
      shouldNeverHappen('CreatedTime.raw encode is not supported (created_time is read-only).'),
  }),

  /** Transform to Date object. */
  asDate: Schema.transform(CreatedTimeProperty, Schema.DateFromSelf, {
    strict: false,
    decode: (prop) => new Date(prop.created_time),
    encode: () =>
      shouldNeverHappen('CreatedTime.asDate encode is not supported (created_time is read-only).'),
  }),
} as const

// -----------------------------------------------------------------------------
// Created By Property (Read-only)
// -----------------------------------------------------------------------------

/**
 * Created by property value from the Notion API (read-only).
 *
 * @see https://developers.notion.com/reference/property-value-object#created-by
 */
export const CreatedByProperty = Schema.Struct({
  id: Schema.String.annotations({
    description: 'Property identifier.',
  }),
  type: Schema.Literal('created_by').annotations({
    description: 'Property type identifier.',
  }),
  created_by: PartialUser.annotations({
    description: 'The user who created the page.',
  }),
}).annotations({
  identifier: 'Notion.CreatedByProperty',
  title: 'Created By Property',
  description: 'The user who created the page (read-only).',
  [docsPath]: 'property-value-object#created-by',
})

export type CreatedByProperty = typeof CreatedByProperty.Type

/** Transforms for CreatedBy property. */
export const CreatedBy = {
  /** The raw CreatedByProperty schema. */
  Property: CreatedByProperty,

  /** Transform to raw PartialUser. */
  raw: Schema.transform(CreatedByProperty, PartialUser, {
    strict: false,
    decode: (prop) => prop.created_by,
    encode: () =>
      shouldNeverHappen('CreatedBy.raw encode is not supported (created_by is read-only).'),
  }),

  /** Transform to user ID. */
  asId: Schema.transform(CreatedByProperty, Schema.String, {
    strict: false,
    decode: (prop) => prop.created_by.id,
    encode: () =>
      shouldNeverHappen('CreatedBy.asId encode is not supported (created_by is read-only).'),
  }),
} as const

// -----------------------------------------------------------------------------
// Last Edited Time Property (Read-only)
// -----------------------------------------------------------------------------

/**
 * Last edited time property value from the Notion API (read-only).
 *
 * @see https://developers.notion.com/reference/property-value-object#last-edited-time
 */
export const LastEditedTimeProperty = Schema.Struct({
  id: Schema.String.annotations({
    description: 'Property identifier.',
  }),
  type: Schema.Literal('last_edited_time').annotations({
    description: 'Property type identifier.',
  }),
  last_edited_time: Schema.String.annotations({
    description: 'When the page was last edited (ISO 8601).',
    examples: ['2024-01-15T10:30:00.000Z'],
  }),
}).annotations({
  identifier: 'Notion.LastEditedTimeProperty',
  title: 'Last Edited Time Property',
  description: 'The last edit timestamp (read-only).',
  [docsPath]: 'property-value-object#last-edited-time',
})

export type LastEditedTimeProperty = typeof LastEditedTimeProperty.Type

/** Transforms for LastEditedTime property. */
export const LastEditedTime = {
  /** The raw LastEditedTimeProperty schema. */
  Property: LastEditedTimeProperty,

  /** Transform to raw ISO string. */
  raw: Schema.transform(LastEditedTimeProperty, Schema.String, {
    strict: false,
    decode: (prop) => prop.last_edited_time,
    encode: () =>
      shouldNeverHappen(
        'LastEditedTime.raw encode is not supported (last_edited_time is read-only).',
      ),
  }),

  /** Transform to Date object. */
  asDate: Schema.transform(LastEditedTimeProperty, Schema.DateFromSelf, {
    strict: false,
    decode: (prop) => new Date(prop.last_edited_time),
    encode: () =>
      shouldNeverHappen(
        'LastEditedTime.asDate encode is not supported (last_edited_time is read-only).',
      ),
  }),
} as const

// -----------------------------------------------------------------------------
// Last Edited By Property (Read-only)
// -----------------------------------------------------------------------------

/**
 * Last edited by property value from the Notion API (read-only).
 *
 * @see https://developers.notion.com/reference/property-value-object#last-edited-by
 */
export const LastEditedByProperty = Schema.Struct({
  id: Schema.String.annotations({
    description: 'Property identifier.',
  }),
  type: Schema.Literal('last_edited_by').annotations({
    description: 'Property type identifier.',
  }),
  last_edited_by: PartialUser.annotations({
    description: 'The user who last edited the page.',
  }),
}).annotations({
  identifier: 'Notion.LastEditedByProperty',
  title: 'Last Edited By Property',
  description: 'The user who last edited the page (read-only).',
  [docsPath]: 'property-value-object#last-edited-by',
})

export type LastEditedByProperty = typeof LastEditedByProperty.Type

/** Transforms for LastEditedBy property. */
export const LastEditedBy = {
  /** The raw LastEditedByProperty schema. */
  Property: LastEditedByProperty,

  /** Transform to raw PartialUser. */
  raw: Schema.transform(LastEditedByProperty, PartialUser, {
    strict: false,
    decode: (prop) => prop.last_edited_by,
    encode: () =>
      shouldNeverHappen('LastEditedBy.raw encode is not supported (last_edited_by is read-only).'),
  }),

  /** Transform to user ID. */
  asId: Schema.transform(LastEditedByProperty, Schema.String, {
    strict: false,
    decode: (prop) => prop.last_edited_by.id,
    encode: () =>
      shouldNeverHappen('LastEditedBy.asId encode is not supported (last_edited_by is read-only).'),
  }),
} as const
