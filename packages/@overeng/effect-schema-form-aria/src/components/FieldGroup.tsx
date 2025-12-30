import type { ReactNode } from 'react'
import { Group, Header, Text } from 'react-aria-components'

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
  const baseClasses = 'rounded-lg border'
  const variantClasses =
    variant === 'subtle' ? 'border-border/50 bg-surface/30 p-3' : 'border-border bg-surface p-4'

  return (
    <Group className={`${baseClasses} ${variantClasses} ${className}`}>
      <Header className="text-sm font-medium text-ink mb-3">{label}</Header>
      <div className="grid gap-4">{children}</div>
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
}: FieldGroupEmptyProps): ReactNode => (
  <Group className={`rounded-lg border border-border/50 bg-surface/30 p-3 ${className}`}>
    <Header className="text-sm font-medium text-ink mb-2">{label}</Header>
    <Text className="text-xs text-subtle-ink italic">{message}</Text>
  </Group>
)
