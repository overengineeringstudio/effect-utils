import {
  formatLiteralLabel,
  SchemaForm,
  type SchemaFormRenderProps,
} from '@overeng/effect-schema-form'
import type { Schema } from 'effect'
import type { ReactNode } from 'react'
import { FieldGroup, FieldGroupEmpty } from './components/FieldGroup.tsx'
import { ariaRenderers } from './renderers.tsx'

/** Props for AriaSchemaForm component */
export interface AriaSchemaFormProps<T extends Record<string, unknown>> {
  /** The Effect Schema to render */
  schema: Schema.Schema<T>
  /** Current form value */
  value: T
  /** Called when any field value changes */
  onChange: (value: T) => void
  /** Additional CSS classes for the form container */
  className?: string
  /**
   * Whether to show the tag header for tagged structs.
   * When true (default), tagged structs render inside a FieldGroup with the tag as header.
   */
  showTagHeader?: boolean
}

/**
 * Pre-configured SchemaForm with React Aria renderers.
 *
 * A ready-to-use form component that combines the headless SchemaForm
 * with styled React Aria components.
 *
 * ```tsx
 * import { AriaSchemaForm } from '@overeng/effect-schema-form-aria'
 *
 * const UserSchema = Schema.Struct({
 *   name: Schema.String.annotations({ title: 'Name' }),
 *   age: Schema.optional(Schema.Number).annotations({ title: 'Age' }),
 *   role: Schema.Literal('admin', 'user', 'guest'),
 * })
 *
 * <AriaSchemaForm
 *   schema={UserSchema}
 *   value={user}
 *   onChange={setUser}
 * />
 * ```
 */
export const AriaSchemaForm = <T extends Record<string, unknown>>({
  schema,
  value,
  onChange,
  className = '',
  showTagHeader = true,
}: AriaSchemaFormProps<T>): ReactNode => {
  return (
    <SchemaForm
      schema={schema}
      value={value}
      onChange={onChange}
      renderers={ariaRenderers}
      showTagHeader={showTagHeader}
    >
      {({ fields, renderField, tagInfo }: SchemaFormRenderProps) => {
        // Tagged struct with no content fields
        if (
          showTagHeader &&
          tagInfo.isTagged &&
          fields.length === 0 &&
          tagInfo.tagValue !== undefined
        ) {
          return (
            <FieldGroupEmpty label={formatLiteralLabel(tagInfo.tagValue)} className={className} />
          )
        }

        // Render fields
        const renderedFields = (
          <div className={`grid gap-4 ${!tagInfo.isTagged || !showTagHeader ? className : ''}`}>
            {fields.map((field) => (
              <div key={field.key}>{renderField(field)}</div>
            ))}
          </div>
        )

        // Wrap in FieldGroup for tagged structs
        if (showTagHeader && tagInfo.isTagged && tagInfo.tagValue !== undefined) {
          return (
            <FieldGroup
              label={formatLiteralLabel(tagInfo.tagValue)}
              variant="subtle"
              className={className}
            >
              {renderedFields}
            </FieldGroup>
          )
        }

        return renderedFields
      }}
    </SchemaForm>
  )
}
