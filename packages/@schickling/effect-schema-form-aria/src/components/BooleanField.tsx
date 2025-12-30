import type { ReactNode } from 'react'
import { Checkbox as AriaCheckbox } from 'react-aria-components'

import { FieldWrapper } from './FieldWrapper.tsx'

/** Props for BooleanField component */
export interface BooleanFieldProps {
  /** Unique identifier for the field */
  id: string
  /** Label text */
  label: string
  /** Current value */
  value: boolean
  /** Called when value changes */
  onChange: (value: boolean) => void
  /** Hint/description text */
  hint?: string | undefined
  /** Whether the field is disabled */
  isDisabled?: boolean | undefined
}

/**
 * Accessible checkbox field using React Aria.
 */
export const BooleanField = ({
  id,
  label,
  value,
  onChange,
  hint,
  isDisabled = false,
}: BooleanFieldProps): ReactNode => (
  <FieldWrapper description={hint}>
    <AriaCheckbox
      id={id}
      isSelected={value}
      onChange={onChange}
      isDisabled={isDisabled}
      className="group flex items-center gap-2 text-sm text-ink cursor-pointer"
    >
      <div className="size-4 shrink-0 rounded border border-border bg-input group-data-[selected]:bg-primary group-data-[selected]:border-primary flex items-center justify-center transition-colors">
        <svg
          viewBox="0 0 12 12"
          className="size-3 text-white opacity-0 group-data-[selected]:opacity-100 transition-opacity"
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
      </div>
      <span>{label}</span>
    </AriaCheckbox>
  </FieldWrapper>
)
