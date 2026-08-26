import * as stylex from '@stylexjs/stylex'
import type { ReactNode } from 'react'
import { spacing } from 'tailwind-stylex/tokens.stylex'

import { tokens } from '../tokens.stylex.ts'

/** Props for FieldWrapper component */
export interface FieldWrapperProps {
  /** Description/hint text to show below the field */
  description?: string | undefined
  /** The field control */
  children: ReactNode
}

const styles = stylex.create({
  root: {
    display: 'grid',
    rowGap: spacing['1.5'],
  },
  description: {
    minHeight: '16px',
    fontSize: '12px',
    color: tokens['subtle-ink'],
  },
})

/**
 * Consistent field wrapper with control row + description row.
 * Uses fixed height for description to maintain alignment across fields.
 */
export const FieldWrapper = ({ description, children }: FieldWrapperProps): ReactNode => (
  <div {...stylex.props(styles.root)}>
    <div>{children}</div>
    <div {...stylex.props(styles.description)}>{description}</div>
  </div>
)
