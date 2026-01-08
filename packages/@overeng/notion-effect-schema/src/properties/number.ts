import { Option, Schema } from 'effect'

import { docsPath, shouldNeverHappen, withOptionValueSchema } from '../common.ts'

// -----------------------------------------------------------------------------
// Number Property
// -----------------------------------------------------------------------------

/**
 * Number property value from the Notion API.
 *
 * @see https://developers.notion.com/reference/property-value-object#number
 */
export const NumberProperty = Schema.Struct({
  id: Schema.String.annotations({
    description: 'Property identifier.',
  }),
  type: Schema.Literal('number').annotations({
    description: 'Property type identifier.',
  }),
  number: Schema.NullOr(Schema.Number).annotations({
    description: 'The numeric value, or null if empty.',
    examples: [42, 3.14, null],
  }),
}).annotations({
  identifier: 'Notion.NumberProperty',
  title: 'Number Property',
  description: 'A number property value.',
  [docsPath]: 'property-value-object#number',
})

export type NumberProperty = typeof NumberProperty.Type

/**
 * Number property write payload (for create/update page requests).
 *
 * @see https://developers.notion.com/reference/page#page-property-value
 */
export const NumberWrite = Schema.Struct({
  number: Schema.NullOr(Schema.Number),
}).annotations({
  identifier: 'Notion.NumberWrite',
  title: 'Number (Write)',
  description: 'Write payload for a number property (used in page create/update).',
  [docsPath]: 'page#page-property-value',
})

export type NumberWrite = typeof NumberWrite.Type

/** Transform schema for converting number to NumberWrite payload */
export const NumberWriteFromNumber = Schema.transform(Schema.NullOr(Schema.Number), NumberWrite, {
  strict: false,
  decode: (number) => ({ number }),
  encode: (write) => write.number,
}).annotations({
  identifier: 'Notion.NumberWriteFromNumber',
  title: 'Number (Write) From Number',
  description: 'Transform a number (or null) into a number write payload.',
  [docsPath]: 'page#page-property-value',
})

/** Transforms for Number property. */
export const Num = {
  /** The raw NumberProperty schema. */
  Property: NumberProperty,

  /** Transform to raw nullable number. */
  raw: Schema.transform(NumberProperty, Schema.NullOr(Schema.Number), {
    strict: false,
    decode: (prop) => prop.number,
    encode: () =>
      shouldNeverHappen(
        'Num.raw encode is not supported. Use NumberWrite / NumberWriteFromNumber.',
      ),
  }),

  /** Transform to Option<number>. */
  asOption: withOptionValueSchema({
    schema: Schema.transform(NumberProperty, Schema.OptionFromSelf(Schema.Number), {
      strict: false,
      decode: (prop) => (prop.number === null ? Option.none() : Option.some(prop.number)),
      encode: () =>
        shouldNeverHappen(
          'Num.asOption encode is not supported. Use NumberWrite / NumberWriteFromNumber.',
        ),
    }),
    valueSchema: Schema.Number,
  }),

  /** Transform to required number (fails if null). */
  asNumber: Schema.transform(
    NumberProperty.pipe(
      Schema.filter((p): p is typeof p & { number: number } => p.number !== null, {
        message: () => 'Number is required',
      }),
    ),
    Schema.Number,
    {
      strict: false,
      decode: (prop) => prop.number,
      encode: () =>
        shouldNeverHappen(
          'Num.asNumber encode is not supported. Use NumberWrite / NumberWriteFromNumber.',
        ),
    },
  ),

  Write: {
    Schema: NumberWrite,
    fromNumber: NumberWriteFromNumber,
  },
} as const
