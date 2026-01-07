import { Schema } from 'effect'

import { docsPath, shouldNeverHappen } from '../common.ts'
import { DateValue } from './date.ts'

// -----------------------------------------------------------------------------
// Formula Property (Read-only)
// -----------------------------------------------------------------------------

/**
 * Formula result value.
 */
export const FormulaValue = Schema.Union(
  Schema.Struct({ type: Schema.Literal('string'), string: Schema.NullOr(Schema.String) }),
  Schema.Struct({ type: Schema.Literal('number'), number: Schema.NullOr(Schema.Number) }),
  Schema.Struct({ type: Schema.Literal('boolean'), boolean: Schema.NullOr(Schema.Boolean) }),
  Schema.Struct({ type: Schema.Literal('date'), date: Schema.NullOr(DateValue) }),
).annotations({
  identifier: 'Notion.FormulaValue',
  title: 'Formula Value',
  description: 'The computed result of a formula.',
  [docsPath]: 'property-value-object#formula',
})

export type FormulaValue = typeof FormulaValue.Type

/**
 * Formula property value from the Notion API (read-only).
 *
 * @see https://developers.notion.com/reference/property-value-object#formula
 */
export const FormulaProperty = Schema.Struct({
  id: Schema.String.annotations({
    description: 'Property identifier.',
  }),
  type: Schema.Literal('formula').annotations({
    description: 'Property type identifier.',
  }),
  formula: FormulaValue.annotations({
    description: 'The computed formula result.',
  }),
}).annotations({
  identifier: 'Notion.FormulaProperty',
  title: 'Formula Property',
  description: 'A formula property value (read-only, computed).',
  [docsPath]: 'property-value-object#formula',
})

export type FormulaProperty = typeof FormulaProperty.Type

/** Transforms for Formula property. */
export const Formula = {
  /** The raw FormulaProperty schema. */
  Property: FormulaProperty,

  /** Transform to raw FormulaValue. */
  raw: Schema.transform(FormulaProperty, FormulaValue, {
    strict: false,
    decode: (prop) => prop.formula,
    encode: () => shouldNeverHappen('Formula.raw encode is not supported (formula is read-only).'),
  }),

  /** Transform to required number (fails if not a number formula). */
  asNumber: Schema.transform(
    FormulaProperty.pipe(
      Schema.filter(
        (p): p is typeof p & { formula: { type: 'number'; number: number } } =>
          p.formula.type === 'number' && p.formula.number !== null,
        { message: () => 'Formula must be a non-null number' },
      ),
    ),
    Schema.Number,
    {
      strict: false,
      decode: (prop) => prop.formula.number,
      encode: () =>
        shouldNeverHappen('Formula.asNumber encode is not supported (formula is read-only).'),
    },
  ),

  /** Transform to required string (fails if not a string formula). */
  asString: Schema.transform(
    FormulaProperty.pipe(
      Schema.filter(
        (p): p is typeof p & { formula: { type: 'string'; string: string } } =>
          p.formula.type === 'string' && p.formula.string !== null,
        { message: () => 'Formula must be a non-null string' },
      ),
    ),
    Schema.String,
    {
      strict: false,
      decode: (prop) => prop.formula.string,
      encode: () =>
        shouldNeverHappen('Formula.asString encode is not supported (formula is read-only).'),
    },
  ),

  /** Transform to required boolean (fails if not a boolean formula). */
  asBoolean: Schema.transform(
    FormulaProperty.pipe(
      Schema.filter(
        (p): p is typeof p & { formula: { type: 'boolean'; boolean: boolean } } =>
          p.formula.type === 'boolean' && p.formula.boolean !== null,
        { message: () => 'Formula must be a non-null boolean' },
      ),
    ),
    Schema.Boolean,
    {
      strict: false,
      decode: (prop) => prop.formula.boolean,
      encode: () =>
        shouldNeverHappen('Formula.asBoolean encode is not supported (formula is read-only).'),
    },
  ),

  /** Transform to required date (fails if not a date formula). */
  asDate: Schema.transform(
    FormulaProperty.pipe(
      Schema.filter(
        (p): p is typeof p & { formula: { type: 'date'; date: DateValue } } =>
          p.formula.type === 'date' && p.formula.date !== null,
        { message: () => 'Formula must be a non-null date' },
      ),
    ),
    DateValue,
    {
      strict: false,
      decode: (prop) => prop.formula.date,
      encode: () =>
        shouldNeverHappen('Formula.asDate encode is not supported (formula is read-only).'),
    },
  ),
} as const

// -----------------------------------------------------------------------------
// Unique ID Property (Read-only)
// -----------------------------------------------------------------------------

/**
 * Unique ID property value from the Notion API (read-only).
 *
 * @see https://developers.notion.com/reference/property-value-object#unique-id
 */
export const UniqueIdProperty = Schema.Struct({
  id: Schema.String.annotations({
    description: 'Property identifier.',
  }),
  type: Schema.Literal('unique_id').annotations({
    description: 'Property type identifier.',
  }),
  unique_id: Schema.Struct({
    prefix: Schema.NullOr(Schema.String).annotations({
      description: 'Optional text prefix for the ID.',
      examples: ['TASK', 'BUG'],
    }),
    number: Schema.Number.annotations({
      description: 'Auto-incrementing number.',
      examples: [1, 42, 100],
    }),
  }).annotations({
    description: 'The unique ID value.',
  }),
}).annotations({
  identifier: 'Notion.UniqueIdProperty',
  title: 'Unique ID Property',
  description: 'An auto-incrementing unique ID (read-only).',
  [docsPath]: 'property-value-object#unique-id',
})

export type UniqueIdProperty = typeof UniqueIdProperty.Type

/** Transforms for UniqueId property. */
export const UniqueId = {
  /** The raw UniqueIdProperty schema. */
  Property: UniqueIdProperty,

  /** Transform to formatted string (e.g., "TASK-42"). */
  asString: Schema.transform(UniqueIdProperty, Schema.String, {
    strict: false,
    decode: (prop) => {
      const { prefix, number } = prop.unique_id
      return prefix ? `${prefix}-${number}` : String(number)
    },
    encode: () =>
      shouldNeverHappen('UniqueId.asString encode is not supported (unique_id is read-only).'),
  }),

  /** Transform to just the number. */
  asNumber: Schema.transform(UniqueIdProperty, Schema.Number, {
    strict: false,
    decode: (prop) => prop.unique_id.number,
    encode: () =>
      shouldNeverHappen('UniqueId.asNumber encode is not supported (unique_id is read-only).'),
  }),
} as const
