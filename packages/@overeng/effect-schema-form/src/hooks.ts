import type { Schema } from 'effect'
import { useCallback, useMemo } from 'react'

import { analyzeSchema, analyzeTaggedStruct, getStructProperties } from './introspection.ts'
import type { FieldMeta, PropertyInfo, TaggedStructInfo } from './types.ts'

/** Return type for useSchemaForm hook */
export interface UseSchemaFormResult<T extends Record<string, unknown>> {
  /** All properties of the schema */
  fields: readonly PropertyInfo[]
  /** Tagged struct info (tag value, content properties) */
  tagInfo: TaggedStructInfo
  /** Get the value for a specific field */
  getValue: <K extends keyof T>(key: K) => T[K]
  /** Set the value for a specific field */
  setValue: <K extends keyof T>(key: K, value: T[K]) => void
  /** Set multiple values at once */
  setValues: (values: Partial<T>) => void
}

export interface UseSchemaFormOptions<T> {
  readonly schema: Schema.Schema<T>
  readonly value: T
  readonly onChange: (value: T) => void
}

/**
 * Hook for working with a schema form's fields and values.
 *
 * Provides field metadata and value accessors for building custom form UIs.
 *
 * ```tsx
 * const { fields, getValue, setValue, tagInfo } = useSchemaForm({ schema, value, onChange })
 *
 * return (
 *   <form>
 *     {fields.map(field => (
 *       <MyField
 *         key={field.key}
 *         meta={field.meta}
 *         value={getValue(field.key)}
 *         onChange={v => setValue(field.key, v)}
 *       />
 *     ))}
 *   </form>
 * )
 * ```
 */
export const useSchemaForm = <T extends Record<string, unknown>>({
  schema,
  value,
  onChange,
}: UseSchemaFormOptions<T>): UseSchemaFormResult<T> => {
  const fields = useMemo(() => getStructProperties(schema as Schema.Schema.AnyNoContext), [schema])

  const tagInfo = useMemo(() => analyzeTaggedStruct(schema as Schema.Schema.AnyNoContext), [schema])

  const getValue = useCallback(<K extends keyof T>(key: K): T[K] => value[key], [value])

  const setValue = useCallback(
    <K extends keyof T>(key: K, fieldValue: T[K]) => {
      onChange({ ...value, [key]: fieldValue } as T)
    },
    [value, onChange],
  )

  const setValues = useCallback(
    (values: Partial<T>) => {
      onChange({ ...value, ...values })
    },
    [value, onChange],
  )

  return {
    fields,
    tagInfo,
    getValue,
    setValue,
    setValues,
  }
}

/** Return type for useFieldMeta hook */
export interface UseFieldMetaResult {
  /** Metadata about the field */
  meta: FieldMeta
}

/**
 * Hook to get metadata for a single schema field.
 *
 * Useful for building standalone field components.
 *
 * ```tsx
 * const { meta } = useFieldMeta(fieldSchema)
 *
 * return (
 *   <div>
 *     <label>{meta.title}</label>
 *     {meta.description && <span>{meta.description}</span>}
 *   </div>
 * )
 * ```
 */
export const useFieldMeta = (schema: Schema.Schema.AnyNoContext): UseFieldMetaResult => {
  const meta = useMemo(() => analyzeSchema(schema), [schema])
  return { meta }
}
