import { propertyWriteClassFromType } from '@overeng/notion-core'
import type { Sha256Digest } from '@overeng/notion-effect-client'

import { sha256Digest } from './hash.ts'

/**
 * Schema-drift detection for data-source-backed pages (decision 0017, R14).
 *
 * The engine captures a `schema_snapshot` of the parent data source's
 * **writable** property schema at pull (into the sidecar `data_source`
 * binding) and recomputes it before a property write at push. On drift it
 * refuses with `NmdSchemaDriftError` (exit 6) rather than risk Notion silently
 * auto-creating a select option for an unknown value name.
 *
 * Why a writable-only, name-based projection (decision 0013, live-verified):
 * - A computed-only schema change cannot affect a property *write*, so hashing
 *   only the writable subset keeps the guard from over-refusing on benign edits
 *   to formulas/rollups/etc. (consistent with the writable-projection guard,
 *   decision 0006).
 * - Hash names, not ids: a rename is id-preserving, so id-hashing would
 *   silently miss a rename — exactly the drift that corrupts a value write.
 * - Options are hashed for `select` / `multi_select` / `status` only, by name
 *   and sorted, because an unknown option name is silently auto-created on
 *   write (HTTP 200) — the one drift Notion does not reject on its own.
 * - Excluded from the hash: property ids, option ids, colors, descriptions,
 *   status groups, all timestamps, `created_by` / `last_edited_by`,
 *   `request_id`, title/url/is_inline/is_locked — none affects a write and all
 *   are volatile across otherwise-unchanged reads.
 */

/** Property types whose option set participates in the schema snapshot. */
const OPTION_PROPERTY_TYPES = new Set(['select', 'multi_select', 'status'])

/** One writable property projected to its drift-sensitive structure. */
interface WritableSchemaEntry {
  readonly name: string
  readonly type: string
  /** Sorted option names for select/multi_select/status; `null` otherwise. */
  readonly options: readonly string[] | null
}

const propertyDefType = (def: unknown): string | undefined => {
  if (typeof def !== 'object' || def === null || 'type' in def === false) return undefined
  const type = (def as { readonly type?: unknown }).type
  return typeof type === 'string' ? type : undefined
}

const propertyDefId = (def: unknown): string | undefined => {
  if (typeof def !== 'object' || def === null || 'id' in def === false) return undefined
  const id = (def as { readonly id?: unknown }).id
  return typeof id === 'string' ? id : undefined
}

/** Extract the sorted option *names* for an option-bearing property definition. */
const optionNames = (opts: { readonly def: unknown; readonly type: string }): readonly string[] => {
  const { def, type } = opts
  if (typeof def !== 'object' || def === null) return []
  const config = (def as Record<string, unknown>)[type]
  if (typeof config !== 'object' || config === null || 'options' in config === false) return []
  const options = (config as { readonly options?: unknown }).options
  if (Array.isArray(options) === false) return []
  return options
    .map((option) =>
      typeof option === 'object' && option !== null && 'name' in option === true
        ? (option as { readonly name?: unknown }).name
        : undefined,
    )
    .filter((name): name is string => typeof name === 'string')
    .toSorted()
}

/**
 * Project a data source's property schema to its writable, drift-sensitive
 * canonical form: `{ name, type, sorted option names }` entries for writable
 * properties only, sorted by property name.
 */
export const canonicalWritableSchema = (
  properties: Record<string, unknown>,
): readonly WritableSchemaEntry[] =>
  Object.entries(properties)
    .flatMap(([name, def]): readonly WritableSchemaEntry[] => {
      const type = propertyDefType(def)
      if (type === undefined || propertyWriteClassFromType(type) !== 'writable') return []
      return [
        {
          name,
          type,
          options: OPTION_PROPERTY_TYPES.has(type) === true ? optionNames({ def, type }) : null,
        },
      ]
    })
    .toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

/**
 * Hash a data source's writable property schema into the prefixed
 * `Sha256Digest` stored as the sidecar `data_source.schema_hash`.
 */
export const writableSchemaHash = (properties: Record<string, unknown>): Sha256Digest =>
  sha256Digest(JSON.stringify(canonicalWritableSchema(properties)))

/** All property name → id pairs, preserved for write targeting and diagnostics. */
export const propertyIdMap = (properties: Record<string, unknown>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(properties).flatMap(([name, def]) => {
      const id = propertyDefId(def)
      return id === undefined ? [] : [[name, id]]
    }),
  )

/** Name of the title property (`type === 'title'`), used for the sidecar binding. */
export const titlePropertyName = (properties: Record<string, unknown>): string | undefined => {
  for (const [name, def] of Object.entries(properties)) {
    if (propertyDefType(def) === 'title') return name
  }
  return undefined
}

/** Property names that cannot be written back (computed / unsupported). */
export const readOnlyPropertyNames = (properties: Record<string, unknown>): readonly string[] =>
  Object.entries(properties)
    .flatMap(([name, def]) => {
      const type = propertyDefType(def)
      return type === undefined || propertyWriteClassFromType(type) === 'writable' ? [] : [name]
    })
    .toSorted()
