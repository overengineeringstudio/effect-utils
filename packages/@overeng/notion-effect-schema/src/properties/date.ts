import { Option, Schema } from 'effect'

import { docsPath, shouldNeverHappen } from '../common.ts'

// -----------------------------------------------------------------------------
// Date Property
// -----------------------------------------------------------------------------

/**
 * Date value object used in date properties.
 *
 * @see https://developers.notion.com/reference/property-value-object#date
 */
export const DateValue = Schema.Struct({
  start: Schema.String.annotations({
    description: 'Start date in ISO 8601 format.',
    examples: ['2024-01-15', '2024-01-15T10:30:00.000Z'],
  }),
  end: Schema.NullOr(Schema.String).annotations({
    description: 'End date for date ranges, or null for single dates.',
  }),
  time_zone: Schema.NullOr(Schema.String).annotations({
    description: 'IANA time zone, or null for dates without time.',
    examples: ['America/New_York', 'Europe/London'],
  }),
}).annotations({
  identifier: 'Notion.DateValue',
  title: 'Date Value',
  description: 'A date or date range value.',
  [docsPath]: 'property-value-object#date',
})

export type DateValue = typeof DateValue.Type

/**
 * Date property value from the Notion API.
 *
 * @see https://developers.notion.com/reference/property-value-object#date
 */
export const DateProperty = Schema.Struct({
  id: Schema.String.annotations({
    description: 'Property identifier.',
  }),
  type: Schema.Literal('date').annotations({
    description: 'Property type identifier.',
  }),
  date: Schema.NullOr(DateValue).annotations({
    description: 'The date value, or null if empty.',
  }),
}).annotations({
  identifier: 'Notion.DateProperty',
  title: 'Date Property',
  description: 'A date property value.',
  [docsPath]: 'property-value-object#date',
})

export type DateProperty = typeof DateProperty.Type

/**
 * Date value write object accepted by Notion.
 * In write requests, `end` / `time_zone` are optional.
 *
 * @see https://developers.notion.com/reference/page#page-property-value
 */
export const DateValueWrite = Schema.Struct({
  start: Schema.String,
  end: Schema.optional(Schema.NullOr(Schema.String)),
  time_zone: Schema.optional(Schema.NullOr(Schema.String)),
}).annotations({
  identifier: 'Notion.DateValueWrite',
  title: 'Date Value (Write)',
  description: 'Date value object accepted in Notion write requests.',
  [docsPath]: 'page#page-property-value',
})

export type DateValueWrite = typeof DateValueWrite.Type

/**
 * Date property write payload (for create/update page requests).
 *
 * @see https://developers.notion.com/reference/page#page-property-value
 */
export const DateWrite = Schema.Struct({
  date: Schema.NullOr(DateValueWrite),
}).annotations({
  identifier: 'Notion.DateWrite',
  title: 'Date (Write)',
  description: 'Write payload for a date property (used in page create/update).',
  [docsPath]: 'page#page-property-value',
})

export type DateWrite = typeof DateWrite.Type

export const DateWriteFromStart = Schema.transform(Schema.String, DateWrite, {
  strict: false,
  decode: (start) => ({ date: { start } }),
  encode: (write) => {
    if (write.date === null) {
      return ''
    }

    return write.date.start
  },
}).annotations({
  identifier: 'Notion.DateWriteFromStart',
  title: 'Date (Write) From Start',
  description: 'Transform a start date/time string into a date write payload.',
  [docsPath]: 'page#page-property-value',
})

/** Transforms for Date property. */
export const DateProp = {
  /** The raw DateProperty schema. */
  Property: DateProperty,

  /** Transform to raw nullable DateValue. */
  raw: Schema.transform(DateProperty, Schema.NullOr(DateValue), {
    strict: false,
    decode: (prop) => prop.date,
    encode: () =>
      shouldNeverHappen(
        'DateProp.raw encode is not supported. Use DateWrite / DateWriteFromStart.',
      ),
  }),

  /** Transform to Option<DateValue>. */
  asOption: Schema.transform(DateProperty, Schema.OptionFromSelf(DateValue), {
    strict: false,
    decode: (prop) => (prop.date === null ? Option.none() : Option.some(prop.date)),
    encode: () =>
      shouldNeverHappen(
        'DateProp.asOption encode is not supported. Use DateWrite / DateWriteFromStart.',
      ),
  }),

  /** Transform to Option<Date> (start date only, parsed). */
  asDate: Schema.transform(DateProperty, Schema.OptionFromSelf(Schema.DateFromSelf), {
    strict: false,
    decode: (prop) => (prop.date === null ? Option.none() : Option.some(new Date(prop.date.start))),
    encode: () =>
      shouldNeverHappen(
        'DateProp.asDate encode is not supported. Use DateWrite / DateWriteFromStart.',
      ),
  }),

  Write: {
    Schema: DateWrite,
    fromStart: DateWriteFromStart,
  },
} as const
