import type { Meta, StoryObj } from '@storybook/react'
import { useState } from 'react'

import type { TextFieldProps } from '../components/TextField.tsx'
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

const DefaultRender = (args: TextFieldProps) => {
  const [value, setValue] = useState(args.value)
  return <TextField {...args} value={value} onChange={setValue} />
}

/** Default text input */
export const Default: Story = {
  args: {
    id: 'name',
    label: 'Name',
    value: '',
    placeholder: 'Enter your name',
  },
  render: DefaultRender,
}

const WithValueRender = (args: TextFieldProps) => {
  const [value, setValue] = useState(args.value)
  return <TextField {...args} value={value} onChange={setValue} />
}

/** Text field with a pre-filled value */
export const WithValue: Story = {
  args: {
    id: 'name',
    label: 'Name',
    value: 'John Doe',
  },
  render: WithValueRender,
}

const WithHintRender = (args: TextFieldProps) => {
  const [value, setValue] = useState(args.value)
  return <TextField {...args} value={value} onChange={setValue} />
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
  render: WithHintRender,
}

const PasswordRender = (args: TextFieldProps) => {
  const [value, setValue] = useState(args.value)
  return <TextField {...args} value={value} onChange={setValue} />
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
  render: PasswordRender,
}

const URLRender = (args: TextFieldProps) => {
  const [value, setValue] = useState(args.value)
  return <TextField {...args} value={value} onChange={setValue} />
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
  render: URLRender,
}

const DisabledRender = (args: TextFieldProps) => {
  const [value, setValue] = useState(args.value)
  return <TextField {...args} value={value} onChange={setValue} />
}

/** Disabled state */
export const Disabled: Story = {
  args: {
    id: 'readonly',
    label: 'Read Only Field',
    value: 'Cannot edit this value',
    isDisabled: true,
  },
  render: DisabledRender,
}
