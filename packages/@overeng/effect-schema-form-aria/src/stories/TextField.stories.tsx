import type { Meta, StoryObj } from '@storybook/react'
import { useState } from 'react'

import { TextField } from '../components/TextField.tsx'

export default {
  title: 'Components/TextField',
  component: TextField,
  tags: ['autodocs'],
  argTypes: {
    type: {
      control: 'select',
      options: ['text', 'email', 'password', 'url'],
    },
  },
} satisfies Meta<typeof TextField>

type Story = StoryObj<typeof TextField>

/** Default text input */
export const Default: Story = {
  args: {
    id: 'name',
    label: 'Name',
    value: '',
    placeholder: 'Enter your name',
  },
  render: (args) => {
    const [value, setValue] = useState(args.value)
    return <TextField {...args} value={value} onChange={setValue} />
  },
}

/** Text field with a pre-filled value */
export const WithValue: Story = {
  args: {
    id: 'name',
    label: 'Name',
    value: 'John Doe',
  },
  render: (args) => {
    const [value, setValue] = useState(args.value)
    return <TextField {...args} value={value} onChange={setValue} />
  },
}

/** Text field with hint/description text */
export const WithHint: Story = {
  args: {
    id: 'email',
    label: 'Email Address',
    value: '',
    hint: "We'll never share your email with anyone",
    type: 'email',
    placeholder: 'you@example.com',
  },
  render: (args) => {
    const [value, setValue] = useState(args.value)
    return <TextField {...args} value={value} onChange={setValue} />
  },
}

/** Password input type */
export const Password: Story = {
  args: {
    id: 'password',
    label: 'Password',
    value: '',
    type: 'password',
    placeholder: '••••••••',
    hint: 'Must be at least 8 characters',
  },
  render: (args) => {
    const [value, setValue] = useState(args.value)
    return <TextField {...args} value={value} onChange={setValue} />
  },
}

/** URL input type */
export const URL: Story = {
  args: {
    id: 'website',
    label: 'Website',
    value: '',
    type: 'url',
    placeholder: 'https://example.com',
  },
  render: (args) => {
    const [value, setValue] = useState(args.value)
    return <TextField {...args} value={value} onChange={setValue} />
  },
}

/** Disabled state */
export const Disabled: Story = {
  args: {
    id: 'readonly',
    label: 'Read Only Field',
    value: 'Cannot edit this value',
    isDisabled: true,
  },
  render: (args) => {
    const [value, setValue] = useState(args.value)
    return <TextField {...args} value={value} onChange={setValue} />
  },
}
