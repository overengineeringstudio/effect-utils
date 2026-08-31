import * as stylex from '@stylexjs/stylex'
import type { ReactNode } from 'react'
import {
  CheckboxButton as AriaCheckboxButton,
  CheckboxField as AriaCheckboxField,
} from 'react-aria-components'
import { fontSizes, radii, spacing } from 'tailwind-stylex/tokens.stylex'

import { tokens } from '../tokens.stylex.ts'
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

const styles = stylex.create({
  root: {
    fontSize: fontSizes.sm,
    lineHeight: '1.25rem',
    color: tokens.ink,
  },
  button: {
    display: 'flex',
    alignItems: 'center',
    columnGap: spacing[2],
    cursor: 'pointer',
  },
  box: {
    width: '1rem',
    height: '1rem',
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.default,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: tokens.border,
    backgroundColor: tokens.input,
    transitionProperty: 'background-color, border-color',
    transitionDuration: '150ms',
  },
  boxSelected: {
    backgroundColor: tokens.primary,
    borderColor: tokens.primary,
  },
  check: {
    width: '0.75rem',
    height: '0.75rem',
    color: '#ffffff',
    opacity: 0,
    transitionProperty: 'opacity',
    transitionDuration: '150ms',
  },
  checkVisible: {
    opacity: 1,
  },
})

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
    <AriaCheckboxField
      id={id}
      isSelected={value}
      onChange={onChange}
      isDisabled={isDisabled}
      {...stylex.props(styles.root)}
    >
      <AriaCheckboxButton {...stylex.props(styles.button)}>
        <div
          className={stylex.props(styles.box, value === true && styles.boxSelected).className ?? ''}
        >
          <svg
            viewBox="0 0 12 12"
            className={
              stylex.props(styles.check, value === true && styles.checkVisible).className ?? ''
            }
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
      </AriaCheckboxButton>
    </AriaCheckboxField>
  </FieldWrapper>
)
