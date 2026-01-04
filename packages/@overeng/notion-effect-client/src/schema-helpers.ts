import { Array as Arr, Option, Order, Schema } from 'effect'

import type {
  DatabaseSchema,
  NumberFormat,
  PropertySchema,
  RollupFunction,
  SelectOptionConfig,
} from '@overeng/notion-effect-schema'
import { PropertySchema as PropertySchemaCodec } from '@overeng/notion-effect-schema'

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
    const normalized = normalizeDatabasePropertyDefinition({ name, raw: rawValue })
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
  const prop = getPropertyByTag({ schema: args.schema, name: args.property, tag: 'select' })
  return Option.map(prop, (p) => p.select.options)
}

/**
 * Get multi-select options for a multi_select property.
 */
export const getMultiSelectOptions = (args: {
  schema: DatabaseSchema
  property: string
}): Option.Option<readonly SelectOptionConfig[]> => {
  const prop = getPropertyByTag({ schema: args.schema, name: args.property, tag: 'multi_select' })
  return Option.map(prop, (p) => p.multi_select.options)
}

/**
 * Get status options for a status property.
 */
export const getStatusOptions = (args: {
  schema: DatabaseSchema
  property: string
}): Option.Option<readonly SelectOptionConfig[]> => {
  const prop = getPropertyByTag({ schema: args.schema, name: args.property, tag: 'status' })
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
  const prop = getPropertyByTag({ schema: args.schema, name: args.property, tag: 'relation' })
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
  const prop = getPropertyByTag({ schema: args.schema, name: args.property, tag: 'formula' })
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
  const prop = getPropertyByTag({ schema: args.schema, name: args.property, tag: 'number' })
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
  const prop = getPropertyByTag({ schema: args.schema, name: args.property, tag: 'rollup' })
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
  const prop = getPropertyByTag({ schema: args.schema, name: args.property, tag: 'unique_id' })
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
  getSelectOptions,
  getMultiSelectOptions,
  getStatusOptions,
  getAnySelectOptions,
  getRelationTarget,
  getFormulaExpression,
  getNumberFormat,
  getRollupConfig,
  getUniqueIdPrefix,
} as const
