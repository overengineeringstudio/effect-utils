import { Option, Schema, SchemaAST, SchemaGetter, SchemaTransformation } from 'effect'

import {
  NOTICON_COLORS,
  NOTION_COLORS,
  NOTION_DOCS_BASE as NOTION_DOCS_BASE_CORE,
  SELECT_COLORS,
  compactNotionUuid as compactNotionUuidCore,
  formatNotionUuid as formatNotionUuidCore,
  notionObjectUrl as notionObjectUrlCore,
  parseNotionUuid as parseNotionUuidCore,
} from '@overeng/notion-core'

// -----------------------------------------------------------------------------
// Custom Annotations
// -----------------------------------------------------------------------------

/**
 * Annotation key for Notion API docs path fragment.
 * Use with `resolveDocsUrl` to get the full URL.
 *
 * @example
 * ```ts
 * Schema.Struct({ ... }).annotate({
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
export const NOTION_DOCS_BASE = NOTION_DOCS_BASE_CORE

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
export const NotionUUID = Schema.String.annotate({
  identifier: 'Notion.UUID',
  title: 'Notion UUID',
  description: 'A unique identifier in UUID format used throughout the Notion API.',
  examples: ['2afe4693-b7ce-4c6d-b98a-6a5f67f7a0b1'],
  [docsPath]: 'intro#conventions',
})

export type NotionUUID = typeof NotionUUID.Type

const compactNotionUuidPattern = /^[0-9a-f]{32}$/iu

/** Return the 32-character compact representation used in Notion URLs. */
export const compactNotionUuid = (id: string): string => compactNotionUuidCore(id)

/** Format a compact 32-character Notion ID as the canonical dashed UUID string. */
export const formatNotionUuid = (compactId: string): NotionUUID | undefined => {
  if (compactNotionUuidPattern.test(compactId) === false) return undefined

  return formatNotionUuidCore(compactId)
}

/** Parse a Notion UUID from either a dashed ID, compact ID, or Notion URL. */
export const parseNotionUuid = (value: string): NotionUUID | undefined => parseNotionUuidCore(value)

/** Build the canonical public Notion object URL for an ID-like value. */
export const notionObjectUrl = (id: string): string => notionObjectUrlCore(id)

/**
 * ISO 8601 date-time string as returned by Notion API.
 *
 * @see https://developers.notion.com/reference/intro#conventions
 */
export const ISO8601DateTime = Schema.String.annotate({
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
export const NotionColor = Schema.Literals(NOTION_COLORS).annotate({
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
export const SelectColor = Schema.Literals(SELECT_COLORS).annotate({
  identifier: 'Notion.SelectColor',
  title: 'Select Color',
  description: 'Color values used for select and multi-select options.',
  [docsPath]: 'property-value-object#select',
})

export type SelectColor = typeof SelectColor.Type

/**
 * Color values for Notion named icons (noticons).
 *
 * Different from NotionColor — no backgrounds, no 'default', but includes 'lightgray'.
 *
 * @see https://developers.notion.com/reference/icon-object
 */
export const NoticonColor = Schema.Literals(NOTICON_COLORS).annotate({
  identifier: 'Notion.NoticonColor',
  title: 'Noticon Color',
  description: 'Color values used for native Notion icons (noticons).',
  [docsPath]: 'icon-object',
})

export type NoticonColor = typeof NoticonColor.Type

/**
 * Relative date values for database query filters.
 *
 * Can be used in date filters where absolute dates are accepted,
 * e.g. `{ property: "Due Date", date: { on_or_after: "today" } }`.
 */
export const RelativeDate = Schema.Literals([
  'today',
  'tomorrow',
  'yesterday',
  'one_week_ago',
  'one_week_from_now',
  'one_month_ago',
  'one_month_from_now',
]).annotate({
  identifier: 'Notion.RelativeDate',
  title: 'Relative Date',
  description: 'Relative date values for database query filters.',
})

export type RelativeDate = typeof RelativeDate.Type

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
    // oxlint-disable-next-line no-debugger -- intentional breakpoint for impossible states during development
    debugger
  }

  throw new Error(`This should never happen: ${msg}`)
}

// ---------------------------------------------------------------------------
// Composable helpers
// ---------------------------------------------------------------------------

const getAnnotationValue = <A>({
  ast,
  key,
}: {
  ast: SchemaAST.AST
  key: symbol
}): A | undefined => {
  const annotations = SchemaAST.resolve(ast) as { [key: symbol]: unknown } | undefined
  return annotations?.[key] as A | undefined
}

const getOptionValueSchema = <TValue>(
  schema: Schema.Schema<Option.Option<TValue>>,
): Schema.Codec<TValue, TValue> => {
  const annotated = getAnnotationValue<Schema.Codec<TValue, TValue>>({
    ast: schema.ast,
    key: optionValueSchema,
  })

  if (annotated !== undefined) {
    return annotated
  }

  return shouldNeverHappen(
    'Required.some expects an Option schema created by notion-effect-schema option helpers.',
  )
}

const getOptionNameSchema = <TName extends string, TValue>(
  schema: Schema.Schema<TValue>,
): Schema.Decoder<TName> => {
  const annotated = getAnnotationValue<Schema.Decoder<TName>>({
    ast: schema.ast,
    key: optionNameSchema,
  })

  if (annotated !== undefined) {
    return annotated
  }

  return shouldNeverHappen(
    'NotionSchema.asName expects a select/status schema created by notion-effect-schema helpers.',
  )
}

/** Annotates an Option schema with its inner value schema for extraction */
export const withOptionValueSchema = <TValue>(options: {
  schema: Schema.Decoder<Option.Option<TValue>>
  valueSchema: Schema.Decoder<TValue>
}) => options.schema.annotate({ [optionValueSchema]: options.valueSchema })

/** Annotates a schema with the name schema for select/status option extraction */
export const withOptionNameSchema = <TValue, TName extends string>(options: {
  schema: Schema.Decoder<TValue>
  nameSchema: Schema.Decoder<TName>
}) => options.schema.annotate({ [optionNameSchema]: options.nameSchema })

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
export const asName = <TName extends string, TOption extends { name: TName }>(
  schema: Schema.Decoder<Option.Option<TOption>>,
) => {
  const nameSchema = getOptionNameSchema<TName, Option.Option<TOption>>(schema)

  return withOptionValueSchema({
    schema: schema.pipe(
      Schema.decodeTo(Schema.Option(nameSchema), {
        decode: SchemaGetter.transform((opt: Option.Option<TOption>) =>
          Option.map(opt, (value) => value.name),
        ),
        encode: SchemaGetter.forbidden(
          () => 'NotionSchema.asName encode is not supported. Use the write helpers for updates.',
        ),
      }),
    ),
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
export const asNames = <TName extends string, TOption extends { name: TName }>(
  schema: Schema.Decoder<ReadonlyArray<TOption>>,
) => {
  const nameSchema = getOptionNameSchema<TName, ReadonlyArray<TOption>>(schema)

  return schema.pipe(
    Schema.decodeTo(Schema.Array(nameSchema), {
      decode: SchemaGetter.transform((options: ReadonlyArray<TOption>) =>
        options.map((option) => option.name),
      ),
      encode: SchemaGetter.forbidden(
        () => 'NotionSchema.asNames encode is not supported. Use the write helpers for updates.',
      ),
    }),
  )
}

/**
 * Convert Option values to nullable values.
 *
 * Expects a schema created by notion-effect-schema Option helpers.
 */
export const asNullable = <TValue>(schema: Schema.Decoder<Option.Option<TValue>>) => {
  const valueSchema = getOptionValueSchema(schema)

  return schema.pipe(
    Schema.decodeTo(Schema.NullOr(valueSchema), {
      decode: SchemaGetter.transform((opt: Option.Option<TValue>) => Option.getOrNull(opt)),
      encode: SchemaGetter.transform((value: TValue | null) =>
        value === null ? Option.none() : Option.some(value),
      ),
    }),
  )
}

/** Helpers for making Option/nullable values required */
export const Required = {
  some:
    (message = 'Value is required') =>
    <TValue>(schema: Schema.Decoder<Option.Option<TValue>>) => {
      const valueSchema = getOptionValueSchema(schema)
      return schema.pipe(
        Schema.check(
          Schema.makeFilter((opt: Option.Option<TValue>) => Option.isSome(opt), {
            message,
          }),
        ),
        Schema.decodeTo(valueSchema, {
          decode: SchemaGetter.transform((opt: Option.Option<TValue>) => Option.getOrThrow(opt)),
          encode: SchemaGetter.transform((value: TValue) => Option.some(value)),
        }),
      )
    },
  nullable:
    <TValue>(options: { valueSchema: Schema.Codec<TValue>; message?: string }) =>
    (schema: Schema.Decoder<TValue | null>) => {
      const message = options.message ?? 'Value is required'
      return schema.pipe(
        Schema.check(
          Schema.makeFilter((value: TValue | null) => value !== null, {
            message,
          }),
        ),
        Schema.decodeTo(
          options.valueSchema,
          SchemaTransformation.transform<TValue, TValue | null>({
            decode: (value) => {
              if (value === null) {
                return shouldNeverHappen('Required.nullable decoded null after filtering')
              }
              return value
            },
            encode: (value) => value,
          }),
        ),
      )
    },
} as const
