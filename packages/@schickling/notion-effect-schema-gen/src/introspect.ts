import type { HttpClient } from '@effect/platform'
import {
  type NotionApiError,
  type NotionConfig,
  NotionDatabases,
} from '@schickling/notion-effect-client'
import { Effect } from 'effect'

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/** Supported Notion property types */
export type NotionPropertyType =
  | 'title'
  | 'rich_text'
  | 'number'
  | 'select'
  | 'multi_select'
  | 'status'
  | 'date'
  | 'people'
  | 'files'
  | 'checkbox'
  | 'url'
  | 'email'
  | 'phone_number'
  | 'formula'
  | 'relation'
  | 'rollup'
  | 'created_time'
  | 'created_by'
  | 'last_edited_time'
  | 'last_edited_by'
  | 'unique_id'
  | 'verification'
  | 'button'

/** Select/multi-select option */
export interface SelectOption {
  readonly id: string
  readonly name: string
  readonly color: string
}

/** Status group */
export interface StatusGroup {
  readonly id: string
  readonly name: string
  readonly color: string
  readonly option_ids: readonly string[]
}

/** Relation configuration */
export interface RelationConfig {
  readonly database_id: string
  readonly type: 'single_property' | 'dual_property'
  readonly single_property?: Record<string, never>
  readonly dual_property?: {
    readonly synced_property_id: string
    readonly synced_property_name: string
  }
}

/** Rollup configuration */
export interface RollupConfig {
  readonly relation_property_name: string
  readonly relation_property_id: string
  readonly rollup_property_name: string
  readonly rollup_property_id: string
  readonly function: string
}

/** Formula configuration */
export interface FormulaConfig {
  readonly expression: string
}

/** Number format */
export type NumberFormat =
  | 'number'
  | 'number_with_commas'
  | 'percent'
  | 'dollar'
  | 'canadian_dollar'
  | 'euro'
  | 'pound'
  | 'yen'
  | 'ruble'
  | 'rupee'
  | 'won'
  | 'yuan'
  | 'real'
  | 'lira'
  | 'franc'
  | 'hong_kong_dollar'
  | 'new_zealand_dollar'
  | 'krona'
  | 'norwegian_krone'
  | 'mexican_peso'
  | 'rand'
  | 'new_taiwan_dollar'
  | 'danish_krone'
  | 'zloty'
  | 'baht'
  | 'forint'
  | 'koruna'
  | 'shekel'
  | 'chilean_peso'
  | 'philippine_peso'
  | 'dirham'
  | 'colombian_peso'
  | 'riyal'
  | 'ringgit'
  | 'leu'
  | 'argentine_peso'
  | 'uruguayan_peso'
  | 'singapore_dollar'

/** Introspected property information */
export interface PropertyInfo {
  readonly id: string
  readonly name: string
  readonly type: NotionPropertyType
  readonly description?: string | undefined
  // Type-specific configuration
  readonly select?: { readonly options: readonly SelectOption[] }
  readonly multi_select?: { readonly options: readonly SelectOption[] }
  readonly status?: {
    readonly options: readonly SelectOption[]
    readonly groups: readonly StatusGroup[]
  }
  readonly relation?: RelationConfig
  readonly rollup?: RollupConfig
  readonly formula?: FormulaConfig
  readonly number?: { readonly format: NumberFormat }
}

/** Database introspection result */
export interface DatabaseInfo {
  readonly id: string
  readonly name: string
  readonly url: string
  readonly properties: readonly PropertyInfo[]
}

/** Property transform configuration - maps property names to transforms */
export type PropertyTransformConfig = Record<string, string>

// -----------------------------------------------------------------------------
// Introspection
// -----------------------------------------------------------------------------

/**
 * Introspect a Notion database and return its schema information.
 */
export const introspectDatabase = (
  databaseId: string,
): Effect.Effect<DatabaseInfo, NotionApiError, NotionConfig | HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const db = yield* NotionDatabases.retrieve({ databaseId })

    const name = db.title.map((t) => t.plain_text).join('') || 'UnnamedDatabase'

    const rawProperties = db.properties ?? {}
    const properties: PropertyInfo[] = []

    for (const [propName, propValue] of Object.entries(rawProperties)) {
      const prop = propValue as {
        id: string
        type: NotionPropertyType
        description?: string
        [key: string]: unknown
      }

      const propertyInfo: PropertyInfo = {
        id: prop.id,
        name: propName,
        type: prop.type,
        description: prop.description,
      }

      // Extract type-specific configuration
      switch (prop.type) {
        case 'select': {
          const selectConfig = prop.select as { options?: SelectOption[] }
          if (selectConfig?.options) {
            ;(propertyInfo as { select?: typeof propertyInfo.select }).select = {
              options: selectConfig.options,
            }
          }
          break
        }
        case 'multi_select': {
          const multiSelectConfig = prop.multi_select as { options?: SelectOption[] }
          if (multiSelectConfig?.options) {
            ;(propertyInfo as { multi_select?: typeof propertyInfo.multi_select }).multi_select = {
              options: multiSelectConfig.options,
            }
          }
          break
        }
        case 'status': {
          const statusConfig = prop.status as {
            options?: SelectOption[]
            groups?: StatusGroup[]
          }
          if (statusConfig) {
            ;(propertyInfo as { status?: typeof propertyInfo.status }).status = {
              options: statusConfig.options ?? [],
              groups: statusConfig.groups ?? [],
            }
          }
          break
        }
        case 'relation': {
          const relationConfig = prop.relation as RelationConfig
          if (relationConfig) {
            ;(propertyInfo as { relation?: typeof propertyInfo.relation }).relation = relationConfig
          }
          break
        }
        case 'rollup': {
          const rollupConfig = prop.rollup as RollupConfig
          if (rollupConfig) {
            ;(propertyInfo as { rollup?: typeof propertyInfo.rollup }).rollup = rollupConfig
          }
          break
        }
        case 'formula': {
          const formulaConfig = prop.formula as FormulaConfig
          if (formulaConfig) {
            ;(propertyInfo as { formula?: typeof propertyInfo.formula }).formula = formulaConfig
          }
          break
        }
        case 'number': {
          const numberConfig = prop.number as { format?: NumberFormat }
          if (numberConfig?.format) {
            ;(propertyInfo as { number?: typeof propertyInfo.number }).number = {
              format: numberConfig.format,
            }
          }
          break
        }
      }

      properties.push(propertyInfo)
    }

    return {
      id: db.id,
      name,
      url: db.url,
      properties,
    }
  })
