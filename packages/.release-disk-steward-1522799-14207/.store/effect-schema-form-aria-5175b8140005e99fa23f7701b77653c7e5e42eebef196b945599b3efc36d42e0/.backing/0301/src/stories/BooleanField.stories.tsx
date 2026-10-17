import type { Meta, StoryObj } from '@storybook/react'
import { useState } from 'react'

import type { BooleanFieldProps } from '../components/BooleanField.tsx'
import { BooleanField } from '../components/BooleanField.tsx'

export default {
  title: 'Components/BooleanField',
  component: BooleanField,
  tags: ['autodocs'],
} satisfies Meta<typeof BooleanField>

type Story = StoryObj<typeof BooleanField>

const DefaultRender = (args: BooleanFieldProps) => {
  const [value, setValue] = useState(args.value)
  return <BooleanField {...args} value={value} onChange={setValue} />
}

/** Unchecked checkbox */
export const Default: Story = {
  args: {
    id: 'subscribe',
    label: 'Subscribe to newsletter',
    value: false,
  },
  render: DefaultRender,
}

const CheckedRender = (args: BooleanFieldProps) => {
  const [value, setValue] = useState(args.value)
  return <BooleanField {...args} value={value} onChange={setValue} />
}

/** Checked checkbox */
export const Checked: Story = {
  args: {
    id: 'agree',
    label: 'I agree to the terms and conditions',
    value: true,
  },
  render: CheckedRender,
}

const WithHintRender = (args: BooleanFieldProps) => {
  const [value, setValue] = useState(args.value)
  return <BooleanField {...args} value={value} onChange={setValue} />
}

/** Checkbox with hint text */
export const WithHint: Story = {
  args: {
    id: 'notifications',
    label: 'Enable notifications',
    value: false,
    hint: 'You will receive email updates about your account activity',
  },
  render: WithHintRender,
}

const DisabledUncheckedRender = (args: BooleanFieldProps) => {
  const [value, setValue] = useState(args.value)
  return <BooleanField {...args} value={value} onChange={setValue} />
}

/** Disabled unchecked state */
export const DisabledUnchecked: Story = {
  args: {
    id: 'locked-off',
    label: 'This option is locked (off)',
    value: false,
    isDisabled: true,
  },
  render: DisabledUncheckedRender,
}

const DisabledCheckedRender = (args: BooleanFieldProps) => {
  const [value, setValue] = useState(args.value)
  return <BooleanField {...args} value={value} onChange={setValue} />
}

/** Disabled checked state */
export const DisabledChecked: Story = {
  args: {
    id: 'locked-on',
    label: 'This option is locked (on)',
    value: true,
    isDisabled: true,
  },
  render: DisabledCheckedRender,
}
