import type { Meta, StoryObj } from '@storybook/react'
import { useState } from 'react'

import { BooleanField } from '../components/BooleanField.tsx'

const meta: Meta<typeof BooleanField> = {
  title: 'Components/BooleanField',
  component: BooleanField,
  tags: ['autodocs'],
}

export default meta
type Story = StoryObj<typeof BooleanField>

/** Unchecked checkbox */
export const Default: Story = {
  args: {
    id: 'subscribe',
    label: 'Subscribe to newsletter',
    value: false,
  },
  render: (args) => {
    const [value, setValue] = useState(args.value)
    return <BooleanField {...args} value={value} onChange={setValue} />
  },
}

/** Checked checkbox */
export const Checked: Story = {
  args: {
    id: 'agree',
    label: 'I agree to the terms and conditions',
    value: true,
  },
  render: (args) => {
    const [value, setValue] = useState(args.value)
    return <BooleanField {...args} value={value} onChange={setValue} />
  },
}

/** Checkbox with hint text */
export const WithHint: Story = {
  args: {
    id: 'notifications',
    label: 'Enable notifications',
    value: false,
    hint: 'You will receive email updates about your account activity',
  },
  render: (args) => {
    const [value, setValue] = useState(args.value)
    return <BooleanField {...args} value={value} onChange={setValue} />
  },
}

/** Disabled unchecked state */
export const DisabledUnchecked: Story = {
  args: {
    id: 'locked-off',
    label: 'This option is locked (off)',
    value: false,
    isDisabled: true,
  },
  render: (args) => {
    const [value, setValue] = useState(args.value)
    return <BooleanField {...args} value={value} onChange={setValue} />
  },
}

/** Disabled checked state */
export const DisabledChecked: Story = {
  args: {
    id: 'locked-on',
    label: 'This option is locked (on)',
    value: true,
    isDisabled: true,
  },
  render: (args) => {
    const [value, setValue] = useState(args.value)
    return <BooleanField {...args} value={value} onChange={setValue} />
  },
}
