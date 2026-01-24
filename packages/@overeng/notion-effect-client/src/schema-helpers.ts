import { Array as Arr, Effect, Option, Order, Schema } from 'effect'
import * as SchemaAST from 'effect/SchemaAST'

import type {
  DatabaseSchema,
  NumberFormat,
  NotionPropertyMeta,
  PropertySchema,
  RollupFunction,
  SelectOptionConfig,
} from '@overeng/notion-effect-schema'
import {
  notionPropertyMeta,
  PropertySchema as PropertySchemaCodec,
} from '@overeng/notion-effect-schema'

/** Error thrown when database schema doesn't match expected property types */
export class SchemaMismatchError extends Schema.TaggedError<SchemaMismatchError>()(
  'SchemaMismatchError',
  {
    databaseId: Schema.String,
    databaseName: Schema.optional(Schema.String),
    message: Schema.String,
    missing: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        expectedTag: Schema.String,
      }),
    ),
  },
) {}

/** Error thrown when schema fields lack required Notion property metadata annotations */
export class SchemaMetaMissingError extends Schema.TaggedError<SchemaMetaMissingError>()(
  'SchemaMetaMissingError',
  {
    message: Schema.String,
    missing: Schema.Array(Schema.String),
  },
) {}

// -----------------------------------------------------------------------------
// Property Parsing
// -----------------------------------------------------------------------------

const isRecord = (u: unknown): u is Record<string, unknown> =>
  typeof u === 'object' && u !== null && !Array.isArray(u)

const normalizeDatabasePropertyDefinition = (args: {
  name: string
  raw: unknown
}): Option.Option<Record<string, unknown>> => {
  if (!isRecord(args.raw)) {
    return Option.none()
  }

  const typeValue = args.raw.type
  if (typeof typeValue !== 'string') {
    return Option.none()
  }

  return Option.some({
    ...args.raw,
    name: args.name,
    _tag: typeValue,
  })
}

/**
 * Parse raw database properties into typed PropertySchema array.
 * Unknown or invalid properties are filtered out.
 */
export const getProperties = (args: { schema: DatabaseSchema }): PropertySchema[] => {
  const { schema } = args
  const rawProperties = schema.properties ?? {}
  const results: PropertySchema[] = []

  for (const [name, rawValue] of Object.entries(rawProperties)) {
    const normalized = normalizeDatabasePropertyDefinition({
      name,
      raw: rawValue,
    })
    if (Option.isNone(normalized)) {
      continue
    }

    const decoded = Schema.decodeUnknownOption(PropertySchemaCodec)(normalized.value)
    if (Option.isNone(decoded)) {
      continue
    }

    results.push(decoded.value)
  }

  return Arr.sort(
    results,
    Order.mapInput(Order.string, (p: PropertySchema) => p.name),
  )
}

/**
 * Get a single property by name.
 */
export const getProperty = (args: {
  schema: DatabaseSchema
  name: string
}): Option.Option<PropertySchema> => {
  const properties = getProperties({ schema: args.schema })
  return Arr.findFirst(properties, (p) => p.name === args.name)
}

/**
 * Get a property by name, filtered by type tag.
 */
export const getPropertyByTag = <TTag extends PropertySchema['_tag']>(args: {
  schema: DatabaseSchema
  name: string
  tag: TTag
}): Option.Option<Extract<PropertySchema, { _tag: TTag }>> => {
  const prop = getProperty({ schema: args.schema, name: args.name })

  const hasTag = (p: PropertySchema): p is Extract<PropertySchema, { _tag: TTag }> =>
    p._tag === args.tag

  return Option.flatMap(prop, (p) => (hasTag(p) ? Option.some(p) : Option.none()))
}

const getDatabaseName = (schema: DatabaseSchema): string | undefined => {
  const name = schema.title.map((t) => t.plain_text).join('')
  return name === '' ? undefined : name
}

/** Validates that database schema contains all required properties with correct types */
export const validateProperties = Effect.fnUntraced(function* (args: {
  schema: DatabaseSchema
  databaseId: string
  required: readonly { name: string; tag: PropertySchema['_tag'] }[]
}) {
  const missing = args.required.filter((prop) =>
    Option.isNone(getPropertyByTag({ schema: args.schema, name: prop.name, tag: prop.tag })),
  )

  if (missing.length === 0) {
    return
  }

  const message = `Missing or mismatched properties in Notion schema: ${missing
    .map((prop) => `${prop.name} (${prop.tag})`)
    .join(', ')}`

  return yield* new SchemaMismatchError({
    databaseId: args.databaseId,
    databaseName: getDatabaseName(args.schema),
    message,
    missing: missing.map((prop) => ({
      name: prop.name,
      expectedTag: prop.tag,
    })),
  })
})

/** Extracts required property metadata from a Schema.Struct by reading Notion property annotations */
export const getRequiredPropertiesFromSchema = Effect.fn(
  'SchemaHelpers.getRequiredPropertiesFromSchema',
)(function* (schema: Schema.Schema.AnyNoContext) {
  const ast = schema.ast
  if (ast._tag !== 'TypeLiteral') {
    return yield* new SchemaMetaMissingError({
      message: 'Schema must be a Struct to extract Notion property metadata',
      missing: [],
    })
  }

  const required: Array<{ name: string; tag: PropertySchema['_tag'] }> = []
  const missing: string[] = []

  for (const prop of ast.propertySignatures) {
    if (typeof prop.name !== 'string') {
      continue
    }

    const annotation = SchemaAST.getAnnotation<NotionPropertyMeta>(prop.type, notionPropertyMeta)
    if (Option.isSome(annotation)) {
      required.push({ name: prop.name, tag: annotation.value._tag })
    } else {
      missing.push(prop.name)
    }
  }

  if (missing.length > 0) {
    return yield* new SchemaMetaMissingError({
      message: `Schema is missing Notion property metadata for: ${missing.join(', ')}`,
      missing,
    })
  }

  return required
})

/** Validates database properties using metadata extracted from a Schema.Struct */
export const validatePropertiesFromSchema = Effect.fn('SchemaHelpers.validatePropertiesFromSchema')(
  function* (args: {
    schema: Schema.Schema.AnyNoContext
    databaseId: string
    databaseSchema: DatabaseSchema
  }) {
    const required = yield* getRequiredPropertiesFromSchema(args.schema)
    return yield* validateProperties({
      schema: args.databaseSchema,
      databaseId: args.databaseId,
      required,
    })
  },
)

// -----------------------------------------------------------------------------
// Select/Multi-Select/Status Helpers
// -----------------------------------------------------------------------------

/**
 * Get select options for a select property.
 */
export const getSelectOptions = (args: {
  schema: DatabaseSchema
  property: string
}): Option.Option<readonly SelectOptionConfig[]> => {
  const prop = getPropertyByTag({
    schema: args.schema,
    name: args.property,
    tag: 'select',
  })
  return Option.map(prop, (p) => p.select.options)
}

/**
 * Get multi-select options for a multi_select property.
 */
export const getMultiSelectOptions = (args: {
  schema: DatabaseSchema
  property: string
}): Option.Option<readonly SelectOptionConfig[]> => {
  const prop = getPropertyByTag({
    schema: args.schema,
    name: args.property,
    tag: 'multi_select',
  })
  return Option.map(prop, (p) => p.multi_select.options)
}

/**
 * Get status options for a status property.
 */
export const getStatusOptions = (args: {
  schema: DatabaseSchema
  property: string
}): Option.Option<readonly SelectOptionConfig[]> => {
  const prop = getPropertyByTag({
    schema: args.schema,
    name: args.property,
    tag: 'status',
  })
  return Option.map(prop, (p) => p.status.options)
}

/**
 * Get options for any select-like property (select, multi_select, or status).
 */
export const getAnySelectOptions = (args: {
  schema: DatabaseSchema
  property: string
}): Option.Option<readonly SelectOptionConfig[]> => {
  const prop = getProperty({ schema: args.schema, name: args.property })
  return Option.flatMap(prop, (p) => {
    switch (p._tag) {
      case 'select':
        return Option.some(p.select.options)
      case 'multi_select':
        return Option.some(p.multi_select.options)
      case 'status':
        return Option.some(p.status.options)
      default:
        return Option.none()
    }
  })
}

// -----------------------------------------------------------------------------
// Relation Helpers
// -----------------------------------------------------------------------------

/** Relation target information */
export interface RelationTarget {
  readonly databaseId: string
  readonly type: 'single_property' | 'dual_property'
  readonly syncedProperty: Option.Option<{
    readonly id: string
    readonly name: string
  }>
}

/**
 * Get the target database for a relation property.
 */
export const getRelationTarget = (args: {
  schema: DatabaseSchema
  property: string
}): Option.Option<RelationTarget> => {
  const prop = getPropertyByTag({
    schema: args.schema,
    name: args.property,
    tag: 'relation',
  })
  return Option.map(prop, (p) => ({
    databaseId: p.relation.database_id,
    type: p.relation.type,
    syncedProperty:
      p.relation.dual_property !== undefined
        ? Option.some({
            id: p.relation.dual_property.synced_property_id,
            name: p.relation.dual_property.synced_property_name,
          })
        : Option.none(),
  }))
}

/** Gets relation target or fails with SchemaMismatchError if property is missing */
export const getRelationTargetOrFail = Effect.fnUntraced(function* (args: {
  schema: DatabaseSchema
  databaseId: string
  property: string
}) {
  const target = getRelationTarget({
    schema: args.schema,
    property: args.property,
  })
  if (Option.isSome(target)) {
    return target.value
  }

  return yield* new SchemaMismatchError({
    databaseId: args.databaseId,
    databaseName: getDatabaseName(args.schema),
    message: `Missing ${args.property} relation target in Notion schema`,
    missing: [{ name: args.property, expectedTag: 'relation' }],
  })
})

// -----------------------------------------------------------------------------
// Formula Helpers
// -----------------------------------------------------------------------------

/**
 * Get the formula expression for a formula property.
 */
export const getFormulaExpression = (args: {
  schema: DatabaseSchema
  property: string
}): Option.Option<string> => {
  const prop = getPropertyByTag({
    schema: args.schema,
    name: args.property,
    tag: 'formula',
  })
  return Option.map(prop, (p) => p.formula.expression)
}

// -----------------------------------------------------------------------------
// Number Helpers
// -----------------------------------------------------------------------------

/**
 * Get the number format for a number property.
 */
export const getNumberFormat = (args: {
  schema: DatabaseSchema
  property: string
}): Option.Option<NumberFormat> => {
  const prop = getPropertyByTag({
    schema: args.schema,
    name: args.property,
    tag: 'number',
  })
  return Option.map(prop, (p) => p.number.format)
}

// -----------------------------------------------------------------------------
// Rollup Helpers
// -----------------------------------------------------------------------------

/** Rollup configuration */
export interface RollupConfig {
  readonly relationPropertyName: string
  readonly relationPropertyId: string
  readonly rollupPropertyName: string
  readonly rollupPropertyId: string
  readonly function: RollupFunction
}

/**
 * Get the rollup configuration for a rollup property.
 */
export const getRollupConfig = (args: {
  schema: DatabaseSchema
  property: string
}): Option.Option<RollupConfig> => {
  const prop = getPropertyByTag({
    schema: args.schema,
    name: args.property,
    tag: 'rollup',
  })
  return Option.map(prop, (p) => ({
    relationPropertyName: p.rollup.relation_property_name,
    relationPropertyId: p.rollup.relation_property_id,
    rollupPropertyName: p.rollup.rollup_property_name,
    rollupPropertyId: p.rollup.rollup_property_id,
    function: p.rollup.function,
  }))
}

// -----------------------------------------------------------------------------
// Unique ID Helpers
// -----------------------------------------------------------------------------

/**
 * Get the unique ID prefix for a unique_id property.
 */
export const getUniqueIdPrefix = (args: {
  schema: DatabaseSchema
  property: string
}): Option.Option<string | null> => {
  const prop = getPropertyByTag({
    schema: args.schema,
    name: args.property,
    tag: 'unique_id',
  })
  return Option.map(prop, (p) => p.unique_id.prefix)
}

// -----------------------------------------------------------------------------
// Namespace Export
// -----------------------------------------------------------------------------

/** Helpers for working with database schema metadata */
export const SchemaHelpers = {
  getProperties,
  getProperty,
  getPropertyByTag,
  validateProperties,
  getRequiredPropertiesFromSchema,
  validatePropertiesFromSchema,
  getSelectOptions,
  getMultiSelectOptions,
  getStatusOptions,
  getAnySelectOptions,
  getRelationTarget,
  getRelationTargetOrFail,
  getFormulaExpression,
  getNumberFormat,
  getRollupConfig,
  getUniqueIdPrefix,
} as const
