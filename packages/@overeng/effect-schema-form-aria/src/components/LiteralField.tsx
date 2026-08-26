import * as stylex from '@stylexjs/stylex'
import type { ReactNode } from 'react'
import {
  Button,
  Label,
  ListBox,
  ListBoxItem,
  Popover,
  Select,
  SelectValue,
  ToggleButton,
  ToggleButtonGroup,
} from 'react-aria-components'
import { fontSizes, radii, spacing } from 'tailwind-stylex/tokens.stylex'

import { formatLiteralLabel } from '@overeng/effect-schema-form'

import { tokens } from '../tokens.stylex.ts'
import { FieldWrapper } from './FieldWrapper.tsx'

/** Maximum number of options before switching from segmented control to select */
const MAX_SEGMENTED_OPTIONS = 5

/** Props for LiteralField component */
export interface LiteralFieldProps {
  /** Unique identifier for the field */
  id: string
  /** Label text */
  label?: string | undefined
  /** Current value */
  value: string | undefined
  /** Called when value changes */
  onChange: (value: string | undefined) => void
  /** Available literal options */
  literals: readonly string[]
  /** Hint/description text */
  hint?: string | undefined
  /** Whether the field is optional */
  isOptional?: boolean | undefined
  /** Whether the field is disabled */
  isDisabled?: boolean | undefined
}

const styles = stylex.create({
  group: {
    display: 'grid',
    rowGap: spacing[1],
  },
  label: {
    fontSize: fontSizes.sm,
    lineHeight: '1.25rem',
    color: tokens.ink,
  },
  segmentedGroup: {
    display: 'flex',
    borderRadius: radii.lg,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: tokens.border,
    overflow: 'hidden',
  },
  segment: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    paddingInline: spacing[3],
    paddingBlock: spacing['1.5'],
    fontSize: fontSizes.sm,
    lineHeight: '1.25rem',
    color: tokens.ink,
    backgroundColor: tokens.surface,
    borderRightWidth: 1,
    borderRightStyle: 'solid',
    borderRightColor: tokens.border,
    transitionProperty: 'background-color, color',
    transitionDuration: '150ms',
    ':hover': {
      backgroundColor: tokens['surface-raised'],
    },
    ':last-child': {
      borderRightWidth: 0,
    },
  },
  segmentSelected: {
    backgroundColor: tokens.primary,
    color: '#ffffff',
  },
  root: {
    display: 'grid',
    rowGap: spacing['1.5'],
  },
  trigger: {
    width: '100%',
    paddingInline: spacing['2.5'],
    paddingBlock: spacing[2],
    fontSize: fontSizes.sm,
    lineHeight: '1.25rem',
    textAlign: 'left',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderRadius: radii.default,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: tokens.border,
    backgroundColor: tokens.input,
    color: tokens.ink,
    outline: 'none',
    ':focus': {
      boxShadow: `0 0 0 1px ${tokens.primary}`,
    },
    ':disabled': {
      opacity: 0.5,
    },
  },
  triggerValue: {
    flexGrow: 1,
  },
  chevron: {
    width: '1rem',
    height: '1rem',
    color: tokens['subtle-ink'],
  },
  popover: {
    width: 'var(--trigger-width)',
    overflow: 'hidden',
    borderRadius: radii.lg,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: tokens.border,
    backgroundColor: tokens.surface,
    boxShadow: '0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)',
  },
  listBox: {
    outline: 'none',
    padding: spacing[1],
    maxHeight: 'calc(var(--spacing, 0.25rem) * 60)',
    overflow: 'auto',
  },
  option: {
    paddingInline: spacing['2.5'],
    paddingBlock: spacing['1.5'],
    fontSize: fontSizes.sm,
    lineHeight: '1.25rem',
    cursor: 'pointer',
    borderRadius: radii.default,
    ':hover': {
      backgroundColor: tokens['surface-raised'],
    },
  },
  optionMuted: {
    color: tokens['subtle-ink'],
  },
  optionInk: {
    color: tokens.ink,
  },
  optionSelected: {
    backgroundColor: tokens.primary,
    color: '#ffffff',
  },
  hint: {
    fontSize: '12px',
    color: tokens['subtle-ink'],
  },
})

/**
 * Literal union field.
 * Renders a segmented toggle control for small option sets and a select dropdown for larger ones.
 */
export const LiteralField = ({
  id,
  label,
  value,
  onChange,
  literals,
  hint,
  isOptional = false,
  isDisabled = false,
}: LiteralFieldProps): ReactNode => {
  const options = literals.map((lit) => ({
    value: lit,
    label: formatLiteralLabel(lit),
  }))

  const segmentedOptions = isOptional === true ? [{ value: '', label: '—' }, ...options] : options

  // Use segmented control for small option sets
  if (segmentedOptions.length <= MAX_SEGMENTED_OPTIONS) {
    return (
      <FieldWrapper description={hint}>
        <div {...stylex.props(styles.group)}>
          {label !== undefined && <span {...stylex.props(styles.label)}>{label}</span>}
          <ToggleButtonGroup
            aria-label={label ?? id}
            selectionMode="single"
            selectedKeys={value !== undefined ? [value] : isOptional === true ? [''] : []}
            onSelectionChange={(keys) => {
              const selected = [...keys][0]
              onChange(selected === '' || selected === undefined ? undefined : String(selected))
            }}
            isDisabled={isDisabled}
            {...stylex.props(styles.segmentedGroup)}
          >
            {segmentedOptions.map((opt) => (
              <ToggleButton
                key={opt.value}
                id={opt.value}
                className={({ isSelected }) =>
                  stylex.props(styles.segment, isSelected === true && styles.segmentSelected)
                    .className ?? ''
                }
              >
                {opt.label}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
        </div>
      </FieldWrapper>
    )
  }

  // Use select dropdown for larger option sets
  return (
    <Select
      id={id}
      value={value ?? null}
      onChange={(key) =>
        onChange(key === '' || key === null || key === undefined ? undefined : String(key))
      }
      isDisabled={isDisabled}
      {...stylex.props(styles.root)}
    >
      {label !== undefined && <Label {...stylex.props(styles.label)}>{label}</Label>}
      <Button {...stylex.props(styles.trigger)}>
        <SelectValue {...stylex.props(styles.triggerValue)} />
        <svg viewBox="0 0 16 16" {...stylex.props(styles.chevron)} aria-hidden="true">
          <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" fill="none" />
        </svg>
      </Button>
      <Popover {...stylex.props(styles.popover)}>
        <ListBox {...stylex.props(styles.listBox)}>
          {isOptional && (
            <ListBoxItem
              id=""
              textValue="— Select —"
              className={({ isSelected }) =>
                stylex.props(
                  styles.option,
                  styles.optionMuted,
                  isSelected === true && styles.optionSelected,
                ).className ?? ''
              }
            >
              — Select —
            </ListBoxItem>
          )}
          {options.map((opt) => (
            <ListBoxItem
              key={opt.value}
              id={opt.value}
              textValue={opt.label}
              className={({ isSelected }) =>
                stylex.props(
                  styles.option,
                  styles.optionInk,
                  isSelected === true && styles.optionSelected,
                ).className ?? ''
              }
            >
              {opt.label}
            </ListBoxItem>
          ))}
        </ListBox>
      </Popover>
      {hint !== undefined && <span {...stylex.props(styles.hint)}>{hint}</span>}
    </Select>
  )
}
