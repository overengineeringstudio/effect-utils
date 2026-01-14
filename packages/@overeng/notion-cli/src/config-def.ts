/**
 * Configuration definition for notion-effect-cli.
 *
 * This module provides the types and helpers needed to define a TypeScript config file.
 *
 * @example
 * ```ts
 * // notion-schema-gen.config.ts
 * import { defineConfig, dir, file, transforms } from '@overeng/notion-effect-cli/config'
 *
 * export default defineConfig({
 *   outputDir: dir('./src/notion-schemas/'),
 *   defaults: {
 *     includeWrite: true,
 *     includeApi: true,
 *   },
 *   databases: {
 *     'abc123-def456-...': {
 *       output: file('tasks.ts'),
 *       name: 'Tasks',
 *       transforms: {
 *         'Due Date': transforms.date.asDate,
 *         'Priority': transforms.select.asName,
 *       },
 *     },
 *   },
 * })
 * ```
 *
 * @module
 */

import { EffectPath, type RelativeDirPath, type RelativeFilePath } from '@overeng/effect-path'

import type { NotionPropertyType } from './introspect.ts'

// Re-export path types for config authors
export type { RelativeDirPath, RelativeFilePath }

/**
 * Create a relative file path for use in config.
 * File paths must NOT end with a trailing slash.
 *
 * @example
 * ```ts
 * output: file('tasks.ts')
 * output: file('schemas/tasks.ts')
 * ```
 */
export const file = (path: string): RelativeFilePath => EffectPath.unsafe.relativeFile(path)

/**
 * Create a relative directory path for use in config.
 * Directory paths will have a trailing slash added if not present.
 *
 * @example
 * ```ts
 * outputDir: dir('./src/schemas/')
 * outputDir: dir('generated')  // becomes 'generated/'
 * ```
 */
export const dir = (path: string): RelativeDirPath => EffectPath.unsafe.relativeDir(path)

// -----------------------------------------------------------------------------
// Transform Types
// -----------------------------------------------------------------------------

/** A typed transform reference */
export interface Transform<TType extends NotionPropertyType = NotionPropertyType> {
  readonly _tag: 'Transform'
  readonly propertyType: TType
  readonly name: string
}

/** Create a transform reference */
// oxlint-disable-next-line overeng/named-args -- internal factory pattern
const makeTransform = <TType extends NotionPropertyType>(
  propertyType: TType,
  name: string,
): Transform<TType> => ({
  _tag: 'Transform',
  propertyType,
  name,
})

/**
 * Typed transform helpers for each property type.
 *
 * Use these instead of string literals for type-safe transform configuration.
 */
export const transforms = {
  title: {
    raw: makeTransform('title', 'raw'),
    asString: makeTransform('title', 'asString'),
  },
  rich_text: {
    raw: makeTransform('rich_text', 'raw'),
    asString: makeTransform('rich_text', 'asString'),
  },
  number: {
    raw: makeTransform('number', 'raw'),
    asNumber: makeTransform('number', 'asNumber'),
    asOption: makeTransform('number', 'asOption'),
  },
  select: {
    raw: makeTransform('select', 'raw'),
    asOption: makeTransform('select', 'asOption'),
    asName: makeTransform('select', 'asName'),
  },
  multi_select: {
    raw: makeTransform('multi_select', 'raw'),
    asOptions: makeTransform('multi_select', 'asOptions'),
    asNames: makeTransform('multi_select', 'asNames'),
  },
  status: {
    raw: makeTransform('status', 'raw'),
    asName: makeTransform('status', 'asName'),
    asOption: makeTransform('status', 'asOption'),
  },
  date: {
    raw: makeTransform('date', 'raw'),
    asDate: makeTransform('date', 'asDate'),
    asOption: makeTransform('date', 'asOption'),
  },
  people: {
    raw: makeTransform('people', 'raw'),
    asIds: makeTransform('people', 'asIds'),
  },
  files: {
    raw: makeTransform('files', 'raw'),
    asUrls: makeTransform('files', 'asUrls'),
  },
  checkbox: {
    raw: makeTransform('checkbox', 'raw'),
    asBoolean: makeTransform('checkbox', 'asBoolean'),
  },
  url: {
    raw: makeTransform('url', 'raw'),
    asString: makeTransform('url', 'asString'),
    asOption: makeTransform('url', 'asOption'),
  },
  email: {
    raw: makeTransform('email', 'raw'),
    asString: makeTransform('email', 'asString'),
    asOption: makeTransform('email', 'asOption'),
  },
  phone_number: {
    raw: makeTransform('phone_number', 'raw'),
    asString: makeTransform('phone_number', 'asString'),
    asOption: makeTransform('phone_number', 'asOption'),
  },
  formula: {
    raw: makeTransform('formula', 'raw'),
    asBoolean: makeTransform('formula', 'asBoolean'),
    asDate: makeTransform('formula', 'asDate'),
    asNumber: makeTransform('formula', 'asNumber'),
    asString: makeTransform('formula', 'asString'),
  },
  relation: {
    raw: makeTransform('relation', 'raw'),
    asIds: makeTransform('relation', 'asIds'),
    asSingle: makeTransform('relation', 'asSingle'),
    asSingleId: makeTransform('relation', 'asSingleId'),
  },
  rollup: {
    raw: makeTransform('rollup', 'raw'),
    asArray: makeTransform('rollup', 'asArray'),
    asBoolean: makeTransform('rollup', 'asBoolean'),
    asDate: makeTransform('rollup', 'asDate'),
    asNumber: makeTransform('rollup', 'asNumber'),
    asString: makeTransform('rollup', 'asString'),
  },
  created_time: {
    raw: makeTransform('created_time', 'raw'),
    asDate: makeTransform('created_time', 'asDate'),
  },
  created_by: {
    raw: makeTransform('created_by', 'raw'),
  },
  last_edited_time: {
    raw: makeTransform('last_edited_time', 'raw'),
    asDate: makeTransform('last_edited_time', 'asDate'),
  },
  last_edited_by: {
    raw: makeTransform('last_edited_by', 'raw'),
  },
  unique_id: {
    raw: makeTransform('unique_id', 'raw'),
  },
  verification: {
    raw: makeTransform('verification', 'raw'),
  },
  button: {
    raw: makeTransform('button', 'raw'),
  },
} as const

export type Transforms = typeof transforms

// -----------------------------------------------------------------------------
// Config Types
// -----------------------------------------------------------------------------

/** Transform config value - either a typed Transform or a string (for backwards compat in internal use) */
export type TransformValue = Transform | string

/** Property-specific transforms - maps property names to transforms */
export type PropertyTransforms = Record<string, TransformValue>

/** Configuration for a single database */
export interface DatabaseConfig {
  /** Output file path (relative to outputDir if set, otherwise relative to config file) */
  readonly output: RelativeFilePath
  /** Custom schema name (defaults to database title) */
  readonly name?: string
  /** Include Write schemas */
  readonly includeWrite?: boolean
  /** Generate typed options for select/status/multi_select */
  readonly typedOptions?: boolean
  /** Include Notion property metadata annotations */
  readonly schemaMeta?: boolean
  /** Generate a typed database API wrapper */
  readonly includeApi?: boolean
  /** Property-specific transforms */
  readonly transforms?: PropertyTransforms
}

/** Default options applied to all databases */
export interface DefaultsConfig {
  readonly includeWrite?: boolean
  readonly typedOptions?: boolean
  readonly schemaMeta?: boolean
  readonly includeApi?: boolean
  readonly transforms?: PropertyTransforms
}

/** Root configuration schema */
export interface SchemaGenConfig {
  /** Base output directory (paths in databases are relative to this, must end with /) */
  readonly outputDir?: RelativeDirPath
  /** Default options applied to all databases */
  readonly defaults?: DefaultsConfig
  /** Databases keyed by their Notion database ID */
  readonly databases: Record<string, DatabaseConfig>
}

// -----------------------------------------------------------------------------
// Config Helper
// -----------------------------------------------------------------------------

/**
 * Define a schema generation configuration with full type checking and autocompletion.
 *
 * @example
 * ```ts
 * import { defineConfig, dir, file, transforms } from '@overeng/notion-effect-cli/config'
 *
 * export default defineConfig({
 *   outputDir: dir('./src/schemas/'),
 *   defaults: {
 *     includeWrite: true,
 *   },
 *   databases: {
 *     'abc123...': {
 *       output: file('tasks.ts'),
 *       name: 'Tasks',
 *       transforms: {
 *         'Due Date': transforms.date.asDate,
 *       },
 *     },
 *   },
 * })
 * ```
 */
export const defineConfig = (config: SchemaGenConfig): SchemaGenConfig => config
