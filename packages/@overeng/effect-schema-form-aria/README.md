# @overeng/effect-schema-form-aria

Styled React Aria implementation for `@overeng/effect-schema-form`. Provides accessible, styled form components using React Aria Components and Tailwind CSS.

[**Storybook**](https://overeng-effect-utils-schema-form-ar.vercel.app) - Interactive component documentation and examples

## Installation

```bash
bun add @overeng/effect-schema-form-aria @overeng/effect-schema-form react-aria-components
```

## Usage

### Quick Start

```tsx
import { AriaSchemaForm } from '@overeng/effect-schema-form-aria'
import { Schema } from 'effect'

const UserSchema = Schema.Struct({
  name: Schema.String.annotations({ title: 'Name', description: 'Your full name' }),
  age: Schema.optional(Schema.Number).annotations({ title: 'Age' }),
  role: Schema.Literal('admin', 'user', 'guest'),
})

const App = () => {
  const [user, setUser] = useState({ name: '', role: 'user' })

  return <AriaSchemaForm schema={UserSchema} value={user} onChange={setUser} />
}
```

### With Provider Pattern

Use this when you want to apply the same renderers across multiple forms:

```tsx
import { SchemaFormProvider, SchemaForm } from '@overeng/effect-schema-form'
import { ariaRenderers } from '@overeng/effect-schema-form-aria'
;<SchemaFormProvider renderers={ariaRenderers}>
  <SchemaForm schema={FormA} value={dataA} onChange={setDataA} />
  <SchemaForm schema={FormB} value={dataB} onChange={setDataB} />
</SchemaFormProvider>
```

### Tagged Structs

Tagged structs (discriminated unions) are automatically rendered with a labeled group:

```tsx
const LinkedInSchema = Schema.TaggedStruct('linkedin-contacts', {
  includeConnections: Schema.optional(Schema.Boolean),
  syncFrequency: Schema.Literal('hourly', 'daily', 'weekly'),
})

// Renders with "LinkedIn Contacts" header
<AriaSchemaForm schema={LinkedInSchema} value={data} onChange={setData} />

// Hide the tag header
<AriaSchemaForm schema={LinkedInSchema} value={data} onChange={setData} showTagHeader={false} />
```

## Components

All components are exported for building custom field renderers:

```tsx
import {
  TextField,
  NumberField,
  BooleanField,
  LiteralField,
  FieldWrapper,
  FieldGroup,
} from '@overeng/effect-schema-form-aria'
```

### TextField

```tsx
<TextField
  id="email"
  label="Email Address"
  value={email}
  onChange={setEmail}
  hint="We'll never share your email"
  type="email"
  placeholder="you@example.com"
/>
```

### NumberField

```tsx
// Required number field
<NumberField
  id="quantity"
  label="Quantity"
  value={quantity}
  onChange={setQuantity}
/>

// Optional number field (shows toggle)
<NumberField
  id="limit"
  label="Limit"
  value={limit}
  onChange={setLimit}
  isOptional
  hint="Leave unchecked for no limit"
/>
```

### BooleanField

```tsx
<BooleanField
  id="subscribe"
  label="Subscribe to newsletter"
  value={subscribed}
  onChange={setSubscribed}
  hint="Get weekly updates"
/>
```

### LiteralField

Automatically renders as segmented control (5 or fewer options) or dropdown (more options):

```tsx
<LiteralField
  id="priority"
  label="Priority"
  value={priority}
  onChange={setPriority}
  literals={['low', 'medium', 'high']}
  hint="Select task priority"
/>
```

### FieldGroup

```tsx
<FieldGroup label="Contact Details" variant="subtle">
  <TextField ... />
  <TextField ... />
</FieldGroup>
```

## Styling

Components use Tailwind CSS with semantic design tokens. Ensure your app defines these CSS variables:

```css
:root {
  --color-ink: /* text color */;
  --color-subtle-ink: /* secondary text */;
  --color-muted-ink: /* muted text */;
  --color-border: /* border color */;
  --color-input: /* input background */;
  --color-surface: /* surface background */;
  --color-surface-raised: /* hover state */;
  --color-primary: /* accent color */;
  --color-accent: /* accent color */;
}
```

Or customize the components by overriding the className props or creating your own renderers.

## Custom Renderers

Override specific field types while keeping the rest:

```tsx
import { ariaRenderers } from '@overeng/effect-schema-form-aria'
import { SchemaFormProvider, SchemaForm } from '@overeng/effect-schema-form'

const customRenderers = {
  ...ariaRenderers,
  string: ({ fieldKey, meta, value, onChange }) => (
    <MyCustomTextField
      label={meta.title ?? fieldKey}
      value={value ?? ''}
      onChange={onChange}
    />
  ),
}

<SchemaFormProvider renderers={customRenderers}>
  <SchemaForm schema={MySchema} value={data} onChange={setData} />
</SchemaFormProvider>
```
