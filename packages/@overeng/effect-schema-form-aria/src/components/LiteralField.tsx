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

import { formatLiteralLabel } from '@overeng/effect-schema-form'

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

/**
 * Literal union field.
 *
 * Renders as a segmented control for 5 or fewer options,
 * or as a select dropdown for more options.
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

  const segmentedOptions = isOptional ? [{ value: '', label: '—' }, ...options] : options

  // Use segmented control for small option sets
  if (segmentedOptions.length <= MAX_SEGMENTED_OPTIONS) {
    return (
      <FieldWrapper description={hint}>
        <div className="grid gap-1">
          {label !== undefined && <span className="text-sm text-ink">{label}</span>}
          <ToggleButtonGroup
            aria-label={label ?? id}
            selectionMode="single"
            selectedKeys={value !== undefined ? [value] : isOptional ? [''] : []}
            onSelectionChange={(keys) => {
              const selected = [...keys][0]
              onChange(selected === '' || selected === undefined ? undefined : String(selected))
            }}
            isDisabled={isDisabled}
            className="flex rounded-lg border border-border overflow-hidden"
          >
            {segmentedOptions.map((opt) => (
              <ToggleButton
                key={opt.value}
                id={opt.value}
                className="flex-1 px-3 py-1.5 text-sm text-ink bg-surface hover:bg-surface-raised data-[selected]:bg-primary data-[selected]:text-white transition-colors border-r border-border last:border-r-0"
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
      className="grid gap-1.5"
    >
      {label !== undefined && <Label className="text-sm text-ink">{label}</Label>}
      <Button className="w-full px-2.5 py-2 text-sm rounded border border-border bg-input text-ink text-left flex items-center justify-between focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50">
        <SelectValue className="flex-1" />
        <svg viewBox="0 0 16 16" className="size-4 text-subtle-ink" aria-hidden="true">
          <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" fill="none" />
        </svg>
      </Button>
      <Popover className="w-[--trigger-width] overflow-hidden rounded-lg border border-border bg-surface shadow-lg">
        <ListBox className="outline-none p-1 max-h-60 overflow-auto">
          {isOptional && (
            <ListBoxItem
              id=""
              className="px-2.5 py-1.5 text-sm text-subtle-ink cursor-pointer rounded hover:bg-surface-raised data-[selected]:bg-primary data-[selected]:text-white"
            >
              — Select —
            </ListBoxItem>
          )}
          {options.map((opt) => (
            <ListBoxItem
              key={opt.value}
              id={opt.value}
              className="px-2.5 py-1.5 text-sm text-ink cursor-pointer rounded hover:bg-surface-raised data-[selected]:bg-primary data-[selected]:text-white"
            >
              {opt.label}
            </ListBoxItem>
          ))}
        </ListBox>
      </Popover>
      {hint !== undefined && <span className="text-[12px] text-subtle-ink">{hint}</span>}
    </Select>
  )
}
