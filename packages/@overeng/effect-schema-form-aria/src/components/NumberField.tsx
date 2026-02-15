import type { ReactNode } from 'react'
import { NumberField as AriaNumberField, Input, Label, Text } from 'react-aria-components'

import { FieldWrapper } from './FieldWrapper.tsx'

/** Props for NumberField component */
export interface NumberFieldProps {
  /** Unique identifier for the field */
  id: string
  /** Label text */
  label: string
  /** Current value */
  value: number | undefined
  /** Called when value changes */
  onChange: (value: number | undefined) => void
  /** Hint/description text */
  hint?: string | undefined
  /** Whether the field is optional (shows toggle) */
  isOptional?: boolean | undefined
  /** Whether the field is disabled */
  isDisabled?: boolean | undefined
}

/**
 * Number field component.
 *
 * For optional fields, shows a toggle button to enable/disable the value.
 * When disabled, value is `undefined`. When enabled, shows number input.
 */
export const NumberField = ({
  id,
  label,
  value,
  onChange,
  hint,
  isOptional = false,
  isDisabled = false,
}: NumberFieldProps): ReactNode => {
  const isEnabled = value !== undefined

  // Optional field: shows toggle to enable/disable
  if (isOptional === true) {
    return (
      <FieldWrapper description={hint}>
        <div className="flex items-center gap-2">
          <label htmlFor={id} className="text-sm text-ink whitespace-nowrap">
            {label}
          </label>
          <input
            id={id}
            type="number"
            disabled={isEnabled === false || isDisabled === true}
            value={isEnabled === true ? value : ''}
            onChange={(e) => {
              const target = e.target as HTMLInputElement
              onChange(target.value === '' ? undefined : Number(target.value))
            }}
            className="w-20 px-2 py-0.5 text-sm rounded border border-border bg-input text-ink focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50"
          />
          <button
            type="button"
            role="switch"
            aria-checked={isEnabled}
            title={isEnabled === true ? 'Click to disable (set to undefined)' : 'Click to enable'}
            onClick={() => onChange(isEnabled === true ? undefined : 0)}
            disabled={isDisabled}
            className="size-4 shrink-0 rounded border border-border flex items-center justify-center hover:bg-surface-raised disabled:opacity-50"
          >
            {isEnabled === true ? (
              <svg
                width="10"
                height="10"
                viewBox="0 0 12 12"
                className="text-accent"
                aria-hidden="true"
              >
                <path
                  d="M3 6l2 2 4-5"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  fill="none"
                />
              </svg>
            ) : null}
          </button>
        </div>
      </FieldWrapper>
    )
  }

  // Required field: standard number input
  return (
    <AriaNumberField
      className="grid gap-1.5"
      value={value ?? NaN}
      onChange={(v) => onChange(Number.isNaN(v) === true ? undefined : v)}
      isDisabled={isDisabled}
    >
      <Label className="text-sm text-ink">{label}</Label>
      <Input
        id={id}
        className="w-full px-2.5 py-2 text-sm rounded border border-border bg-input text-ink focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50 disabled:cursor-not-allowed"
      />
      {hint !== undefined && (
        <Text slot="description" className="text-[12px] text-subtle-ink">
          {hint}
        </Text>
      )}
    </AriaNumberField>
  )
}
