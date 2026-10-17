import * as stylex from '@stylexjs/stylex'
import type { ReactNode } from 'react'
import { Group, Text } from 'react-aria-components'

import { fontSizes, radii, spacing } from '@overeng/stylex-tokens/tokens.stylex'

import { tokens } from '../tokens.stylex.ts'

/** Props for FieldGroup component */
export interface FieldGroupProps {
  /** Label for the group header */
  label: string
  /** Visual variant */
  variant?: 'default' | 'subtle'
  /** Additional CSS classes */
  className?: string
  /** Child fields */
  children: ReactNode
}

const styles = stylex.create({
  base: {
    borderRadius: radii.lg,
    borderStyle: 'solid',
    borderWidth: 1,
  },
  defaultVariant: {
    borderColor: tokens.border,
    backgroundColor: tokens.surface,
    padding: spacing[4],
  },
  subtleVariant: {
    borderColor: `color-mix(in oklab, ${tokens.border} 50%, transparent)`,
    backgroundColor: `color-mix(in oklab, ${tokens.surface} 30%, transparent)`,
    padding: spacing[3],
  },
  header: {
    fontSize: fontSizes.sm,
    lineHeight: '1.25rem',
    fontWeight: 500,
    color: tokens.ink,
    marginBottom: spacing[3],
  },
  fieldsGrid: {
    display: 'grid',
    rowGap: spacing[4],
  },
})

/** Styles shared with FieldGroupEmpty (subtle look). */
export const emptyGroupStyles = stylex.create({
  root: {
    borderRadius: radii.lg,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: `color-mix(in oklab, ${tokens.border} 50%, transparent)`,
    backgroundColor: `color-mix(in oklab, ${tokens.surface} 30%, transparent)`,
    padding: spacing[3],
  },
  header: {
    fontSize: fontSizes.sm,
    lineHeight: '1.25rem',
    fontWeight: 500,
    color: tokens.ink,
    marginBottom: spacing[2],
  },
  message: {
    fontSize: fontSizes.xs,
    lineHeight: '1rem',
    fontStyle: 'italic',
    color: tokens['subtle-ink'],
  },
})

/**
 * Groups related form fields with an accessible header.
 * Used for tagged structs and nested field groups.
 */
export const FieldGroup = ({
  label,
  variant = 'default',
  className = '',
  children,
}: FieldGroupProps): ReactNode => {
  const groupClassName = [
    stylex.props(styles.base, variant === 'subtle' ? styles.subtleVariant : styles.defaultVariant)
      .className,
    className,
  ]
    .filter(Boolean)
    .join(' ')

  // The group label is a plain element, not React Aria's `Header`. `Header`
  // renders `<header>`, and a `<header>` that is not inside sectioning content
  // is a `banner` landmark — so two field groups on a page produced two banners
  // and the accessibility gate failed the nested-group story on
  // `landmark-no-duplicate-banner` and `landmark-unique`. Naming the group with
  // `aria-label` gives it the accessible name it was missing anyway.
  return (
    <Group aria-label={label} className={groupClassName}>
      <div {...stylex.props(styles.header)}>{label}</div>
      <div {...stylex.props(styles.fieldsGrid)}>{children}</div>
    </Group>
  )
}

/** Props for FieldGroupEmpty component */
export interface FieldGroupEmptyProps {
  /** Label for the group header */
  label: string
  /** Message to show when group has no fields */
  message?: string
  /** Additional CSS classes */
  className?: string
}

/**
 * Empty field group state for tagged structs with no content fields.
 */
export const FieldGroupEmpty = ({
  label,
  message = 'No additional options',
  className = '',
}: FieldGroupEmptyProps): ReactNode => {
  const rootClassName = [stylex.props(emptyGroupStyles.root).className, className]
    .filter(Boolean)
    .join(' ')

  // Same landmark reasoning as `FieldGroup`.
  return (
    <Group aria-label={label} className={rootClassName}>
      <div {...stylex.props(emptyGroupStyles.header)}>{label}</div>
      <Text {...stylex.props(emptyGroupStyles.message)}>{message}</Text>
    </Group>
  )
}
