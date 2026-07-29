import { Schema, SchemaTransformation } from 'effect'

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
  id: Schema.String.annotate({
    description: 'Property identifier.',
  }),
  type: Schema.Literal('created_time').annotate({
    description: 'Property type identifier.',
  }),
  created_time: Schema.String.annotate({
    description: 'When the page was created (ISO 8601).',
    examples: ['2024-01-15T10:30:00.000Z'],
  }),
}).annotate({
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
  raw: CreatedTimeProperty.pipe(
    Schema.decodeTo(
      Schema.String,
      SchemaTransformation.transform<string, CreatedTimeProperty>({
        decode: (prop) => prop.created_time,
        encode: (): CreatedTimeProperty =>
          shouldNeverHappen('CreatedTime.raw encode is not supported (created_time is read-only).'),
      }),
    ),
  ),

  /** Transform to Date object. */
  asDate: CreatedTimeProperty.pipe(
    Schema.decodeTo(
      Schema.Date,
      SchemaTransformation.transform<Date, CreatedTimeProperty>({
        decode: (prop) => new Date(prop.created_time),
        encode: (): CreatedTimeProperty =>
          shouldNeverHappen(
            'CreatedTime.asDate encode is not supported (created_time is read-only).',
          ),
      }),
    ),
  ),
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
  id: Schema.String.annotate({
    description: 'Property identifier.',
  }),
  type: Schema.Literal('created_by').annotate({
    description: 'Property type identifier.',
  }),
  created_by: PartialUser.annotate({
    description: 'The user who created the page.',
  }),
}).annotate({
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
  raw: CreatedByProperty.pipe(
    Schema.decodeTo(
      PartialUser,
      SchemaTransformation.transform<PartialUser, CreatedByProperty>({
        decode: (prop) => prop.created_by,
        encode: (): CreatedByProperty =>
          shouldNeverHappen('CreatedBy.raw encode is not supported (created_by is read-only).'),
      }),
    ),
  ),

  /** Transform to user ID. */
  asId: CreatedByProperty.pipe(
    Schema.decodeTo(
      Schema.String,
      SchemaTransformation.transform<string, CreatedByProperty>({
        decode: (prop) => prop.created_by.id,
        encode: (): CreatedByProperty =>
          shouldNeverHappen('CreatedBy.asId encode is not supported (created_by is read-only).'),
      }),
    ),
  ),
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
  id: Schema.String.annotate({
    description: 'Property identifier.',
  }),
  type: Schema.Literal('last_edited_time').annotate({
    description: 'Property type identifier.',
  }),
  last_edited_time: Schema.String.annotate({
    description: 'When the page was last edited (ISO 8601).',
    examples: ['2024-01-15T10:30:00.000Z'],
  }),
}).annotate({
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
  raw: LastEditedTimeProperty.pipe(
    Schema.decodeTo(
      Schema.String,
      SchemaTransformation.transform<string, LastEditedTimeProperty>({
        decode: (prop) => prop.last_edited_time,
        encode: (): LastEditedTimeProperty =>
          shouldNeverHappen(
            'LastEditedTime.raw encode is not supported (last_edited_time is read-only).',
          ),
      }),
    ),
  ),

  /** Transform to Date object. */
  asDate: LastEditedTimeProperty.pipe(
    Schema.decodeTo(
      Schema.Date,
      SchemaTransformation.transform<Date, LastEditedTimeProperty>({
        decode: (prop) => new Date(prop.last_edited_time),
        encode: (): LastEditedTimeProperty =>
          shouldNeverHappen(
            'LastEditedTime.asDate encode is not supported (last_edited_time is read-only).',
          ),
      }),
    ),
  ),
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
  id: Schema.String.annotate({
    description: 'Property identifier.',
  }),
  type: Schema.Literal('last_edited_by').annotate({
    description: 'Property type identifier.',
  }),
  last_edited_by: PartialUser.annotate({
    description: 'The user who last edited the page.',
  }),
}).annotate({
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
  raw: LastEditedByProperty.pipe(
    Schema.decodeTo(
      PartialUser,
      SchemaTransformation.transform<PartialUser, LastEditedByProperty>({
        decode: (prop) => prop.last_edited_by,
        encode: (): LastEditedByProperty =>
          shouldNeverHappen(
            'LastEditedBy.raw encode is not supported (last_edited_by is read-only).',
          ),
      }),
    ),
  ),

  /** Transform to user ID. */
  asId: LastEditedByProperty.pipe(
    Schema.decodeTo(
      Schema.String,
      SchemaTransformation.transform<string, LastEditedByProperty>({
        decode: (prop) => prop.last_edited_by.id,
        encode: (): LastEditedByProperty =>
          shouldNeverHappen(
            'LastEditedBy.asId encode is not supported (last_edited_by is read-only).',
          ),
      }),
    ),
  ),
} as const
