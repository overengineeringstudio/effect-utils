import type { Meta, StoryObj } from '@storybook/react'
import { useState } from 'react'

import type { LiteralFieldProps } from '../components/LiteralField.tsx'
import { LiteralField } from '../components/LiteralField.tsx'

export default {
  title: 'Components/LiteralField',
  component: LiteralField,
  tags: ['autodocs'],
} satisfies Meta<typeof LiteralField>

type Story = StoryObj<typeof LiteralField>

const SegmentedThreeOptionsRender = (args: LiteralFieldProps) => {
  const [value, setValue] = useState(args.value)
  return <LiteralField {...args} value={value} onChange={setValue} />
}

/** Segmented control with 3 options */
export const SegmentedThreeOptions: Story = {
  args: {
    id: 'priority',
    label: 'Priority',
    value: 'medium',
    literals: ['low', 'medium', 'high'],
  },
  render: SegmentedThreeOptionsRender,
}

const SegmentedFiveOptionsRender = (args: LiteralFieldProps) => {
  const [value, setValue] = useState(args.value)
  return <LiteralField {...args} value={value} onChange={setValue} />
}

/** Segmented control with 5 options (max before dropdown) */
export const SegmentedFiveOptions: Story = {
  args: {
    id: 'size',
    label: 'Size',
    value: 'medium',
    literals: ['xs', 'small', 'medium', 'large', 'xl'],
    hint: 'Maximum 5 options renders as segmented control',
  },
  render: SegmentedFiveOptionsRender,
}

const DropdownRender = (args: LiteralFieldProps) => {
  const [value, setValue] = useState(args.value)
  return <LiteralField {...args} value={value} onChange={setValue} />
}

/** Dropdown with more than 5 options */
export const Dropdown: Story = {
  args: {
    id: 'country',
    label: 'Country',
    value: 'us',
    literals: ['us', 'uk', 'de', 'fr', 'es', 'it', 'nl', 'be'],
    hint: 'More than 5 options renders as dropdown',
  },
  render: DropdownRender,
}

const OptionalSegmentedRender = (args: LiteralFieldProps) => {
  const [value, setValue] = useState(args.value)
  return <LiteralField {...args} value={value} onChange={setValue} />
}

/** Optional segmented control with "—" option */
export const OptionalSegmented: Story = {
  args: {
    id: 'frequency',
    label: 'Sync Frequency',
    value: undefined,
    literals: ['hourly', 'daily', 'weekly'],
    isOptional: true,
    hint: 'Optional field shows "—" option',
  },
  render: OptionalSegmentedRender,
}

const OptionalDropdownRender = (args: LiteralFieldProps) => {
  const [value, setValue] = useState(args.value)
  return <LiteralField {...args} value={value} onChange={setValue} />
}

/** Optional dropdown with "Select" option */
export const OptionalDropdown: Story = {
  args: {
    id: 'timezone',
    label: 'Timezone',
    value: undefined,
    literals: ['utc', 'est', 'cst', 'mst', 'pst', 'hst'],
    isOptional: true,
    hint: 'Optional dropdown shows "— Select —" option',
  },
  render: OptionalDropdownRender,
}

const NoLabelRender = (args: LiteralFieldProps) => {
  const [value, setValue] = useState(args.value)
  return <LiteralField {...args} value={value} onChange={setValue} />
}

/** Without label */
export const NoLabel: Story = {
  args: {
    id: 'status',
    value: 'active',
    literals: ['active', 'inactive'],
  },
  render: NoLabelRender,
}

const DisabledRender = (args: LiteralFieldProps) => {
  const [value, setValue] = useState(args.value)
  return <LiteralField {...args} value={value} onChange={setValue} />
}

/** Disabled state */
export const Disabled: Story = {
  args: {
    id: 'role',
    label: 'Role',
    value: 'user',
    literals: ['admin', 'user', 'guest'],
    isDisabled: true,
  },
  render: DisabledRender,
}

const DisabledDropdownRender = (args: LiteralFieldProps) => {
  const [value, setValue] = useState(args.value)
  return <LiteralField {...args} value={value} onChange={setValue} />
}

/** Disabled dropdown */
export const DisabledDropdown: Story = {
  args: {
    id: 'region',
    label: 'Region',
    value: 'europe',
    literals: ['north-america', 'south-america', 'europe', 'asia', 'africa', 'oceania'],
    isDisabled: true,
  },
  render: DisabledDropdownRender,
}
