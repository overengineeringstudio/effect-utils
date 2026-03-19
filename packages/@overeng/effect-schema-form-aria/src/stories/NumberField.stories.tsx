import type { Meta, StoryObj } from '@storybook/react'
import { useState } from 'react'

import type { NumberFieldProps } from '../components/NumberField.tsx'
import { NumberField } from '../components/NumberField.tsx'

export default {
  title: 'Components/NumberField',
  component: NumberField,
  tags: ['autodocs'],
} satisfies Meta<typeof NumberField>

type Story = StoryObj<typeof NumberField>

const DefaultRender = (args: NumberFieldProps) => {
  const [value, setValue] = useState(args.value)
  return <NumberField {...args} value={value} onChange={setValue} />
}

/** Required number field with standard input */
export const Default: Story = {
  args: {
    id: 'age',
    label: 'Age',
    value: 25,
  },
  render: DefaultRender,
}

const WithHintRender = (args: NumberFieldProps) => {
  const [value, setValue] = useState(args.value)
  return <NumberField {...args} value={value} onChange={setValue} />
}

/** Number field with hint text */
export const WithHint: Story = {
  args: {
    id: 'quantity',
    label: 'Quantity',
    value: 1,
    hint: 'Enter the number of items (1-100)',
  },
  render: WithHintRender,
}

const OptionalDisabledRender = (args: NumberFieldProps) => {
  const [value, setValue] = useState(args.value)
  return <NumberField {...args} value={value} onChange={setValue} />
}

/** Optional field with toggle - starts disabled (undefined) */
export const OptionalDisabled: Story = {
  args: {
    id: 'limit',
    label: 'Limit',
    value: undefined,
    isOptional: true,
    hint: 'Leave unchecked for no limit',
  },
  render: OptionalDisabledRender,
}

const OptionalEnabledRender = (args: NumberFieldProps) => {
  const [value, setValue] = useState(args.value)
  return <NumberField {...args} value={value} onChange={setValue} />
}

/** Optional field with toggle - starts enabled with a value */
export const OptionalEnabled: Story = {
  args: {
    id: 'maxItems',
    label: 'Max Items',
    value: 100,
    isOptional: true,
    hint: 'Click checkbox to toggle',
  },
  render: OptionalEnabledRender,
}

const DisabledRender = (args: NumberFieldProps) => {
  const [value, setValue] = useState(args.value)
  return <NumberField {...args} value={value} onChange={setValue} />
}

/** Disabled state */
export const Disabled: Story = {
  args: {
    id: 'readonly',
    label: 'Read Only',
    value: 42,
    isDisabled: true,
  },
  render: DisabledRender,
}

const OptionalAndDisabledRender = (args: NumberFieldProps) => {
  const [value, setValue] = useState(args.value)
  return <NumberField {...args} value={value} onChange={setValue} />
}

/** Optional field that is also disabled */
export const OptionalAndDisabled: Story = {
  args: {
    id: 'locked',
    label: 'Locked Optional',
    value: 50,
    isOptional: true,
    isDisabled: true,
  },
  render: OptionalAndDisabledRender,
}
