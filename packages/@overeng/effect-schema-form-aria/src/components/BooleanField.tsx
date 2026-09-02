import * as stylex from '@stylexjs/stylex'
import type { ReactNode } from 'react'
import {
  CheckboxButton as AriaCheckboxButton,
  CheckboxField as AriaCheckboxField,
} from 'react-aria-components'

import { fontSizes, radii, spacing } from '@overeng/stylex-tokens/tokens.stylex'

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
    color: tokens['on-primary'],
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
      {/*
        Selection lives on the CheckboxButton, not on the box the style targets,
        so the box cannot read it as one of its own conditions. React Aria
        surfaces it as a render prop, which is the sanctioned mechanism for that
        case, and the selected styles are ordered arguments rather than a
        mutually exclusive branch — the winner is last and the precedence is the
        argument order. Reading `isSelected` rather than the `value` prop also
        stops the style re-deriving state the component already resolved.
      */}
      <AriaCheckboxButton {...stylex.props(styles.button)}>
        {({ isSelected }) => (
          <>
            <div {...stylex.props(styles.box, isSelected === true && styles.boxSelected)}>
              <svg
                viewBox="0 0 12 12"
                {...stylex.props(styles.check, isSelected === true && styles.checkVisible)}
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
          </>
        )}
      </AriaCheckboxButton>
    </AriaCheckboxField>
  </FieldWrapper>
)
