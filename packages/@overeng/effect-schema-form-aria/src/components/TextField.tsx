import type { ReactNode } from 'react'
import { TextField as AriaTextField, Input, Label, Text } from 'react-aria-components'

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
  <AriaTextField className="grid gap-1.5" value={value} onChange={onChange} isDisabled={isDisabled}>
    <Label className="text-sm text-ink">{label}</Label>
    <Input
      id={id}
      type={type}
      placeholder={placeholder ?? ''}
      className="w-full px-2.5 py-2 text-sm rounded border border-border bg-input text-ink placeholder:text-subtle-ink focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50 disabled:cursor-not-allowed"
    />
    {hint !== undefined && (
      <Text slot="description" className="text-[12px] text-subtle-ink">
        {hint}
      </Text>
    )}
  </AriaTextField>
)
