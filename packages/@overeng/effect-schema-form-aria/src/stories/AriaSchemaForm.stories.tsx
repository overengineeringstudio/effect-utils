import type { Meta, StoryObj } from '@storybook/react'
import { Schema } from 'effect'
import { useState } from 'react'

import { AriaSchemaForm } from '../AriaSchemaForm.tsx'

const meta: Meta<typeof AriaSchemaForm> = {
  title: 'Forms/AriaSchemaForm',
  component: AriaSchemaForm,
  tags: ['autodocs'],
}

export default meta

// ============================================================================
// Basic User Form
// ============================================================================

const UserSchema = Schema.Struct({
  name: Schema.String.annotations({
    title: 'Name',
    description: 'Your full name',
  }),
  email: Schema.String.annotations({ title: 'Email' }),
  age: Schema.optional(Schema.Number).annotations({
    title: 'Age',
    description: 'Optional',
  }),
  role: Schema.Literal('admin', 'user', 'guest').annotations({ title: 'Role' }),
})

type User = typeof UserSchema.Type

/** Basic form with string, optional number, and literal fields */
export const BasicForm: StoryObj<typeof AriaSchemaForm<User>> = {
  render: () => {
    const [value, setValue] = useState<User>({
      name: '',
      email: '',
      role: 'user',
    })
    return <AriaSchemaForm schema={UserSchema} value={value} onChange={setValue} />
  },
}

/** Form with pre-filled values */
export const WithValues: StoryObj<typeof AriaSchemaForm<User>> = {
  render: () => {
    const [value, setValue] = useState<User>({
      name: 'John Doe',
      email: 'john@example.com',
      age: 30,
      role: 'admin',
    })
    return <AriaSchemaForm schema={UserSchema} value={value} onChange={setValue} />
  },
}

// ============================================================================
// Tagged Struct (Discriminated Union)
// ============================================================================

const LinkedInSchema = Schema.TaggedStruct('linkedin-contacts', {
  includeConnections: Schema.optional(Schema.Boolean).annotations({
    title: 'Include Connections',
    description: 'Import your LinkedIn connections',
  }),
  syncFrequency: Schema.Literal('hourly', 'daily', 'weekly').annotations({
    title: 'Sync Frequency',
  }),
})

type LinkedIn = typeof LinkedInSchema.Type

/** Tagged struct renders with a group header */
export const TaggedStruct: StoryObj<typeof AriaSchemaForm<LinkedIn>> = {
  render: () => {
    const [value, setValue] = useState<LinkedIn>({
      _tag: 'linkedin-contacts',
      syncFrequency: 'daily',
    })
    return <AriaSchemaForm schema={LinkedInSchema} value={value} onChange={setValue} />
  },
}

/** Tagged struct without the header */
export const TaggedStructNoHeader: StoryObj<typeof AriaSchemaForm<LinkedIn>> = {
  render: () => {
    const [value, setValue] = useState<LinkedIn>({
      _tag: 'linkedin-contacts',
      syncFrequency: 'weekly',
      includeConnections: true,
    })
    return (
      <AriaSchemaForm
        schema={LinkedInSchema}
        value={value}
        onChange={setValue}
        showTagHeader={false}
      />
    )
  },
}

// ============================================================================
// Empty Tagged Struct
// ============================================================================

const SimpleActionSchema = Schema.TaggedStruct('simple-action', {})

type SimpleAction = typeof SimpleActionSchema.Type

/** Tagged struct with no fields shows empty state */
export const EmptyTaggedStruct: StoryObj<typeof AriaSchemaForm<SimpleAction>> = {
  render: () => {
    const [value, setValue] = useState<SimpleAction>({
      _tag: 'simple-action',
    })
    return <AriaSchemaForm schema={SimpleActionSchema} value={value} onChange={setValue} />
  },
}

// ============================================================================
// Settings Form (Boolean fields)
// ============================================================================

const SettingsSchema = Schema.Struct({
  darkMode: Schema.Boolean.annotations({
    title: 'Dark Mode',
    description: 'Enable dark theme',
  }),
  notifications: Schema.Boolean.annotations({ title: 'Notifications' }),
  language: Schema.Literal('en', 'es', 'fr', 'de').annotations({
    title: 'Language',
  }),
})

type Settings = typeof SettingsSchema.Type

/** Form with boolean fields */
export const SettingsForm: StoryObj<typeof AriaSchemaForm<Settings>> = {
  render: () => {
    const [value, setValue] = useState<Settings>({
      darkMode: false,
      notifications: true,
      language: 'en',
    })
    return <AriaSchemaForm schema={SettingsSchema} value={value} onChange={setValue} />
  },
}

// ============================================================================
// Dropdown (Many Literal Options)
// ============================================================================

const CountrySchema = Schema.Struct({
  country: Schema.Literal('us', 'uk', 'de', 'fr', 'es', 'it', 'nl', 'be', 'at', 'ch').annotations({
    title: 'Country',
    description: 'Select your country',
  }),
})

type Country = typeof CountrySchema.Type

/** Literal with >5 options renders as dropdown */
export const DropdownField: StoryObj<typeof AriaSchemaForm<Country>> = {
  render: () => {
    const [value, setValue] = useState<Country>({
      country: 'us',
    })
    return <AriaSchemaForm schema={CountrySchema} value={value} onChange={setValue} />
  },
}

// ============================================================================
// Complex Form
// ============================================================================

const ComplexSchema = Schema.Struct({
  firstName: Schema.String.annotations({ title: 'First Name' }),
  lastName: Schema.String.annotations({ title: 'Last Name' }),
  email: Schema.String.annotations({
    title: 'Email Address',
    description: 'Primary contact email',
  }),
  age: Schema.optional(Schema.Number).annotations({ title: 'Age' }),
  subscribe: Schema.Boolean.annotations({
    title: 'Subscribe to newsletter',
    description: 'Receive weekly updates',
  }),
  plan: Schema.Literal('free', 'pro', 'enterprise').annotations({
    title: 'Plan',
  }),
  region: Schema.Literal(
    'us-east',
    'us-west',
    'eu-west',
    'eu-central',
    'ap-south',
    'ap-east',
  ).annotations({
    title: 'Region',
    description: 'Primary deployment region',
  }),
})

type Complex = typeof ComplexSchema.Type

/** Complex form with all field types */
export const ComplexForm: StoryObj<typeof AriaSchemaForm<Complex>> = {
  render: () => {
    const [value, setValue] = useState<Complex>({
      firstName: '',
      lastName: '',
      email: '',
      subscribe: false,
      plan: 'free',
      region: 'us-east',
    })
    return <AriaSchemaForm schema={ComplexSchema} value={value} onChange={setValue} />
  },
}
