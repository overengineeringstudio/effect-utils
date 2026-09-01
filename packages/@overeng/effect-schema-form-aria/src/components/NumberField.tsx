import * as stylex from '@stylexjs/stylex'
import type { ReactNode } from 'react'
import { NumberField as AriaNumberField, Input, Label, Text } from 'react-aria-components'

import { fontSizes, radii, spacing } from '@overeng/stylex-tokens/tokens.stylex'

import { tokens } from '../tokens.stylex.ts'
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

const styles = stylex.create({
  row: {
    display: 'flex',
    alignItems: 'center',
    columnGap: spacing[2],
  },
  label: {
    fontSize: fontSizes.sm,
    lineHeight: '1.25rem',
    color: tokens.ink,
    whiteSpace: 'nowrap',
  },
  compactInput: {
    width: spacing[20],
    paddingInline: spacing[2],
    paddingBlock: '0.125rem',
    fontSize: fontSizes.sm,
    lineHeight: '1.25rem',
    borderRadius: radii.default,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: tokens.border,
    backgroundColor: tokens.input,
    color: tokens.ink,
    outline: 'none',
    // oxlint-disable-next-line @stylexjs/no-legacy-contextual-styles, @stylexjs/valid-styles -- deprecated top-level pseudo-class; nesting it changes condition precedence, so it needs the visual gate. See #1171
    ':focus': {
      boxShadow: `0 0 0 1px ${tokens.primary}`,
    },
    // oxlint-disable-next-line @stylexjs/no-legacy-contextual-styles, @stylexjs/valid-styles -- deprecated top-level pseudo-class; nesting it changes condition precedence, so it needs the visual gate. See #1171
    ':disabled': {
      opacity: 0.5,
    },
  },
  toggle: {
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
    // oxlint-disable-next-line @stylexjs/no-legacy-contextual-styles, @stylexjs/valid-styles -- deprecated top-level pseudo-class; nesting it changes condition precedence, so it needs the visual gate. See #1171
    ':hover': {
      backgroundColor: tokens['surface-raised'],
    },
    // oxlint-disable-next-line @stylexjs/no-legacy-contextual-styles, @stylexjs/valid-styles -- deprecated top-level pseudo-class; nesting it changes condition precedence, so it needs the visual gate. See #1171
    ':disabled': {
      opacity: 0.5,
    },
  },
  root: {
    display: 'grid',
    rowGap: spacing['1.5'],
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
    // oxlint-disable-next-line @stylexjs/no-legacy-contextual-styles, @stylexjs/valid-styles -- deprecated top-level pseudo-class; nesting it changes condition precedence, so it needs the visual gate. See #1171
    ':focus': {
      boxShadow: `0 0 0 1px ${tokens.primary}`,
    },
    // oxlint-disable-next-line @stylexjs/no-legacy-contextual-styles, @stylexjs/valid-styles -- deprecated top-level pseudo-class; nesting it changes condition precedence, so it needs the visual gate. See #1171
    ':disabled': {
      opacity: 0.5,
      cursor: 'not-allowed',
    },
  },
  description: {
    fontSize: '12px',
    color: tokens['subtle-ink'],
  },
})

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
        <div {...stylex.props(styles.row)}>
          <label htmlFor={id} {...stylex.props(styles.label)}>
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
            {...stylex.props(styles.compactInput)}
          />
          <button
            type="button"
            role="switch"
            aria-checked={isEnabled}
            title={isEnabled === true ? 'Click to disable (set to undefined)' : 'Click to enable'}
            onClick={() => onChange(isEnabled === true ? undefined : 0)}
            disabled={isDisabled}
            {...stylex.props(styles.toggle)}
          >
            {isEnabled === true ? (
              <svg
                width="10"
                height="10"
                viewBox="0 0 12 12"
                style={{ color: tokens.accent }}
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
      {...stylex.props(styles.root)}
      value={value ?? NaN}
      onChange={(v) => onChange(Number.isNaN(v) === true ? undefined : v)}
      isDisabled={isDisabled}
    >
      <Label {...stylex.props(styles.label)}>{label}</Label>
      <Input {...stylex.props(styles.input)} id={id} />
      {hint !== undefined && (
        <Text slot="description" {...stylex.props(styles.description)}>
          {hint}
        </Text>
      )}
    </AriaNumberField>
  )
}
