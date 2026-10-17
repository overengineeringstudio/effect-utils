import type { FieldRendererProps, FieldRenderers } from '@overeng/effect-schema-form'

import { BooleanField } from './components/BooleanField.tsx'
import { LiteralField } from './components/LiteralField.tsx'
import { NumberField } from './components/NumberField.tsx'
import { TextField } from './components/TextField.tsx'
import { UnknownField } from './components/UnknownField.tsx'

/**
 * String field renderer using React Aria TextField.
 */
const StringRenderer = ({
  fieldKey,
  meta,
  value,
  onChange,
}: FieldRendererProps<string | undefined>) => (
  <TextField
    id={`schema-form-${fieldKey}`}
    label={meta.title ?? fieldKey}
    value={value ?? ''}
    onChange={(v) => onChange(v || undefined)}
    hint={meta.description}
    placeholder={meta.isOptional === true ? '(optional)' : undefined}
  />
)

/**
 * Number field renderer with optional toggle support.
 */
const NumberRenderer = ({
  fieldKey,
  meta,
  value,
  onChange,
}: FieldRendererProps<number | undefined>) => (
  <NumberField
    id={`schema-form-${fieldKey}`}
    label={meta.title ?? fieldKey}
    value={value}
    onChange={onChange}
    hint={meta.description}
    isOptional={meta.isOptional}
  />
)

/**
 * Boolean field renderer using React Aria Checkbox.
 */
const BooleanRenderer = ({
  fieldKey,
  meta,
  value,
  onChange,
}: FieldRendererProps<boolean | undefined>) => (
  <BooleanField
    id={`schema-form-${fieldKey}`}
    label={meta.title ?? fieldKey}
    value={value ?? false}
    onChange={onChange}
    hint={meta.description}
  />
)

/**
 * Literal union field renderer.
 * Uses segmented control for small sets, select dropdown for large sets.
 */
const LiteralRenderer = ({
  fieldKey,
  meta,
  value,
  onChange,
}: FieldRendererProps<string | undefined>) => (
  <LiteralField
    id={`schema-form-${fieldKey}`}
    label={meta.title ?? fieldKey}
    value={value}
    onChange={onChange}
    literals={meta.literals ?? []}
    hint={meta.description}
    isOptional={meta.isOptional}
  />
)

/**
 * Unknown/unsupported field type renderer.
 */
const UnknownRenderer = ({ fieldKey, meta }: FieldRendererProps<unknown>) => (
  <UnknownField fieldKey={fieldKey} meta={meta} />
)

/**
 * Complete set of React Aria field renderers.
 *
 * Use with SchemaFormProvider or SchemaForm's renderers prop:
 *
 * ```tsx
 * import { SchemaFormProvider } from '@overeng/effect-schema-form'
 * import { ariaRenderers } from '@overeng/effect-schema-form-aria'
 *
 * <SchemaFormProvider renderers={ariaRenderers}>
 *   <SchemaForm schema={MySchema} value={data} onChange={setData} />
 * </SchemaFormProvider>
 * ```
 */
export const ariaRenderers: FieldRenderers = {
  string: StringRenderer,
  number: NumberRenderer,
  boolean: BooleanRenderer,
  literal: LiteralRenderer,
  unknown: UnknownRenderer,
}
