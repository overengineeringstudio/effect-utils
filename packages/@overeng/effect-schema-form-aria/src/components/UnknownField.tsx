import type { ReactNode } from 'react'

import type { FieldMeta } from '@overeng/effect-schema-form'

/** Props for UnknownField component */
export interface UnknownFieldProps {
  /** The property key */
  fieldKey: string
  /** Field metadata */
  meta: FieldMeta
}

/**
 * Fallback renderer for unsupported field types.
 * Shows a visual indicator that the schema type cannot be rendered.
 */
export const UnknownField = ({ fieldKey, meta }: UnknownFieldProps): ReactNode => (
  <div className="grid gap-1.5 p-2 border border-border rounded bg-surface">
    <span className="text-[13px] text-muted-ink">{meta.title ?? fieldKey}</span>
    <span className="text-[12px] text-subtle-ink italic">Unsupported schema type: {meta.type}</span>
  </div>
)
