import type { ReactNode } from 'react'

/** Props for FieldWrapper component */
export interface FieldWrapperProps {
  /** Description/hint text to show below the field */
  description?: string | undefined
  /** The field control */
  children: ReactNode
}

/**
 * Consistent field wrapper with control row + description row.
 * Uses fixed height for description to maintain alignment across fields.
 */
export const FieldWrapper = ({ description, children }: FieldWrapperProps): ReactNode => (
  <div className="grid gap-1.5">
    <div>{children}</div>
    <div className="min-h-[16px] text-[12px] text-subtle-ink">{description}</div>
  </div>
)
