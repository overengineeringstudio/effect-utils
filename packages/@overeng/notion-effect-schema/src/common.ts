import { Option, Schema } from 'effect'
import * as SchemaAST from 'effect/SchemaAST'

// -----------------------------------------------------------------------------
// Custom Annotations
// -----------------------------------------------------------------------------

/**
 * Annotation key for Notion API docs path fragment.
 * Use with `resolveDocsUrl` to get the full URL.
 *
 * @example
 * ```ts
 * Schema.Struct({ ... }).annotations({
 *   [docsPath]: 'property-value-object#title',
 * })
 * ```
 */
export const docsPath: unique symbol = Symbol.for('@overeng/notion-effect-schema/docsPath')

/** Annotation key for Option value schema (Notion option helpers only). */
export const optionValueSchema: unique symbol = Symbol.for(
  '@overeng/notion-effect-schema/optionValueSchema',
)

/** Annotation key for select/status option name schema. */
export const optionNameSchema: unique symbol = Symbol.for(
  '@overeng/notion-effect-schema/optionNameSchema',
)

/** Base URL for Notion API documentation */
export const NOTION_DOCS_BASE = 'https://developers.notion.com/reference'

/** Resolve full docs URL from path fragment */
export const resolveDocsUrl = (path: string): string => `${NOTION_DOCS_BASE}/${path}`

// -----------------------------------------------------------------------------
// Primitive Schemas
// -----------------------------------------------------------------------------

/**
 * Notion UUID identifier.
 *
 * @see https://developers.notion.com/reference/intro#conventions
 */
export const NotionUUID = Schema.String.annotations({
  identifier: 'Notion.UUID',
  title: 'Notion UUID',
  description: 'A unique identifier in UUID format used throughout the Notion API.',
  examples: ['2afe4693-b7ce-4c6d-b98a-6a5f67f7a0b1'],
  [docsPath]: 'intro#conventions',
})

export type NotionUUID = typeof NotionUUID.Type

/**
 * ISO 8601 date-time string as returned by Notion API.
 *
 * @see https://developers.notion.com/reference/intro#conventions
 */
export const ISO8601DateTime = Schema.String.annotations({
  identifier: 'Notion.ISO8601DateTime',
  title: 'ISO 8601 DateTime',
  description: 'A timestamp in ISO 8601 format.',
  examples: ['2024-01-15T10:30:00.000Z'],
  [docsPath]: 'intro#conventions',
})

export type ISO8601DateTime = typeof ISO8601DateTime.Type

/**
 * Notion color values used in annotations, select options, etc.
 *
 * @see https://developers.notion.com/reference/rich-text#the-annotation-object
 */
export const NotionColor = Schema.Literal(
  'default',
  'gray',
  'brown',
  'orange',
  'yellow',
  'green',
  'blue',
  'purple',
  'pink',
  'red',
  'gray_background',
  'brown_background',
  'orange_background',
  'yellow_background',
  'green_background',
  'blue_background',
  'purple_background',
  'pink_background',
  'red_background',
).annotations({
  identifier: 'Notion.Color',
  title: 'Notion Color',
  description: 'Color values used for text annotations and backgrounds.',
  [docsPath]: 'rich-text#the-annotation-object',
})

export type NotionColor = typeof NotionColor.Type

/**
 * Select option color values (subset of NotionColor, no backgrounds).
 *
 * @see https://developers.notion.com/reference/property-value-object#select
 */
export const SelectColor = Schema.Literal(
  'default',
  'gray',
  'brown',
  'orange',
  'yellow',
  'green',
  'blue',
  'purple',
  'pink',
  'red',
).annotations({
  identifier: 'Notion.SelectColor',
  title: 'Select Color',
  description: 'Color values used for select and multi-select options.',
  [docsPath]: 'property-value-object#select',
})

export type SelectColor = typeof SelectColor.Type

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

/** Checks if running in a development environment (NODE_ENV !== 'production') */
export const isDevEnv = (): boolean => {
  if (typeof process === 'undefined') {
    return false
  }

  if (typeof process.env === 'undefined') {
    return false
  }

  return process.env.NODE_ENV !== 'production'
}

/** Throws an error for impossible states, triggering debugger in development */
export const shouldNeverHappen = (msg?: string, ...args: unknown[]): never => {
  console.error(msg, ...args)
  if (isDevEnv() === true) {
    // oxlint-disable-next-line eslint(no-debugger) -- intentional breakpoint for impossible states during development
    debugger
  }

  throw new Error(`This should never happen: ${msg}`)
}

// ---------------------------------------------------------------------------
// Composable helpers
// ---------------------------------------------------------------------------

const getOptionValueSchema = <TValue, TInput, TContext>(
  schema: Schema.Schema<Option.Option<TValue>, TInput, TContext>,
): Schema.Schema<TValue, TValue, never> => {
  const annotated = SchemaAST.getAnnotation<Schema.Schema<TValue, TValue, never>>(
    schema.ast,
    optionValueSchema,
  )

  if (Option.isSome(annotated) === true) {
    return annotated.value
  }

  return shouldNeverHappen(
    'Required.some expects an Option schema created by notion-effect-schema option helpers.',
  )
}

const getOptionNameSchema = <TName extends string, TValue, TInput, TContext>(
  schema: Schema.Schema<TValue, TInput, TContext>,
): Schema.Schema<TName, TName, never> => {
  const annotated = SchemaAST.getAnnotation<Schema.Schema<TName, TName, never>>(
    schema.ast,
    optionNameSchema,
  )

  if (Option.isSome(annotated) === true) {
    return annotated.value
  }

  return shouldNeverHappen(
    'NotionSchema.asName expects a select/status schema created by notion-effect-schema helpers.',
  )
}

/** Annotates an Option schema with its inner value schema for extraction */
export const withOptionValueSchema = <TValue, TInput, TContext>(options: {
  schema: Schema.Schema<Option.Option<TValue>, TInput, TContext>
  valueSchema: Schema.Schema<TValue, TValue, never>
}): Schema.Schema<Option.Option<TValue>, TInput, TContext> =>
  options.schema.annotations({ [optionValueSchema]: options.valueSchema })

/** Annotates a schema with the name schema for select/status option extraction */
export const withOptionNameSchema = <TValue, TInput, TContext, TName extends string>(options: {
  schema: Schema.Schema<TValue, TInput, TContext>
  nameSchema: Schema.Schema<TName, TName, never>
}): Schema.Schema<TValue, TInput, TContext> =>
  options.schema.annotations({ [optionNameSchema]: options.nameSchema })

/**
 * Convert select/status `Option<SelectOption>` values to `Option<name>`.
 *
 * Use after `NotionSchema.select()` or `NotionSchema.status()`:
 *
 * ```ts
 * NotionSchema.select(Allowed).pipe(NotionSchema.asName)
 * ```
 *
 * Typed options are enforced via the upstream schema. Decode-only; use write helpers for updates.
 */
export const asName = <TName extends string, TOption extends { name: TName }, TInput, TContext>(
  schema: Schema.Schema<Option.Option<TOption>, TInput, TContext>,
): Schema.Schema<Option.Option<TName>, TInput, TContext> => {
  const nameSchema = getOptionNameSchema<TName, Option.Option<TOption>, TInput, TContext>(schema)

  return withOptionValueSchema({
    schema: Schema.transform(schema, Schema.OptionFromSelf(nameSchema), {
      strict: false,
      decode: (opt) => Option.map(opt, (value) => value.name),
      encode: () =>
        shouldNeverHappen(
          'NotionSchema.asName encode is not supported. Use the write helpers for updates.',
        ),
    }),
    valueSchema: nameSchema,
  })
}

/**
 * Convert multi-select arrays of options to arrays of `name`.
 *
 * Use after `NotionSchema.multiSelect()`:
 *
 * ```ts
 * NotionSchema.multiSelect(Allowed).pipe(NotionSchema.asNames)
 * ```
 *
 * Typed options are enforced via the upstream schema. Decode-only; use write helpers for updates.
 */
export const asNames = <TName extends string, TOption extends { name: TName }, TInput, TContext>(
  schema: Schema.Schema<ReadonlyArray<TOption>, TInput, TContext>,
): Schema.Schema<ReadonlyArray<TName>, TInput, TContext> => {
  const nameSchema = getOptionNameSchema<TName, ReadonlyArray<TOption>, TInput, TContext>(schema)

  return Schema.transform(schema, Schema.Array(nameSchema), {
    strict: false,
    decode: (options) => options.map((option) => option.name),
    encode: () =>
      shouldNeverHappen(
        'NotionSchema.asNames encode is not supported. Use the write helpers for updates.',
      ),
  })
}

/**
 * Convert Option values to nullable values.
 *
 * Expects a schema created by notion-effect-schema Option helpers.
 */
export const asNullable = <TValue, TInput, TContext>(
  schema: Schema.Schema<Option.Option<TValue>, TInput, TContext>,
): Schema.Schema<TValue | null, TInput, TContext> => {
  const valueSchema = getOptionValueSchema(schema)

  return Schema.transform(schema, Schema.NullOr(valueSchema), {
    strict: false,
    decode: (opt) => Option.getOrNull(opt),
    encode: (value) => (value === null ? Option.none() : Option.some(value)),
  })
}

/** Helpers for making Option/nullable values required */
export const Required = {
  some:
    (message = 'Value is required') =>
    <TValue, TInput, TOutputContext>(
      schema: Schema.Schema<Option.Option<TValue>, TInput, TOutputContext>,
    ): Schema.Schema<TValue, TInput, TOutputContext> => {
      const valueSchema = getOptionValueSchema(schema)
      return Schema.transform(
        schema.pipe(
          Schema.filter((opt): opt is Option.Some<TValue> => Option.isSome(opt), {
            message: () => message,
          }),
        ),
        valueSchema,
        {
          strict: false,
          decode: (opt) => Option.getOrThrow(opt),
          encode: (value) => Option.some(value),
        },
      )
    },
  nullable:
    <TValue, TContext>(options: {
      valueSchema: Schema.Schema<TValue, TValue, TContext>
      message?: string
    }) =>
    <TInput, TOutputContext>(
      schema: Schema.Schema<TValue | null, TInput, TOutputContext>,
    ): Schema.Schema<TValue, TInput, TContext | TOutputContext> => {
      const message = options.message ?? 'Value is required'
      return Schema.transform(
        schema.pipe(
          Schema.filter((value): value is TValue => value !== null, {
            message: () => message,
          }),
        ),
        options.valueSchema,
        {
          strict: false,
          decode: (value) => value,
          encode: (value) => value,
        },
      )
    },
} as const
