/**
 * Headless SchemaForm - Auto-generated form from Effect Schema
 *
 * Renders appropriate form controls based on schema structure and types.
 * Uses renderers from context or props to render each field.
 *
 * ## Usage
 *
 * With provider (recommended for design systems):
 * ```tsx
 * <SchemaFormProvider renderers={myRenderers}>
 *   <SchemaForm schema={MySchema} value={data} onChange={setData} />
 * </SchemaFormProvider>
 * ```
 *
 * With inline renderers:
 * ```tsx
 * <SchemaForm
 *   schema={MySchema}
 *   value={data}
 *   onChange={setData}
 *   renderers={{ string: MyStringRenderer }}
 * />
 * ```
 *
 * With render prop for full control:
 * ```tsx
 * <SchemaForm schema={MySchema} value={data} onChange={setData}>
 *   {({ fields, renderField }) => (
 *     <div className="custom-layout">
 *       {fields.map(field => renderField(field))}
 *     </div>
 *   )}
 * </SchemaForm>
 * ```
 */
import type { Schema } from 'effect'
import type { ReactNode } from 'react'

import { useSchemaFormContext } from './context.tsx'
import { useSchemaForm } from './hooks.ts'
import type {
  FieldRenderer,
  FieldRendererProps,
  FieldRenderers,
  PropertyInfo,
  TaggedStructInfo,
} from './types.ts'

/** Props for the SchemaForm component */
export interface SchemaFormProps<T extends Record<string, unknown>> {
  /** The Effect Schema to render */
  schema: Schema.Schema<T>
  /** Current form value */
  value: T
  /** Called when any field value changes */
  onChange: (value: T) => void
  /** Override renderers for specific field types (merged with context renderers) */
  renderers?: Partial<FieldRenderers>
  /**
   * Render prop for full control over form layout.
   * When provided, the default rendering is bypassed.
   */
  children?: (props: SchemaFormRenderProps) => ReactNode
  /**
   * Whether to show the tag header for tagged structs.
   * When true (default), tagged structs include tag info in render props.
   */
  showTagHeader?: boolean
  /**
   * Wrapper component for fields.
   * Receives the rendered fields and tag info, allows custom layout.
   */
  wrapper?: (props: { children: ReactNode; tagInfo: TaggedStructInfo }) => ReactNode
}

/** Props passed to the render prop function */
export interface SchemaFormRenderProps {
  /** All renderable fields (excludes _tag for tagged structs) */
  fields: readonly PropertyInfo[]
  /** Function to render a single field using the configured renderers */
  renderField: (field: PropertyInfo) => ReactNode
  /** Tag info for tagged structs */
  tagInfo: TaggedStructInfo
}

/**
 * Headless SchemaForm component.
 *
 * Introspects the schema to determine field types and uses configured renderers
 * to generate the UI. Supports context-based, prop-based, and render-prop patterns.
 */
export const SchemaForm = <T extends Record<string, unknown>>({
  schema,
  value,
  onChange,
  renderers: propRenderers,
  children,
  showTagHeader: _showTagHeader = true,
  wrapper,
}: SchemaFormProps<T>): ReactNode => {
  const contextValue = useSchemaFormContext()
  const {
    fields: allFields,
    tagInfo,
    getValue,
    setValue,
  } = useSchemaForm({ schema, value, onChange })

  // Merge renderers: prop renderers override context renderers
  const renderers: FieldRenderers = {
    ...contextValue?.renderers,
    ...propRenderers,
  }

  // Always hide the internal `_tag` field from the rendered fields.
  // `showTagHeader` controls presentation (e.g. grouping), not whether `_tag` is editable.
  const fieldsToRender = tagInfo.isTagged === true ? tagInfo.contentProperties : allFields

  // Create the renderField function
  const renderField = (field: PropertyInfo): ReactNode => {
    const fieldValue = getValue(field.key as keyof T)
    const handleChange = (newValue: unknown) =>
      setValue(field.key as keyof T, newValue as T[keyof T])

    const props: FieldRendererProps = {
      fieldKey: field.key,
      meta: field.meta,
      value: fieldValue,
      onChange: handleChange,
    }

    // Select renderer based on field type
    // Type assertion needed because FieldRenderers maps specific types to specific renderers
    // but at runtime we're dynamically selecting based on field.meta.type
    const renderer = renderers[field.meta.type] as FieldRenderer<unknown> | undefined
    if (renderer !== undefined) {
      return renderer(props)
    }

    // Fall back to unknown renderer if available
    if (renderers.unknown !== undefined) {
      return renderers.unknown(props)
    }

    // No renderer available
    return null
  }

  // If render prop is provided, use it
  if (children !== undefined) {
    return children({
      fields: fieldsToRender,
      renderField,
      tagInfo,
    })
  }

  // Default rendering: just render all fields
  const renderedFields = fieldsToRender.map((field) => (
    <div key={field.key}>{renderField(field)}</div>
  ))

  // Use wrapper if provided
  if (wrapper !== undefined) {
    return wrapper({ children: renderedFields, tagInfo })
  }

  // Default: return fragment of rendered fields
  return <>{renderedFields}</>
}
