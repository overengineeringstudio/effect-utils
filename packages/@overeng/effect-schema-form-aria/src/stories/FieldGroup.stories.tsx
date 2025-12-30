import type { Meta, StoryObj } from '@storybook/react'
import { useState } from 'react'

import { BooleanField } from '../components/BooleanField.tsx'
import { FieldGroup, FieldGroupEmpty } from '../components/FieldGroup.tsx'
import { LiteralField } from '../components/LiteralField.tsx'
import { TextField } from '../components/TextField.tsx'

const meta: Meta<typeof FieldGroup> = {
  title: 'Components/FieldGroup',
  component: FieldGroup,
  tags: ['autodocs'],
}

export default meta
type Story = StoryObj<typeof FieldGroup>

/** Default variant with border and background */
export const Default: Story = {
  args: {
    label: 'Contact Information',
    variant: 'default',
  },
  render: (args) => {
    const [name, setName] = useState('')
    const [email, setEmail] = useState('')
    return (
      <FieldGroup {...args}>
        <TextField id="name" label="Name" value={name} onChange={setName} />
        <TextField id="email" label="Email" value={email} onChange={setEmail} type="email" />
      </FieldGroup>
    )
  },
}

/** Subtle variant with lighter styling */
export const Subtle: Story = {
  args: {
    label: 'LinkedIn Contacts',
    variant: 'subtle',
  },
  render: (args) => {
    const [connections, setConnections] = useState(true)
    const [messages, setMessages] = useState(false)
    return (
      <FieldGroup {...args}>
        <BooleanField
          id="connections"
          label="Include connections"
          value={connections}
          onChange={setConnections}
        />
        <BooleanField
          id="messages"
          label="Include messages"
          value={messages}
          onChange={setMessages}
        />
      </FieldGroup>
    )
  },
}

/** Group with mixed field types */
export const MixedFields: Story = {
  args: {
    label: 'User Settings',
    variant: 'default',
  },
  render: (args) => {
    const [name, setName] = useState('John Doe')
    const [notifications, setNotifications] = useState(true)
    const [theme, setTheme] = useState<string | undefined>('light')
    return (
      <FieldGroup {...args}>
        <TextField id="display-name" label="Display Name" value={name} onChange={setName} />
        <BooleanField
          id="notifications"
          label="Enable notifications"
          value={notifications}
          onChange={setNotifications}
        />
        <LiteralField
          id="theme"
          label="Theme"
          value={theme}
          onChange={setTheme}
          literals={['light', 'dark', 'system']}
        />
      </FieldGroup>
    )
  },
}

/** Empty field group with custom message */
export const Empty: StoryObj<typeof FieldGroupEmpty> = {
  render: () => (
    <FieldGroupEmpty label="Simple Action" message="This action has no configuration options" />
  ),
}

/** Empty field group with default message */
export const EmptyDefaultMessage: StoryObj<typeof FieldGroupEmpty> = {
  render: () => <FieldGroupEmpty label="Quick Export" />,
}

/** Nested groups */
export const Nested: Story = {
  args: {
    label: 'Account Settings',
    variant: 'default',
  },
  render: (args) => {
    const [email, setEmail] = useState('')
    const [marketing, setMarketing] = useState(false)
    const [security, setSecurity] = useState(true)
    return (
      <FieldGroup {...args}>
        <TextField
          id="account-email"
          label="Email"
          value={email}
          onChange={setEmail}
          type="email"
        />
        <FieldGroup label="Notifications" variant="subtle">
          <BooleanField
            id="marketing"
            label="Marketing emails"
            value={marketing}
            onChange={setMarketing}
          />
          <BooleanField
            id="security"
            label="Security alerts"
            value={security}
            onChange={setSecurity}
          />
        </FieldGroup>
      </FieldGroup>
    )
  },
}
