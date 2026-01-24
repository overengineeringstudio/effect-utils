import { Schema } from 'effect'

import { docsPath, shouldNeverHappen } from '../common.ts'
import { DateValue } from './date.ts'

// -----------------------------------------------------------------------------
// Rollup Property (Read-only)
// -----------------------------------------------------------------------------

/**
 * Rollup result value.
 */
export const RollupValue = Schema.Union(
  Schema.Struct({
    type: Schema.Literal('string'),
    string: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal('number'),
    number: Schema.NullOr(Schema.Number),
  }),
  Schema.Struct({
    type: Schema.Literal('boolean'),
    boolean: Schema.NullOr(Schema.Boolean),
  }),
  Schema.Struct({
    type: Schema.Literal('date'),
    date: Schema.NullOr(DateValue),
  }),
  Schema.Struct({
    type: Schema.Literal('array'),
    array: Schema.Array(Schema.Unknown),
  }),
  Schema.Struct({
    type: Schema.Literal('unsupported'),
    unsupported: Schema.NullOr(Schema.Unknown),
  }),
).annotations({
  identifier: 'Notion.RollupValue',
  title: 'Rollup Value',
  description: 'The computed result of a rollup.',
  [docsPath]: 'property-value-object#rollup',
})

export type RollupValue = typeof RollupValue.Type

/**
 * Rollup property value from the Notion API (read-only).
 *
 * @see https://developers.notion.com/reference/property-value-object#rollup
 */
export const RollupProperty = Schema.Struct({
  id: Schema.String.annotations({
    description: 'Property identifier.',
  }),
  type: Schema.Literal('rollup').annotations({
    description: 'Property type identifier.',
  }),
  rollup: RollupValue.annotations({
    description: 'The computed rollup result.',
  }),
}).annotations({
  identifier: 'Notion.RollupProperty',
  title: 'Rollup Property',
  description: 'A rollup property value (read-only, computed).',
  [docsPath]: 'property-value-object#rollup',
})

export type RollupProperty = typeof RollupProperty.Type

/** Transforms for Rollup property. */
export const Rollup = {
  /** The raw RollupProperty schema. */
  Property: RollupProperty,

  /** Transform to raw RollupValue. */
  raw: Schema.transform(RollupProperty, RollupValue, {
    strict: false,
    decode: (prop) => prop.rollup,
    encode: () => shouldNeverHappen('Rollup.raw encode is not supported (rollup is read-only).'),
  }),

  /** Transform to required number (fails if not a number rollup). */
  asNumber: Schema.transform(
    RollupProperty.pipe(
      Schema.filter(
        (p): p is typeof p & { rollup: { type: 'number'; number: number } } =>
          p.rollup.type === 'number' && p.rollup.number !== null,
        { message: () => 'Rollup must be a non-null number' },
      ),
    ),
    Schema.Number,
    {
      strict: false,
      decode: (prop) => prop.rollup.number,
      encode: () =>
        shouldNeverHappen('Rollup.asNumber encode is not supported (rollup is read-only).'),
    },
  ),

  /** Transform to required string (fails if not a string rollup). */
  asString: Schema.transform(
    RollupProperty.pipe(
      Schema.filter(
        (p): p is typeof p & { rollup: { type: 'string'; string: string } } =>
          p.rollup.type === 'string' && p.rollup.string !== null,
        { message: () => 'Rollup must be a non-null string' },
      ),
    ),
    Schema.String,
    {
      strict: false,
      decode: (prop) => prop.rollup.string,
      encode: () =>
        shouldNeverHappen('Rollup.asString encode is not supported (rollup is read-only).'),
    },
  ),

  /** Transform to required boolean (fails if not a boolean rollup). */
  asBoolean: Schema.transform(
    RollupProperty.pipe(
      Schema.filter(
        (p): p is typeof p & { rollup: { type: 'boolean'; boolean: boolean } } =>
          p.rollup.type === 'boolean' && p.rollup.boolean !== null,
        { message: () => 'Rollup must be a non-null boolean' },
      ),
    ),
    Schema.Boolean,
    {
      strict: false,
      decode: (prop) => prop.rollup.boolean,
      encode: () =>
        shouldNeverHappen('Rollup.asBoolean encode is not supported (rollup is read-only).'),
    },
  ),

  /** Transform to required date (fails if not a date rollup). */
  asDate: Schema.transform(
    RollupProperty.pipe(
      Schema.filter(
        (p): p is typeof p & { rollup: { type: 'date'; date: DateValue } } =>
          p.rollup.type === 'date' && p.rollup.date !== null,
        { message: () => 'Rollup must be a non-null date' },
      ),
    ),
    DateValue,
    {
      strict: false,
      decode: (prop) => prop.rollup.date,
      encode: () =>
        shouldNeverHappen('Rollup.asDate encode is not supported (rollup is read-only).'),
    },
  ),

  /** Transform to rollup array (fails if not an array rollup). */
  asArray: Schema.transform(
    RollupProperty.pipe(
      Schema.filter(
        (
          p,
        ): p is typeof p & {
          rollup: { type: 'array'; array: Array<unknown> }
        } => p.rollup.type === 'array',
        { message: () => 'Rollup must be an array' },
      ),
    ),
    Schema.Array(Schema.Unknown),
    {
      strict: false,
      decode: (prop) => prop.rollup.array,
      encode: () =>
        shouldNeverHappen('Rollup.asArray encode is not supported (rollup is read-only).'),
    },
  ),
} as const
