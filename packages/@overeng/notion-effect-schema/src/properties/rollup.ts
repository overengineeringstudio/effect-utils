import { Schema, SchemaTransformation } from 'effect'

import { docsPath, shouldNeverHappen } from '../common.ts'
import { DateValue } from './date.ts'

// -----------------------------------------------------------------------------
// Rollup Property (Read-only)
// -----------------------------------------------------------------------------

/**
 * Rollup result value.
 */
export const RollupValue = Schema.Union([
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
]).annotate({
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
  id: Schema.String.annotate({
    description: 'Property identifier.',
  }),
  type: Schema.Literal('rollup').annotate({
    description: 'Property type identifier.',
  }),
  rollup: RollupValue.annotate({
    description: 'The computed rollup result.',
  }),
}).annotate({
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
  raw: RollupProperty.pipe(
    Schema.decodeTo(
      RollupValue,
      SchemaTransformation.transform<RollupValue, RollupProperty>({
        decode: (prop) => prop.rollup,
        encode: (): RollupProperty =>
          shouldNeverHappen('Rollup.raw encode is not supported (rollup is read-only).'),
      }),
    ),
  ),

  /** Transform to required number (fails if not a number rollup). */
  asNumber: RollupProperty.pipe(
    Schema.refine(
      (p): p is typeof p & { rollup: { type: 'number'; number: number } } =>
        p.rollup.type === 'number' && p.rollup.number !== null,
      { message: 'Rollup must be a non-null number' },
    ),
  ).pipe(
    Schema.decodeTo(
      Schema.Number,
      SchemaTransformation.transform<
        number,
        RollupProperty & { rollup: { type: 'number'; number: number } }
      >({
        decode: (prop) => prop.rollup.number,
        encode: (): RollupProperty & { rollup: { type: 'number'; number: number } } =>
          shouldNeverHappen('Rollup.asNumber encode is not supported (rollup is read-only).'),
      }),
    ),
  ),

  /** Transform to required string (fails if not a string rollup). */
  asString: RollupProperty.pipe(
    Schema.refine(
      (p): p is typeof p & { rollup: { type: 'string'; string: string } } =>
        p.rollup.type === 'string' && p.rollup.string !== null,
      { message: 'Rollup must be a non-null string' },
    ),
  ).pipe(
    Schema.decodeTo(
      Schema.String,
      SchemaTransformation.transform<
        string,
        RollupProperty & { rollup: { type: 'string'; string: string } }
      >({
        decode: (prop) => prop.rollup.string,
        encode: (): RollupProperty & { rollup: { type: 'string'; string: string } } =>
          shouldNeverHappen('Rollup.asString encode is not supported (rollup is read-only).'),
      }),
    ),
  ),

  /** Transform to required boolean (fails if not a boolean rollup). */
  asBoolean: RollupProperty.pipe(
    Schema.refine(
      (p): p is typeof p & { rollup: { type: 'boolean'; boolean: boolean } } =>
        p.rollup.type === 'boolean' && p.rollup.boolean !== null,
      { message: 'Rollup must be a non-null boolean' },
    ),
  ).pipe(
    Schema.decodeTo(
      Schema.Boolean,
      SchemaTransformation.transform<
        boolean,
        RollupProperty & { rollup: { type: 'boolean'; boolean: boolean } }
      >({
        decode: (prop) => prop.rollup.boolean,
        encode: (): RollupProperty & { rollup: { type: 'boolean'; boolean: boolean } } =>
          shouldNeverHappen('Rollup.asBoolean encode is not supported (rollup is read-only).'),
      }),
    ),
  ),

  /** Transform to required date (fails if not a date rollup). */
  asDate: RollupProperty.pipe(
    Schema.refine(
      (p): p is typeof p & { rollup: { type: 'date'; date: DateValue } } =>
        p.rollup.type === 'date' && p.rollup.date !== null,
      { message: 'Rollup must be a non-null date' },
    ),
  ).pipe(
    Schema.decodeTo(
      DateValue,
      SchemaTransformation.transform<
        DateValue,
        RollupProperty & { rollup: { type: 'date'; date: DateValue } }
      >({
        decode: (prop) => prop.rollup.date,
        encode: (): RollupProperty & { rollup: { type: 'date'; date: DateValue } } =>
          shouldNeverHappen('Rollup.asDate encode is not supported (rollup is read-only).'),
      }),
    ),
  ),

  /** Transform to rollup array (fails if not an array rollup). */
  asArray: RollupProperty.pipe(
    Schema.refine(
      (
        p,
      ): p is typeof p & {
        rollup: { type: 'array'; array: Array<unknown> }
      } => p.rollup.type === 'array',
      { message: 'Rollup must be an array' },
    ),
  ).pipe(
    Schema.decodeTo(
      Schema.Array(Schema.Unknown),
      SchemaTransformation.transform<
        ReadonlyArray<unknown>,
        RollupProperty & { rollup: { type: 'array'; array: Array<unknown> } }
      >({
        decode: (prop) => prop.rollup.array,
        encode: (): RollupProperty & {
          rollup: { type: 'array'; array: Array<unknown> }
        } => shouldNeverHappen('Rollup.asArray encode is not supported (rollup is read-only).'),
      }),
    ),
  ),
} as const
