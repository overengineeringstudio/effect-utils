import * as stylex from '@stylexjs/stylex'
import type { ReactNode } from 'react'

import type { FieldMeta } from '@overeng/effect-schema-form'
import { radii, spacing } from '@overeng/stylex-tokens/tokens.stylex'

import { tokens } from '../tokens.stylex.ts'

/** Props for UnknownField component */
export interface UnknownFieldProps {
  /** The property key */
  fieldKey: string
  /** Field metadata */
  meta: FieldMeta
}

const styles = stylex.create({
  root: {
    display: 'grid',
    rowGap: spacing['1.5'],
    padding: spacing[2],
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: tokens.border,
    borderRadius: radii.default,
    backgroundColor: tokens.surface,
  },
  title: {
    fontSize: '13px',
    color: tokens['muted-ink'],
  },
  message: {
    fontSize: '12px',
    fontStyle: 'italic',
    color: tokens['subtle-ink'],
  },
})

/**
 * Fallback renderer for unsupported field types.
 * Shows a visual indicator that the schema type cannot be rendered.
 */
export const UnknownField = ({ fieldKey, meta }: UnknownFieldProps): ReactNode => (
  <div {...stylex.props(styles.root)}>
    <span {...stylex.props(styles.title)}>{meta.title ?? fieldKey}</span>
    <span {...stylex.props(styles.message)}>Unsupported schema type: {meta.type}</span>
  </div>
)
