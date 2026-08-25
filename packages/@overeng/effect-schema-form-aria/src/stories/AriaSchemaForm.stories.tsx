import type { Meta, StoryObj } from '@storybook/react'
import { Schema } from 'effect'
import { useState } from 'react'

import { AriaSchemaForm } from '../AriaSchemaForm.tsx'

export default {
  title: 'Forms/AriaSchemaForm',
  component: AriaSchemaForm,
  tags: ['autodocs'],
} satisfies Meta<typeof AriaSchemaForm>

// ============================================================================
// Basic User Form
// ============================================================================

const UserSchema = Schema.Struct({
  name: Schema.String.annotate({
    title: 'Name',
    description: 'Your full name',
  }),
  email: Schema.String.annotate({ title: 'Email' }),
  age: Schema.optional(Schema.Finite).annotate({
    title: 'Age',
    description: 'Optional',
  }),
  role: Schema.Literals(['admin', 'user', 'guest']).annotate({ title: 'Role' }),
})

type User = typeof UserSchema.Type

const BasicFormRender = () => {
  const [value, setValue] = useState<User>({
    name: '',
    email: '',
    role: 'user',
  })
  return <AriaSchemaForm schema={UserSchema} value={value} onChange={setValue} />
}

/** Basic form with string, optional number, and literal fields */
export const BasicForm: StoryObj<typeof AriaSchemaForm<User>> = {
  render: BasicFormRender,
}

const WithValuesRender = () => {
  const [value, setValue] = useState<User>({
    name: 'John Doe',
    email: 'john@example.com',
    age: 30,
    role: 'admin',
  })
  return <AriaSchemaForm schema={UserSchema} value={value} onChange={setValue} />
}

/** Form with pre-filled values */
export const WithValues: StoryObj<typeof AriaSchemaForm<User>> = {
  render: WithValuesRender,
}

// ============================================================================
// Tagged Struct (Discriminated Union)
// ============================================================================

const LinkedInSchema = Schema.TaggedStruct('linkedin-contacts', {
  includeConnections: Schema.optional(Schema.Boolean).annotate({
    title: 'Include Connections',
    description: 'Import your LinkedIn connections',
  }),
  syncFrequency: Schema.Literals(['hourly', 'daily', 'weekly']).annotate({
    title: 'Sync Frequency',
  }),
})

type LinkedIn = typeof LinkedInSchema.Type

const TaggedStructRender = () => {
  const [value, setValue] = useState<LinkedIn>({
    _tag: 'linkedin-contacts',
    syncFrequency: 'daily',
  })
  return <AriaSchemaForm schema={LinkedInSchema} value={value} onChange={setValue} />
}

/** Tagged struct renders with a group header */
export const TaggedStruct: StoryObj<typeof AriaSchemaForm<LinkedIn>> = {
  render: TaggedStructRender,
}

const TaggedStructNoHeaderRender = () => {
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
}

/** Tagged struct without the header */
export const TaggedStructNoHeader: StoryObj<typeof AriaSchemaForm<LinkedIn>> = {
  render: TaggedStructNoHeaderRender,
}

// ============================================================================
// Empty Tagged Struct
// ============================================================================

const SimpleActionSchema = Schema.TaggedStruct('simple-action', {})

type SimpleAction = typeof SimpleActionSchema.Type

const EmptyTaggedStructRender = () => {
  const [value, setValue] = useState<SimpleAction>({
    _tag: 'simple-action',
  })
  return <AriaSchemaForm schema={SimpleActionSchema} value={value} onChange={setValue} />
}

/** Tagged struct with no fields shows empty state */
export const EmptyTaggedStruct: StoryObj<typeof AriaSchemaForm<SimpleAction>> = {
  render: EmptyTaggedStructRender,
}

// ============================================================================
// Settings Form (Boolean fields)
// ============================================================================

const SettingsSchema = Schema.Struct({
  darkMode: Schema.Boolean.annotate({
    title: 'Dark Mode',
    description: 'Enable dark theme',
  }),
  notifications: Schema.Boolean.annotate({ title: 'Notifications' }),
  language: Schema.Literals(['en', 'es', 'fr', 'de']).annotate({
    title: 'Language',
  }),
})

type Settings = typeof SettingsSchema.Type

const SettingsFormRender = () => {
  const [value, setValue] = useState<Settings>({
    darkMode: false,
    notifications: true,
    language: 'en',
  })
  return <AriaSchemaForm schema={SettingsSchema} value={value} onChange={setValue} />
}

/** Form with boolean fields */
export const SettingsForm: StoryObj<typeof AriaSchemaForm<Settings>> = {
  render: SettingsFormRender,
}

// ============================================================================
// Dropdown (Many Literal Options)
// ============================================================================

const CountrySchema = Schema.Struct({
  country: Schema.Literals(['us', 'uk', 'de', 'fr', 'es', 'it', 'nl', 'be', 'at', 'ch']).annotate({
    title: 'Country',
    description: 'Select your country',
  }),
})

type Country = typeof CountrySchema.Type

const DropdownFieldRender = () => {
  const [value, setValue] = useState<Country>({
    country: 'us',
  })
  return <AriaSchemaForm schema={CountrySchema} value={value} onChange={setValue} />
}

/** Literal with >5 options renders as dropdown */
export const DropdownField: StoryObj<typeof AriaSchemaForm<Country>> = {
  render: DropdownFieldRender,
}

// ============================================================================
// Complex Form
// ============================================================================

const ComplexSchema = Schema.Struct({
  firstName: Schema.String.annotate({ title: 'First Name' }),
  lastName: Schema.String.annotate({ title: 'Last Name' }),
  email: Schema.String.annotate({
    title: 'Email Address',
    description: 'Primary contact email',
  }),
  age: Schema.optional(Schema.Finite).annotate({ title: 'Age' }),
  subscribe: Schema.Boolean.annotate({
    title: 'Subscribe to newsletter',
    description: 'Receive weekly updates',
  }),
  plan: Schema.Literals(['free', 'pro', 'enterprise']).annotate({
    title: 'Plan',
  }),
  region: Schema.Literals([
    'us-east',
    'us-west',
    'eu-west',
    'eu-central',
    'ap-south',
    'ap-east',
  ]).annotate({
    title: 'Region',
    description: 'Primary deployment region',
  }),
})

type Complex = typeof ComplexSchema.Type

const ComplexFormRender = () => {
  const [value, setValue] = useState<Complex>({
    firstName: '',
    lastName: '',
    email: '',
    subscribe: false,
    plan: 'free',
    region: 'us-east',
  })
  return <AriaSchemaForm schema={ComplexSchema} value={value} onChange={setValue} />
}

/** Complex form with all field types */
export const ComplexForm: StoryObj<typeof AriaSchemaForm<Complex>> = {
  render: ComplexFormRender,
}
