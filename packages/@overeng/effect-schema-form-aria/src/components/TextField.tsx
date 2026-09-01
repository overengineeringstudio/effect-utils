import * as stylex from '@stylexjs/stylex'
import type { ReactNode } from 'react'
import { TextField as AriaTextField, Input, Label, Text } from 'react-aria-components'

import { fontSizes, radii, spacing } from '@overeng/stylex-tokens/tokens.stylex'

import { tokens } from '../tokens.stylex.ts'

/** Props for TextField component */
export interface TextFieldProps {
  /** Unique identifier for the field */
  id: string
  /** Label text */
  label: string
  /** Current value */
  value: string
  /** Called when value changes */
  onChange: (value: string) => void
  /** Hint/description text */
  hint?: string | undefined
  /** Input type */
  type?: 'text' | 'number' | 'email' | 'password' | 'url'
  /** Placeholder text */
  placeholder?: string | undefined
  /** Whether the field is disabled */
  isDisabled?: boolean | undefined
}

const styles = stylex.create({
  root: {
    display: 'grid',
    rowGap: spacing['1.5'],
  },
  label: {
    fontSize: fontSizes.sm,
    lineHeight: '1.25rem',
    color: tokens.ink,
  },
  input: {
    width: '100%',
    paddingInline: spacing['2.5'],
    paddingBlock: spacing[2],
    fontSize: fontSizes.sm,
    lineHeight: '1.25rem',
    borderRadius: radii.default,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: tokens.border,
    backgroundColor: tokens.input,
    color: tokens.ink,
    outline: 'none',
    boxShadow: { default: null, '[data-focus-visible]': `0 0 0 1px ${tokens.primary}` },
    opacity: { default: 1, ':disabled': 0.5 },
    cursor: { default: null, ':disabled': 'not-allowed' },
    '::placeholder': {
      color: tokens['subtle-ink'],
    },
  },
  description: {
    fontSize: '12px',
    color: tokens['subtle-ink'],
  },
})

/**
 * Accessible text field using React Aria.
 * Supports text, number, email, password, and url types.
 */
export const TextField = ({
  id,
  label,
  value,
  onChange,
  hint,
  type = 'text',
  placeholder,
  isDisabled = false,
}: TextFieldProps): ReactNode => (
  <AriaTextField
    {...stylex.props(styles.root)}
    value={value}
    onChange={onChange}
    isDisabled={isDisabled}
  >
    <Label {...stylex.props(styles.label)}>{label}</Label>
    <Input {...stylex.props(styles.input)} id={id} type={type} placeholder={placeholder ?? ''} />
    {hint !== undefined && (
      <Text slot="description" {...stylex.props(styles.description)}>
        {hint}
      </Text>
    )}
  </AriaTextField>
)
