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
const makeTransform = <TType extends NotionPropertyType>({
  propertyType,
  name,
}: {
  propertyType: TType
  name: string
}): Transform<TType> => ({
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
    raw: makeTransform({ propertyType: 'title', name: 'raw' }),
    asString: makeTransform({ propertyType: 'title', name: 'asString' }),
  },
  rich_text: {
    raw: makeTransform({ propertyType: 'rich_text', name: 'raw' }),
    asString: makeTransform({ propertyType: 'rich_text', name: 'asString' }),
  },
  number: {
    raw: makeTransform({ propertyType: 'number', name: 'raw' }),
    asNumber: makeTransform({ propertyType: 'number', name: 'asNumber' }),
    asOption: makeTransform({ propertyType: 'number', name: 'asOption' }),
  },
  select: {
    raw: makeTransform({ propertyType: 'select', name: 'raw' }),
    asOption: makeTransform({ propertyType: 'select', name: 'asOption' }),
    asName: makeTransform({ propertyType: 'select', name: 'asName' }),
  },
  multi_select: {
    raw: makeTransform({ propertyType: 'multi_select', name: 'raw' }),
    asOptions: makeTransform({ propertyType: 'multi_select', name: 'asOptions' }),
    asNames: makeTransform({ propertyType: 'multi_select', name: 'asNames' }),
  },
  status: {
    raw: makeTransform({ propertyType: 'status', name: 'raw' }),
    asName: makeTransform({ propertyType: 'status', name: 'asName' }),
    asOption: makeTransform({ propertyType: 'status', name: 'asOption' }),
  },
  date: {
    raw: makeTransform({ propertyType: 'date', name: 'raw' }),
    asDate: makeTransform({ propertyType: 'date', name: 'asDate' }),
    asOption: makeTransform({ propertyType: 'date', name: 'asOption' }),
  },
  people: {
    raw: makeTransform({ propertyType: 'people', name: 'raw' }),
    asIds: makeTransform({ propertyType: 'people', name: 'asIds' }),
  },
  files: {
    raw: makeTransform({ propertyType: 'files', name: 'raw' }),
    asUrls: makeTransform({ propertyType: 'files', name: 'asUrls' }),
  },
  checkbox: {
    raw: makeTransform({ propertyType: 'checkbox', name: 'raw' }),
    asBoolean: makeTransform({ propertyType: 'checkbox', name: 'asBoolean' }),
  },
  url: {
    raw: makeTransform({ propertyType: 'url', name: 'raw' }),
    asString: makeTransform({ propertyType: 'url', name: 'asString' }),
    asOption: makeTransform({ propertyType: 'url', name: 'asOption' }),
  },
  email: {
    raw: makeTransform({ propertyType: 'email', name: 'raw' }),
    asString: makeTransform({ propertyType: 'email', name: 'asString' }),
    asOption: makeTransform({ propertyType: 'email', name: 'asOption' }),
  },
  phone_number: {
    raw: makeTransform({ propertyType: 'phone_number', name: 'raw' }),
    asString: makeTransform({ propertyType: 'phone_number', name: 'asString' }),
    asOption: makeTransform({ propertyType: 'phone_number', name: 'asOption' }),
  },
  formula: {
    raw: makeTransform({ propertyType: 'formula', name: 'raw' }),
    asBoolean: makeTransform({ propertyType: 'formula', name: 'asBoolean' }),
    asDate: makeTransform({ propertyType: 'formula', name: 'asDate' }),
    asNumber: makeTransform({ propertyType: 'formula', name: 'asNumber' }),
    asString: makeTransform({ propertyType: 'formula', name: 'asString' }),
  },
  relation: {
    raw: makeTransform({ propertyType: 'relation', name: 'raw' }),
    asIds: makeTransform({ propertyType: 'relation', name: 'asIds' }),
    asSingle: makeTransform({ propertyType: 'relation', name: 'asSingle' }),
    asSingleId: makeTransform({ propertyType: 'relation', name: 'asSingleId' }),
  },
  rollup: {
    raw: makeTransform({ propertyType: 'rollup', name: 'raw' }),
    asArray: makeTransform({ propertyType: 'rollup', name: 'asArray' }),
    asBoolean: makeTransform({ propertyType: 'rollup', name: 'asBoolean' }),
    asDate: makeTransform({ propertyType: 'rollup', name: 'asDate' }),
    asNumber: makeTransform({ propertyType: 'rollup', name: 'asNumber' }),
    asString: makeTransform({ propertyType: 'rollup', name: 'asString' }),
  },
  created_time: {
    raw: makeTransform({ propertyType: 'created_time', name: 'raw' }),
    asDate: makeTransform({ propertyType: 'created_time', name: 'asDate' }),
  },
  created_by: {
    raw: makeTransform({ propertyType: 'created_by', name: 'raw' }),
  },
  last_edited_time: {
    raw: makeTransform({ propertyType: 'last_edited_time', name: 'raw' }),
    asDate: makeTransform({ propertyType: 'last_edited_time', name: 'asDate' }),
  },
  last_edited_by: {
    raw: makeTransform({ propertyType: 'last_edited_by', name: 'raw' }),
  },
  unique_id: {
    raw: makeTransform({ propertyType: 'unique_id', name: 'raw' }),
  },
  verification: {
    raw: makeTransform({ propertyType: 'verification', name: 'raw' }),
  },
  button: {
    raw: makeTransform({ propertyType: 'button', name: 'raw' }),
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
