# @overeng/effect-schema-form

Headless form component for Effect Schemas. Automatically generates form fields based on schema structure with full customization support.

## Installation

```bash
bun add @overeng/effect-schema-form
```

## Usage

### With Custom Renderers

```tsx
import { SchemaForm, SchemaFormProvider } from '@overeng/effect-schema-form'
import { Schema } from 'effect'

const UserSchema = Schema.Struct({
  name: Schema.String.annotations({ title: 'Name', description: 'Your full name' }),
  age: Schema.optional(Schema.Number).annotations({ title: 'Age' }),
  role: Schema.Literal('admin', 'user', 'guest'),
})

// Define custom renderers for each field type
const myRenderers = {
  string: ({ fieldKey, meta, value, onChange }) => (
    <input
      type="text"
      value={value ?? ''}
      onChange={e => onChange(e.target.value)}
      placeholder={meta.title}
    />
  ),
  number: ({ fieldKey, meta, value, onChange }) => (
    <input
      type="number"
      value={value ?? ''}
      onChange={e => onChange(Number(e.target.value))}
    />
  ),
  // ... other renderers
}

// Option 1: Provider pattern (recommended for design systems)
<SchemaFormProvider renderers={myRenderers}>
  <SchemaForm schema={UserSchema} value={user} onChange={setUser} />
</SchemaFormProvider>

// Option 2: Inline renderers
<SchemaForm
  schema={UserSchema}
  value={user}
  onChange={setUser}
  renderers={myRenderers}
/>
```

### With Hooks for Full Control

```tsx
import { useSchemaForm } from '@overeng/effect-schema-form'

const MyCustomForm = ({ schema, value, onChange }) => {
  const { fields, getValue, setValue, tagInfo } = useSchemaForm(schema, value, onChange)

  return (
    <form>
      {fields.map(field => (
        <div key={field.key}>
          <label>{field.meta.title ?? field.key}</label>
          <input
            value={getValue(field.key) ?? ''}
            onChange={e => setValue(field.key, e.target.value)}
          />
          {field.meta.description && <span>{field.meta.description}</span>}
        </div>
      ))}
    </form>
  )
}
```

### With Render Props

```tsx
<SchemaForm schema={UserSchema} value={user} onChange={setUser} renderers={myRenderers}>
  {({ fields, renderField, tagInfo }) => (
    <div className="custom-layout">
      {tagInfo.isTagged && <h2>{tagInfo.tagValue}</h2>}
      {fields.map(field => (
        <div key={field.key} className="field-wrapper">
          {renderField(field)}
        </div>
      ))}
    </div>
  )}
</SchemaForm>
```

## API

### Schema Introspection

```tsx
import { analyzeSchema, getStructProperties, analyzeTaggedStruct } from '@overeng/effect-schema-form'

// Analyze a single schema
const meta = analyzeSchema(Schema.String)
// { type: 'string', title: undefined, description: undefined, isOptional: false, ... }

// Get all properties from a struct
const props = getStructProperties(UserSchema)
// [{ key: 'name', schema: ..., meta: { type: 'string', ... } }, ...]

// Detect tagged structs (discriminated unions)
const tagInfo = analyzeTaggedStruct(TaggedSchema)
// { isTagged: true, tagValue: 'my-tag', contentProperties: [...] }
```

### Supported Field Types

| Type      | Schema Example                | Description              |
| --------- | ----------------------------- | ------------------------ |
| `string`  | `Schema.String`               | Text input               |
| `number`  | `Schema.Number`, `Schema.Int` | Number input             |
| `boolean` | `Schema.Boolean`              | Checkbox                 |
| `literal` | `Schema.Literal('a', 'b')`    | Select/segmented control |
| `struct`  | `Schema.Struct({...})`        | Nested form group        |
| `unknown` | Other types                   | Fallback renderer        |

### Types

```tsx
interface FieldRendererProps<T> {
  fieldKey: string
  meta: FieldMeta
  value: T
  onChange: (value: T) => void
}

interface FieldMeta {
  type: 'string' | 'number' | 'boolean' | 'literal' | 'struct' | 'unknown'
  title: string | undefined
  description: string | undefined
  literals: readonly string[] | undefined
  isOptional: boolean
  innerSchema: Schema.Schema.AnyNoContext
}

interface FieldRenderers {
  string?: FieldRenderer<string | undefined>
  number?: FieldRenderer<number | undefined>
  boolean?: FieldRenderer<boolean | undefined>
  literal?: FieldRenderer<string | undefined>
  struct?: FieldRenderer<Record<string, unknown>>
  unknown?: FieldRenderer<unknown>
}
```

## Utilities

```tsx
import { formatLiteralLabel } from '@overeng/effect-schema-form'

formatLiteralLabel('my-option')     // "My Option"
formatLiteralLabel('someValue')     // "Some Value"
formatLiteralLabel('snake_case')    // "Snake Case"
```
