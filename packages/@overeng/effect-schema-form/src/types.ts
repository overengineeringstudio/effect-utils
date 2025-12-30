import type { Schema } from 'effect'
import type { ReactNode } from 'react'

/** Supported field types for UI rendering */
export type FieldType = 'string' | 'number' | 'boolean' | 'literal' | 'struct' | 'unknown'

/** Metadata extracted from a schema for UI rendering */
export interface FieldMeta {
  /** Field type for selecting the appropriate renderer */
  type: FieldType
  /** Human-readable title from schema annotation */
  title: string | undefined
  /** Description/hint text from schema annotation */
  description: string | undefined
  /** For literal types: the possible values */
  literals: readonly string[] | undefined
  /** Whether the field is optional */
  isOptional: boolean
  /** The underlying schema for the field (unwrapped from optional if needed) */
  innerSchema: Schema.Schema.AnyNoContext
}

/** Property signature with key and schema */
export interface PropertyInfo {
  key: string
  schema: Schema.Schema.AnyNoContext
  meta: FieldMeta
}

/** Info about a tagged struct (discriminated type) */
export interface TaggedStructInfo {
  /** Whether this is a tagged struct */
  isTagged: boolean
  /** The tag value (e.g., 'apple-contacts') if this is a tagged struct */
  tagValue: string | undefined
  /** Properties excluding the _tag field */
  contentProperties: readonly PropertyInfo[]
}

/** Props passed to all field renderers */
export interface FieldRendererProps<T = unknown> {
  /** The property key (used for generating IDs) */
  fieldKey: string
  /** Metadata about the field from schema introspection */
  meta: FieldMeta
  /** The current value */
  value: T
  /** Called when the value changes */
  onChange: (value: T) => void
}

/** A function that renders a field based on its props */
export type FieldRenderer<T = unknown> = (props: FieldRendererProps<T>) => ReactNode

/** Map of field types to their renderers */
export interface FieldRenderers {
  string?: FieldRenderer<string | undefined>
  number?: FieldRenderer<number | undefined>
  boolean?: FieldRenderer<boolean | undefined>
  literal?: FieldRenderer<string | undefined>
  struct?: FieldRenderer<Record<string, unknown>>
  unknown?: FieldRenderer<unknown>
}
